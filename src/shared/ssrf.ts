import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Guards for fetching user-supplied URLs from the hosted server, where an unchecked fetch
 * would reach Railway's private network, loopback services and the cloud metadata endpoint.
 *
 * Residual risk: the address is validated with a separate DNS lookup before fetch() does its
 * own, so a DNS-rebinding host could still flip between the two. Closing that needs a pinned
 * dispatcher; it is accepted here because the response must also be a valid image to be used.
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

/** Throws unless every address the URL's host resolves to is public. */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
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
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isForbiddenAddress)) {
    throw new Error(`${url.hostname} resolves to a private or internal address, which the hosted server does not fetch`);
  }
  return url;
}

export interface SafeFetchOptions {
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

/**
 * Fetches a public URL: validates every hop (redirects are followed manually, at most
 * maxRedirects times), enforces a timeout and stops reading once maxBytes is exceeded.
 */
export async function fetchPublicBytes(
  rawUrl: string,
  { maxBytes, timeoutMs = 15_000, maxRedirects = 3 }: SafeFetchOptions
): Promise<{ bytes: Buffer; url: URL; contentType: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const url = await assertPublicUrl(current);
      const response = await fetch(url.href, { redirect: "manual", signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new Error(`Could not download ${rawUrl}: redirect without a Location header`);
        current = new URL(location, url).href;
        continue;
      }
      if (!response.ok) {
        throw new Error(`Could not download ${rawUrl}: ${response.status} ${response.statusText}`);
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`${rawUrl} is larger than the allowed ${maxBytes} bytes`);
      }
      const chunks: Buffer[] = [];
      let total = 0;
      const reader = response.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new Error(`${rawUrl} is larger than the allowed ${maxBytes} bytes`);
          }
          chunks.push(Buffer.from(value));
        }
      }
      return { bytes: Buffer.concat(chunks), url, contentType: response.headers.get("content-type") };
    }
    throw new Error(`Could not download ${rawUrl}: too many redirects`);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Could not download ${rawUrl}: timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
