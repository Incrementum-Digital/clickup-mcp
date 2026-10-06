import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

/**
 * Per-request credentials for multi-user (HTTP) operation. In stdio mode no store is
 * active and CONFIG falls back to its module-level credentials.
 *
 * This file must not import config.ts: config.ts imports it.
 */
export interface RequestCredentials {
  token: string; // ClickUp access token for this user
  teamId: string;
  userKey: string; // stable per-user cache key, see userKeyForToken
  userId?: string;
  username?: string;
}

const storage = new AsyncLocalStorage<RequestCredentials>();

/** Stable cache key for a token: never the raw token itself. */
export function userKeyForToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

export function runWithCredentials<T>(creds: RequestCredentials, fn: () => T): T {
  return storage.run(creds, fn);
}

export function getRequestCredentials(): RequestCredentials | undefined {
  return storage.getStore();
}

/** Key that scopes per-user caches: the user's key inside a request context, "stdio" otherwise. */
export function credentialCacheKey(): string {
  return storage.getStore()?.userKey ?? "stdio";
}
