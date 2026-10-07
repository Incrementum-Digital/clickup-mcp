import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Buffer } from "node:buffer";

/**
 * Guards for fetching user-supplied URLs from the hosted server, where an unchecked fetch
 * would reach Railway's private network, loopback services and the cloud metadata endpoint.
 *
 * DNS rebinding is closed by pinning: the hostname is resolved once per hop, every resolved
 * address is validated, and the connection is then opened to that exact validated IP (the
 * hostname only travels in the Host header and TLS SNI/certificate check). The connection
 * never does a second lookup of its own.
 */

function parseIPv4(address: string): number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : undefined;
}

/** Expands an IPv6 address into 8 16-bit groups (handles "::" and a dotted IPv4 tail). */
function parseIPv6(address: string): number[] | undefined {
  let text = address.split("%")[0].toLowerCase();
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = parseIPv4(dotted[2]);
    if (!v4) return undefined;
    text = `${dotted[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || missing < (halves.length === 2 ? 1 : 0)) return undefined;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8) return undefined;
  const numbers = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return numbers.every((n) => !Number.isNaN(n)) ? numbers : undefined;
}

function isForbiddenIPv4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this" network, includes 0.0.0.0
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  );
}

/**
 * True when the address must not be fetched: loopback, private, link-local, unique-local,
 * unspecified, multicast/reserved, and the IPv4-mapped / NAT64 forms of those. Unparseable
 * input counts as forbidden.
 */
export function isForbiddenAddress(address: string): boolean {
  const kind = isIP(address.replace(/^\[|\]$/g, ""));
  const text = address.replace(/^\[|\]$/g, "");
  if (kind === 4) {
    const v4 = parseIPv4(text);
    return !v4 || isForbiddenIPv4(v4);
  }
  if (kind === 6) {
    const g = parseIPv6(text);
    if (!g) return true;
    if (g.every((x) => x === 0)) return true; // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
    // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d)
    const embedded = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
    const first5Zero = g.slice(0, 5).every((x) => x === 0);
    if ((first5Zero && (g[5] === 0xffff || g[5] === 0)) || (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))) {
      return isForbiddenIPv4(embedded);
    }
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g[0] & 0xff00) === 0xff00) return true; // multicast
    return false;
  }
  return true;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

const systemLookup: LookupFn = async (hostname) =>
  (await lookup(hostname, { all: true })).map((a) => ({ address: a.address, family: a.family }));

/** What the transport receives: connect to `address`, present `hostHeader`/`servername` as the origin. */
export interface TransportRequest {
  url: URL;
  /** The validated IP to connect to. The transport must not resolve the hostname itself. */
  address: string;
  family: 4 | 6;
  /** Value for the Host header (hostname, plus port when it is not the default). */
  hostHeader: string;
  /** TLS SNI and certificate name; undefined for http and for IP-literal hosts. */
  servername?: string;
  headers: Record<string, string>;
  /** Idle socket timeout in milliseconds. */
  timeoutMs: number;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  statusText?: string;
  /** Lower-case header names */
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  /** Stop the transfer and release the connection */
  destroy(): void;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

/** Real transport: node:http(s) request whose TCP connection goes to the pinned IP. */
export const nodeTransport: Transport = (req) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const secure = req.url.protocol === "https:";
    const port = req.url.port ? Number(req.url.port) : secure ? 443 : 80;
    let timedOut = false;
    const timeoutError = () => Object.assign(new Error("socket timeout"), { code: "ETIMEDOUT" });
    const request = (secure ? https : http).request(
      {
        host: req.address,
        port,
        family: req.family,
        method: "GET",
        path: `${req.url.pathname}${req.url.search}`,
        headers: { ...req.headers, Host: req.hostHeader },
        // https: SNI and certificate verification use the hostname, not the pinned IP
        ...(secure && req.servername ? { servername: req.servername } : {}),
        // no connection pooling: a pooled socket must never be reused for another hostname
        agent: false,
        signal: req.signal,
      },
      (res) => {
        const headers: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
        }
        async function* body() {
          try {
            for await (const chunk of res) yield chunk as Uint8Array;
          } catch (error) {
            throw timedOut ? timeoutError() : error;
          }
        }
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage,
          headers,
          body: body(),
          destroy: () => res.destroy(),
        });
      }
    );
    request.setTimeout(req.timeoutMs, () => {
      timedOut = true;
      request.destroy(timeoutError());
    });
    request.on("error", reject);
    request.end();
  });

let defaultLookup: LookupFn = systemLookup;
let defaultTransport: Transport = nodeTransport;

/**
 * Test seam: replace the DNS lookup and/or the transport used when a call does not pass its
 * own. Returns a function that restores the previous ones.
 */
export function setSafeFetchHooks(hooks: { lookup?: LookupFn; transport?: Transport }): () => void {
  const previous = { lookup: defaultLookup, transport: defaultTransport };
  if (hooks.lookup) defaultLookup = hooks.lookup;
  if (hooks.transport) defaultTransport = hooks.transport;
  return () => {
    defaultLookup = previous.lookup;
    defaultTransport = previous.transport;
  };
}

/**
 * Resolves the URL's host once and returns the address to connect to. Throws unless every
 * address the host resolves to is public; the first one is the pinned address.
 */
export async function resolvePublicTarget(
  rawUrl: string,
  lookupFn: LookupFn = defaultLookup
): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${rawUrl} is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${url.protocol} URLs are not allowed`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookupFn(host)).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isForbiddenAddress)) {
    throw new Error(`${url.hostname} resolves to a private or internal address, which the hosted server does not fetch`);
  }
  const address = addresses[0].replace(/^\[|\]$/g, "");
  return { url, address, family: isIP(address) === 6 ? 6 : 4 };
}

