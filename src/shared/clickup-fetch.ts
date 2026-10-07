import { credentialCacheKey } from "./request-context";

/**
 * fetch() for api.clickup.com with per-user burst protection.
 *
 * ClickUp allows 100 requests/minute per token. A single tool call can cost 4 to 6
 * requests, so an agent firing a couple dozen tool calls in parallel blows the budget
 * and every request after that gets `429 {"err":"Rate limit reached","ECODE":"APP_002"}`.
 * This wrapper
 *  - caps in-flight requests per user (CLICKUP_MAX_CONCURRENT_REQUESTS, default 6), extra
 *    calls queue FIFO,
 *  - answers a 429 by waiting for Retry-After / X-RateLimit-Reset (bounded by
 *    CLICKUP_RATE_LIMIT_MAX_WAIT_SECONDS, default 20) and retrying (max 2 retries) while
 *    still holding the user's slot, otherwise throws ClickUpRateLimitError,
 *  - pauses all new requests of that user until the reset, so queued calls do not each
 *    run into their own 429.
 * All other responses are passed through unchanged; callers keep their own `ok` checks.
 */

const DEFAULT_MAX_CONCURRENT = 6;
const DEFAULT_MAX_WAIT_SECONDS = 20;
const DEFAULT_RETRY_WAIT_SECONDS = 5;
const MAX_RETRIES = 2;
const JITTER_MS = 250;
const DEFAULT_LIMIT = 100;

export class ClickUpRateLimitError extends Error {
  readonly retryAfterSeconds: number;
  readonly limit?: number;
  readonly remaining?: number;

  constructor(retryAfterSeconds: number, limit?: number, remaining?: number) {
    super(
      `ClickUp rate limit reached for this user (${limit ?? DEFAULT_LIMIT} requests/minute). ` +
        `Retry after ${retryAfterSeconds}s. Reduce parallel tool calls.`
    );
    this.name = "ClickUpRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
    this.limit = limit;
    this.remaining = remaining;
  }
}

interface UserState {
  inFlight: number;
  queue: Array<() => void>;
  pausedUntil: number; // epoch ms; 0 when not paused
  limit?: number;
  remaining?: number;
}

const users = new Map<string, UserState>();

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const maxConcurrent = () => positiveIntFromEnv("CLICKUP_MAX_CONCURRENT_REQUESTS", DEFAULT_MAX_CONCURRENT);
const maxWaitMs = () => positiveIntFromEnv("CLICKUP_RATE_LIMIT_MAX_WAIT_SECONDS", DEFAULT_MAX_WAIT_SECONDS) * 1000;

function isIdle(state: UserState, now: number): boolean {
  return state.inFlight === 0 && state.queue.length === 0 && state.pausedUntil <= now;
}

function getState(key: string): UserState {
  let state = users.get(key);
  if (!state) {
    // Keep the map bounded: drop idle users whose pause has expired before adding another.
    const now = Date.now();
    for (const [otherKey, other] of users) {
      if (isIdle(other, now)) users.delete(otherKey);
    }
    state = { inFlight: 0, queue: [], pausedUntil: 0 };
    users.set(key, state);
  }
  return state;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("The operation was aborted");
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function acquire(state: UserState, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  if (state.inFlight < maxConcurrent()) {
    state.inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve(); // the slot was handed over: inFlight stays as it is
    };
    const onAbort = () => {
      const index = state.queue.indexOf(waiter);
      if (index >= 0) state.queue.splice(index, 1);
      reject(abortReason(signal!));
    };
    state.queue.push(waiter);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function release(key: string, state: UserState): void {
  const next = state.queue.shift();
  if (next) {
    next();
    return;
  }
  state.inFlight--;
  if (isIdle(state, Date.now()) && users.get(key) === state) users.delete(key);
}

function numberHeader(response: Response, name: string): number | undefined {
  const raw = response.headers.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Seconds to wait according to the 429's headers; Retry-After first, then X-RateLimit-Reset. */
function waitSecondsFrom(response: Response, now: number): number {
  const retryAfter = response.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(1, seconds);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(1, (date - now) / 1000);
  }
  const reset = numberHeader(response, "x-ratelimit-reset");
  if (reset !== undefined) {
    const resetMs = reset > 1e12 ? reset : reset * 1000; // tolerate epoch milliseconds
    return Math.max(1, (resetMs - now) / 1000);
  }
  return DEFAULT_RETRY_WAIT_SECONDS;
}

function pathOf(input: string | URL): string {
  try {
    return new URL(String(input)).pathname;
  } catch {
    return "unknown";
  }
}

async function drain(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // body already gone or connection reset: nothing to free
  }
}

/** Wait out the user's pause; fail fast instead when the pause is longer than we are willing to wait. */
async function waitForPause(state: UserState, signal?: AbortSignal | null): Promise<void> {
  for (;;) {
    const remainingMs = state.pausedUntil - Date.now();
    if (remainingMs <= 0) return;
    if (remainingMs > maxWaitMs()) {
      throw new ClickUpRateLimitError(Math.ceil(remainingMs / 1000), state.limit, state.remaining);
    }
    // Independent jitter per waiter spreads out the calls queued behind the same pause.
    await sleep(remainingMs + Math.floor(Math.random() * JITTER_MS), signal);
  }
}

export async function clickupFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const key = credentialCacheKey();
  const state = getState(key);
  const signal = init?.signal;

  await acquire(state, signal);
  try {
    for (let attempt = 0; ; attempt++) {
      await waitForPause(state, signal);
      const response = await fetch(input, init);
      if (response.status !== 429) return response;

      const now = Date.now();
      const waitSeconds = waitSecondsFrom(response, now);
      state.limit = numberHeader(response, "x-ratelimit-limit") ?? state.limit;
      state.remaining = numberHeader(response, "x-ratelimit-remaining") ?? state.remaining;
      state.pausedUntil = Math.max(state.pausedUntil, now + waitSeconds * 1000);
      await drain(response);

      console.error(`rate limit: user=${key.slice(0, 8)} wait=${Math.ceil(waitSeconds)}s path=${pathOf(input)}`);

      if (waitSeconds * 1000 > maxWaitMs() || attempt >= MAX_RETRIES) {
        throw new ClickUpRateLimitError(Math.ceil(waitSeconds), state.limit, state.remaining);
      }
      // The next loop iteration sleeps until pausedUntil (still holding this user's slot).
    }
  } finally {
    release(key, state);
  }
}

/** Test helper: forget all per-user limiter state. */
export function __resetClickUpFetchState(): void {
  users.clear();
}

/** Test helper: number of users the limiter currently tracks (idle users are dropped). */
export function __clickUpFetchStateSize(): number {
  return users.size;
}
