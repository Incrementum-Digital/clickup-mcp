import { LookupFn, setSafeFetchHooks, Transport, TransportRequest } from "../shared/ssrf";

/**
 * Test double for the hosted public-URL download path. fetchPublicBytes no longer goes through
 * fetch() (it connects to a pinned IP via node:http), so MockAgent cannot see those requests;
 * this replaces the transport instead. MockAgent still covers the ClickUp API calls.
 *
 * Routes are keyed by the full request URL. Anything else throws, like a disabled network.
 */
export interface FakeResponse {
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
}
export type FakeRoute = FakeResponse | ((request: TransportRequest) => FakeResponse);

const restoreStack: (() => void)[] = [];

export function installFakeWeb(routes: Record<string, FakeRoute>, options: { lookup?: LookupFn } = {}) {
  const calls: TransportRequest[] = [];
  const transport: Transport = async (request) => {
    calls.push(request);
    const route = routes[request.url.href];
    if (!route) throw new Error(`fake web: unexpected request to ${request.url.href}`);
    const response = typeof route === "function" ? route(request) : route;
    const body = Buffer.from(response.body ?? "");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(response.headers ?? {})) headers[name.toLowerCase()] = value;
    async function* chunks() {
      // small chunks so the streaming byte cap is exercised
      for (let offset = 0; offset < body.length; offset += 65536) yield body.subarray(offset, offset + 65536);
    }
    return {
      status: response.status ?? 200,
      statusText: response.statusText,
      headers,
      body: chunks(),
      destroy: () => undefined,
    };
  };
  restoreStack.push(setSafeFetchHooks({ transport, lookup: options.lookup }));
  return { calls };
}

/** Undo every installFakeWeb call (call from afterEach) */
export function restoreFakeWeb(): void {
  while (restoreStack.length) restoreStack.pop()!();
}