/** Throws unless every address the URL's host resolves to is public. */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  return (await resolvePublicTarget(rawUrl)).url;
}

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Replaces the DNS lookup (tests) */
  lookup?: LookupFn;
  /** Replaces the network transport (tests) */
  transport?: Transport;
}

/**
 * Fetches a public URL with the connection pinned to a validated address: every hop
 * (redirects are followed manually, at most maxRedirects times) is resolved, validated and
 * connected to that exact IP. Enforces a timeout and stops reading once maxBytes is exceeded.
 */
export async function fetchPublicBytes(
  rawUrl: string,
  { maxBytes, timeoutMs = 15_000, maxRedirects = 3, lookup: lookupFn, transport }: SafeFetchOptions
): Promise<{ bytes: Buffer; url: URL; contentType: string | null; contentDisposition: string | null }> {
  const send = transport ?? defaultTransport;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const { url, address, family } = await resolvePublicTarget(current, lookupFn);
      const response = await send({
        url,
        address,
        family,
        hostHeader: url.host,
        servername: isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : url.hostname,
        headers: { accept: "*/*", "accept-encoding": "identity", "user-agent": "clickup-mcp" },
        timeoutMs,
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers["location"];
        response.destroy();
        if (!location) throw new Error(`Could not download ${rawUrl}: redirect without a Location header`);
        current = new URL(location, url).href;
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        response.destroy();
        throw new Error(`Could not download ${rawUrl}: ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
      }
      const declared = Number(response.headers["content-length"]);
      if (response.headers["content-length"] !== undefined && Number.isFinite(declared) && declared > maxBytes) {
        response.destroy();
        throw new Error(`${rawUrl} is larger than the allowed ${maxBytes} bytes`);
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const value of response.body) {
        total += value.byteLength;
        if (total > maxBytes) {
          response.destroy();
          throw new Error(`${rawUrl} is larger than the allowed ${maxBytes} bytes`);
        }
        chunks.push(Buffer.from(value));
      }
      return {
        bytes: Buffer.concat(chunks),
        url,
        contentType: response.headers["content-type"] ?? null,
        contentDisposition: response.headers["content-disposition"] ?? null,
      };
    }
    throw new Error(`Could not download ${rawUrl}: too many redirects`);
  } catch (error) {
    if (controller.signal.aborted || (error as { code?: string })?.code === "ETIMEDOUT") {
      throw new Error(`Could not download ${rawUrl}: timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
