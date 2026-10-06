import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Stateless, authenticated tokens. Everything the hosted server hands out (access tokens,
 * refresh tokens, dynamically registered client ids) is an AES-256-GCM blob sealed with a
 * key derived from MCP_TOKEN_SECRET, so the server keeps no database.
 *
 * Format: v1.<iv>.<ciphertext>.<tag>, every part base64url. The purpose is mixed into the
 * key (HKDF info) and also bound as AAD, so a token minted for one purpose can never be
 * opened as another.
 */
export type TokenPurpose = "access" | "refresh" | "client";

export const MIN_SECRET_LENGTH = 32;

const VERSION = "v1";
const HKDF_SALT = "clickup-mcp/token/v1";

export class TokenError extends Error {}

export function getTokenSecret(): string {
  const secret = process.env.MCP_TOKEN_SECRET?.trim();
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`MCP_TOKEN_SECRET must be set and at least ${MIN_SECRET_LENGTH} characters long.`);
  }
  return secret;
}

function deriveKey(secret: string, purpose: TokenPurpose): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, purpose, 32));
}

export function sealToken(
  purpose: TokenPurpose,
  payload: Record<string, unknown>,
  ttlSeconds: number,
  secret: string = getTokenSecret()
): string {
  const exp = Math.floor(Date.now() / 1000) + Math.floor(ttlSeconds);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret, purpose), iv);
  cipher.setAAD(Buffer.from(purpose));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ ...payload, exp }), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(".");
}

/** Opens a token. Throws TokenError when it is malformed, tampered with, of another purpose or expired. */
export function openToken<T extends Record<string, unknown> = Record<string, any>>(
  purpose: TokenPurpose,
  token: string,
  secret: string = getTokenSecret()
): T & { exp: number } {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new TokenError("malformed token");
  }
  let payload: any;
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const ciphertext = Buffer.from(parts[2], "base64url");
    const tag = Buffer.from(parts[3], "base64url");
    if (iv.length !== 12 || tag.length !== 16) {
      throw new TokenError("malformed token");
    }
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret, purpose), iv);
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    payload = JSON.parse(plain.toString("utf8"));
  } catch {
    throw new TokenError("invalid token");
  }
  if (!payload || typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new TokenError("token expired");
  }
  return payload;
}
