import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { exchangeClickUpCode } from "../shared/auth";
import { formatAuthHeader } from "../shared/config";
import { userKeyForToken } from "../shared/request-context";
import { openToken, sealToken } from "./crypto";

/**
 * OAuth 2.1 authorization server for the hosted MCP endpoint. "Logging in" means logging in
 * to ClickUp: /authorize bounces the user to ClickUp, the ClickUp callback turns the ClickUp
 * token into one of our own authorization codes, and /token wraps the ClickUp token into
 * our own access and refresh tokens.
 *
 * There is no database. Access tokens, refresh tokens and registered client ids are
 * AES-GCM blobs (see crypto.ts); only the short-lived pending authorizations and
 * authorization codes live in memory (single replica by design, a restart merely aborts
 * logins that are in flight).
 *
 * Consequences of the stateless design:
 * - Rotating MCP_TOKEN_SECRET logs everybody out: every token and every client id becomes
 *   unreadable, so clients have to register and authorize again.
 * - Refresh tokens rotate and a used one is rejected, but the list of used refresh token ids
 *   is in memory only: after a restart an already-used refresh token can be replayed until it
 *   expires. That is the accepted residual of the single-replica, stateless design.
 * - Our own tokens cannot be revoked before they expire. Revoking the app inside ClickUp
 *   does invalidate the ClickUp token wrapped inside, so every API call then fails.
 */

export const CLICKUP_SCOPE = "clickup";
export const CALLBACK_PATH = "/oauth/clickup/callback";
export const CONSENT_PATH = "/authorize/consent";

const SAME_BROWSER_MESSAGE =
  "This login must be completed in the same browser that started it. Go back to your MCP client and connect again.";
const BROWSER_BINDING_COOKIE = "clickup_mcp_auth";
const CLICKUP_AUTHORIZE_URL = "https://app.clickup.com/api";
const CLICKUP_API = "https://api.clickup.com/api/v2";
const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const MAX_IN_FLIGHT = 10_000;
// Client ids are sealed blobs, so they need to outlive any realistic client install.
const CLIENT_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;

export interface ProviderOptions {
  publicUrl: URL;
  tokenSecret: string;
  clickupClientId: string;
  clickupClientSecret: string;
  /** When set, only users who authorized this ClickUp workspace may connect. */
  teamId?: string;
  /** Extra native-app redirect schemes (e.g. "cursor", "vscode"), see assertAllowedRedirectUri. */
  allowedRedirectSchemes?: string[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
}

interface PendingAuthorization {
  clientId: string;
  clientName?: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
  /** SHA-256 of the secret that was set as a cookie in the browser that started the login. */
  browserHash: Buffer;
  /** Set once the user pressed "Continue to ClickUp" on the consent page; the callback requires it. */
  consented: boolean;
  expiresAt: number;
}

interface IssuedCode {
  clickupToken: string;
  userId: string;
  username: string;
  teamId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface TokenClaims {
  clickupToken: string;
  userId: string;
  username: string;
  teamId: string;
  clientId: string;
  scopes: string[];
}

/** Schemes that can run script or read local data when navigated to: never allowed, even if listed. */
const NEVER_ALLOWED_SCHEMES = new Set(["javascript", "data", "vbscript", "file", "blob", "about", "http", "https"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isValidRedirectScheme(scheme: string): boolean {
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) && !NEVER_ALLOWED_SCHEMES.has(scheme);
}

/**
 * Returns why a redirect_uri is not acceptable, or undefined when it is. The SDK registers
 * anything URL.canParse accepts, including `javascript:`, which would turn the Cancel and
 * "Return to client" links on our pages into script on our own origin. Policy:
 * - https: any host
 * - http: only loopback (localhost, 127.0.0.1, [::1]), e.g. Claude Code's local callback
 * - other schemes only when listed in allowedSchemes (MCP_ALLOWED_REDIRECT_SCHEMES) and never
 *   the script/data schemes in NEVER_ALLOWED_SCHEMES
 */
export function redirectUriProblem(uri: string, allowedSchemes: string[] = []): string | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return "redirect_uri is not a valid URL";
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme === "https") return undefined;
  if (scheme === "http") {
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
      ? undefined
      : "redirect_uri must use https (http is only allowed for localhost, 127.0.0.1 and [::1])";
  }
  if (isValidRedirectScheme(scheme) && allowedSchemes.map((x) => x.toLowerCase()).includes(scheme)) return undefined;
  return `redirect_uri scheme "${scheme}:" is not allowed`;
}

export function isAllowedRedirectUri(uri: string, allowedSchemes: string[] = []): boolean {
  return redirectUriProblem(uri, allowedSchemes) === undefined;
}

/** Throws InvalidRequestError (an OAuth error the SDK maps to a 400) unless the redirect_uri is allowed. */
export function assertAllowedRedirectUri(uri: string, allowedSchemes: string[] = []): void {
  const problem = redirectUriProblem(uri, allowedSchemes);
  if (problem) throw new InvalidRequestError(problem);
}

const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://app.clickup.com; frame-ancestors 'none'";

function pageHeaders(): Record<string, string> {
  return { "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": PAGE_CSP };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function sendPage(
  res: Response,
  status: number,
  title: string,
  message: string,
  returnLink?: { href: string; label: string }
): void {
  res
    .status(status)
    .type("html")
    .set(pageHeaders())
    .send(
      pageShell(
        title,
        `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>` +
          (returnLink
            ? `<p><a class="button" href="${escapeHtml(returnLink.href)}">${escapeHtml(returnLink.label)}</a></p>`
            : "")
      )
    );
}

function pageShell(title: string, body: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}` +
    `.button{display:inline-block;padding:.6rem 1rem;border:1px solid #888;border-radius:.4rem;background:#f4f4f4;color:#000;text-decoration:none;font:inherit;cursor:pointer}` +
    `.primary{background:#2b50e6;border-color:#2b50e6;color:#fff}code{word-break:break-all}</style></head><body>${body}</body></html>`
  );
}

function clientLinkParams(pending: PendingAuthorization, error: string, description: string) {
  return { error, error_description: description, state: pending.state };
}

function clientUrl(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.href;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

function redirectToClient(res: Response, redirectUri: string, params: Record<string, string | undefined>): void {
  res.set("Cache-Control", "no-store").redirect(302, clientUrl(redirectUri, params));
}

export class ClickUpOAuthProvider implements OAuthServerProvider {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, IssuedCode>();
  /** jti -> exp (seconds) of refresh tokens that were already exchanged. */
  private readonly usedRefreshTokens = new Map<string, number>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly options: ProviderOptions) {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  shutdown(): void {
    clearInterval(this.sweeper);
  }

  private sweep(now = Date.now()): void {
    for (const [key, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(key);
    for (const [key, entry] of this.codes) if (entry.expiresAt <= now) this.codes.delete(key);
    for (const [jti, exp] of this.usedRefreshTokens) if (exp * 1000 <= now) this.usedRefreshTokens.delete(jti);
  }

  /** Stateless: the client id *is* the sealed registration, so nothing is stored. */
  readonly clientsStore: OAuthRegisteredClientsStore = {
    registerClient: (client) => {
      for (const uri of client.redirect_uris ?? []) {
        const problem = redirectUriProblem(String(uri), this.options.allowedRedirectSchemes);
        if (problem) throw new InvalidClientMetadataError(problem);
      }
      const { client_id: _generatedId, ...rest } = client;
      // The SDK's authorize handler rejects any scope the client did not register with, and
      // MCP clients commonly request the scopes advertised in our metadata without
      // registering them. Always allow our scope in addition to what they asked for.
      const scopes = new Set((client.scope ?? "").split(" ").filter(Boolean));
      scopes.add(CLICKUP_SCOPE);
      const registered: Record<string, unknown> = { ...rest, scope: [...scopes].join(" ") };
      if (registered.client_secret) {
        // The SDK's default 30 day secret expiry would silently lock confidential clients
        // out, and we cannot re-issue anything without state. 0 means "never expires".
        registered.client_secret_expires_at = 0;
      }
      return {
        ...(registered as unknown as OAuthClientInformationFull),
        client_id: sealToken("client", registered, CLIENT_TTL_SECONDS, this.options.tokenSecret),
      };
    },
    getClient: (clientId) => {
      try {
        const { exp: _exp, ...client } = openToken<Record<string, any>>("client", clientId, this.options.tokenSecret);
        return { ...client, client_id: clientId } as unknown as OAuthClientInformationFull;
      } catch {
        return undefined;
      }
    },
  };

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // Unknown scopes are dropped rather than refused (granting less than requested is allowed
    // by OAuth 2.1 and keeps hosts that ask for extras on first connect working): the grant is
    // always exactly "clickup", and the token response says so in its `scope`.
    assertAllowedRedirectUri(params.redirectUri, this.options.allowedRedirectSchemes);
    this.sweep();
    if (this.pending.size >= MAX_IN_FLIGHT) {
      throw new ServerError("Too many authorizations in flight, try again later");
    }
    const nonce = randomBytes(32).toString("hex");
    // The ClickUp state alone is not enough: an attacker could start a login with their own
    // client and hand the resulting URL to a victim, so that the victim's code lands on the
    // attacker's redirect_uri. Two defences work together:
    // - a cookie binds the pending login to the browser that started it, and
    // - a consent page shows where the result will be sent before anything goes to ClickUp,
    //   because the victim's own browser may well be the one that started the login.
    const browserSecret = randomBytes(32).toString("hex");
    const pending: PendingAuthorization = {
      clientId: client.client_id,
      clientName: client.client_name,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: [CLICKUP_SCOPE],
      resource: params.resource?.href,
      browserHash: sha256(browserSecret),
      consented: false,
      expiresAt: Date.now() + PENDING_TTL_MS,
    };
    this.pending.set(nonce, pending);

    const redirect = new URL(params.redirectUri);
    const destination = redirect.origin !== "null" ? redirect.origin : `${redirect.protocol}//${redirect.host}${redirect.pathname}`;
    const clientLabel = client.client_name ?? "an MCP client";
    const cancel = this.returnLink(pending, "access_denied", "The user cancelled the connection")?.href;
    res
      .status(200)
      .type("html")
      .set(pageHeaders())
      .append("Set-Cookie", this.cookieHeader(browserSecret, PENDING_TTL_MS / 1000))
      .send(
        pageShell(
          "Connect ClickUp",
          `<h1>Connect ClickUp to ${escapeHtml(clientLabel)}</h1>` +
            `<p>${escapeHtml(clientLabel)} is asking for access to your ClickUp account (scope: <code>${CLICKUP_SCOPE}</code>).</p>` +
            `<p>After you sign in with ClickUp, access will be handed to: <code>${escapeHtml(destination)}</code></p>` +
            `<p>Only continue if you started this connection yourself and you trust that address.</p>` +
            `<form method="post" action="${CONSENT_PATH}" style="display:inline">` +
            `<input type="hidden" name="nonce" value="${escapeHtml(nonce)}">` +
            `<button class="button primary" type="submit">Continue to ClickUp</button></form> ` +
            (cancel ? `<a class="button" href="${escapeHtml(cancel)}">Cancel</a>` : "")
        )
      );
  }

  /** POST /authorize/consent: the user pressed "Continue to ClickUp". Needs express.urlencoded() in front. */
  readonly handleConsent = async (req: Request, res: Response): Promise<void> => {
    const nonce = typeof req.body?.nonce === "string" ? req.body.nonce : undefined;
    const pending = nonce ? this.pending.get(nonce) : undefined;
    if (!nonce || !pending || pending.expiresAt <= Date.now()) {
      if (nonce) this.pending.delete(nonce);
      return sendPage(
        res,
        400,
        "Authorization expired",
        "This login is unknown, expired or was already used. Go back to your MCP client and connect again."
      );
    }
    if (!this.browserMatches(req, pending)) {
      this.pending.delete(nonce);
      return sendPage(res, 400, "Login must be completed in the same browser", SAME_BROWSER_MESSAGE);
    }
    if (pending.consented) {
      // Not deleted: the first press is still on its way to ClickUp.
      return sendPage(res, 400, "Already continued", "This login was already sent to ClickUp. Finish it there.");
    }
    pending.consented = true;
    const url = new URL(CLICKUP_AUTHORIZE_URL);
    url.searchParams.set("client_id", this.options.clickupClientId);
    url.searchParams.set("redirect_uri", this.callbackUrl);
    url.searchParams.set("state", nonce);
    res.set("Cache-Control", "no-store").redirect(302, url.href);
  };

  /** Link back to the client with an OAuth error; none at all if its redirect_uri fails the policy. */
  private returnLink(pending: PendingAuthorization, error: string, description: string) {
    if (!isAllowedRedirectUri(pending.redirectUri, this.options.allowedRedirectSchemes)) return undefined;
    return {
      href: clientUrl(pending.redirectUri, clientLinkParams(pending, error, description)),
      label: `Return to ${pending.clientName ?? "your MCP client"}`,
    };
  }

  private browserMatches(req: Request, pending: PendingAuthorization): boolean {
    const cookie = readCookie(req, this.cookieName);
    return cookie !== undefined && timingSafeEqual(sha256(cookie), pending.browserHash);
  }

  /** __Host- needs Secure, so it is only usable on https; plain http (local dev/tests) gets the bare name. */
  private get cookieName(): string {
    return this.options.publicUrl.protocol === "https:" ? `__Host-${BROWSER_BINDING_COOKIE}` : BROWSER_BINDING_COOKIE;
  }

  /** Same attributes for setting and clearing, so a clear actually matches the cookie. */
  private cookieHeader(value: string, maxAgeSeconds: number): string {
    const secure = this.options.publicUrl.protocol === "https:" ? "; Secure" : "";
    return `${this.cookieName}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Lax${secure}`;
  }

  get callbackUrl(): string {
    return new URL(CALLBACK_PATH, this.options.publicUrl).href;
  }

  /** GET /oauth/clickup/callback: ClickUp sends the user back here after (not) authorizing. */
  readonly handleClickUpCallback = async (req: Request, res: Response): Promise<void> => {
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const pending = state ? this.pending.get(state) : undefined;
    if (!state || !pending || pending.expiresAt <= Date.now()) {
      if (state) this.pending.delete(state);
      return sendPage(
        res,
        400,
        "Authorization expired",
        "This login link is unknown, expired or was already used. Go back to your MCP client and connect again."
      );
    }
    this.pending.delete(state); // single use
    if (!isAllowedRedirectUri(pending.redirectUri, this.options.allowedRedirectSchemes)) {
      return sendPage(res, 400, "Authorization failed", "The client's redirect address is not allowed. Go back to your MCP client and connect again.");
    }

    // Whatever happens next, the binding cookie has done its job.
    res.append("Set-Cookie", this.cookieHeader("", 0));
    if (!this.browserMatches(req, pending)) {
      return sendPage(res, 400, "Login must be completed in the same browser", SAME_BROWSER_MESSAGE);
    }
    if (!pending.consented) {
      return sendPage(
        res,
        400,
        "Authorization not confirmed",
        "This login was not confirmed on the consent page. Go back to your MCP client and connect again."
      );
    }

    if (req.query.error !== undefined) {
      return redirectToClient(res, pending.redirectUri, {
        error: "access_denied",
        error_description: "Authorization with ClickUp was denied",
        state: pending.state,
      });
    }
    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    if (!code) {
      return redirectToClient(res, pending.redirectUri, {
        error: "access_denied",
        error_description: "ClickUp did not return an authorization code",
        state: pending.state,
      });
    }

    let clickupToken: string;
    let user: { id: string; username: string };
    let teams: { id: string; name?: string }[];
    try {
      clickupToken = await exchangeClickUpCode(
        fetch,
        this.options.clickupClientId,
        this.options.clickupClientSecret,
        code
      );
      const headers = { Authorization: formatAuthHeader(clickupToken) };
      const [userResponse, teamResponse] = await Promise.all([
        fetch(`${CLICKUP_API}/user`, { headers }),
        fetch(`${CLICKUP_API}/team`, { headers }),
      ]);
      if (!userResponse.ok) throw new Error(`GET /user failed: ${userResponse.status}`);
      if (!teamResponse.ok) throw new Error(`GET /team failed: ${teamResponse.status}`);
      const userBody: any = await userResponse.json();
      const teamBody: any = await teamResponse.json();
      user = { id: String(userBody.user.id), username: String(userBody.user.username) };
      teams = (teamBody.teams ?? []).map((t: any) => ({ id: String(t.id), name: t.name }));
    } catch (error) {
      console.error(`ClickUp login failed: ${error instanceof Error ? error.message : String(error)}`);
      return sendPage(
        res,
        502,
        "ClickUp login failed",
        "Could not complete the login with ClickUp. Go back to your MCP client and try connecting again.",
        this.returnLink(pending, "server_error", "Could not complete the login with ClickUp")
      );
    }

    let teamId: string;
    const gate = this.options.teamId;
    if (gate) {
      if (!teams.some((t) => t.id === gate)) {
        return sendPage(
          res,
          403,
          "Wrong ClickUp workspace",
          `You did not authorize the required ClickUp workspace (team_id: ${gate}). Connect again and, on the ClickUp authorization screen, select that workspace.`,
          this.returnLink(pending, "access_denied", "The required ClickUp workspace was not authorized")
        );
      }
      teamId = gate;
    } else if (teams.length === 1) {
      teamId = teams[0].id;
    } else {
      return sendPage(
        res,
        400,
        "Workspace not configured",
        teams.length === 0
          ? "Your ClickUp account did not authorize any workspace. Connect again and select a workspace on the ClickUp authorization screen."
          : "Your ClickUp account has several workspaces, so the server administrator needs to set CLICKUP_TEAM_ID to pick one.",
        teams.length === 0
          ? this.returnLink(pending, "access_denied", "No ClickUp workspace was authorized")
          : this.returnLink(pending, "server_error", "The server needs CLICKUP_TEAM_ID to pick a workspace")
      );
    }

    const authCode = randomBytes(32).toString("hex");
    this.codes.set(authCode, {
      clickupToken,
      userId: user.id,
      username: user.username,
      teamId,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scopes: pending.scopes,
      resource: pending.resource,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    console.error(
      `authorized ${user.username} (user_id: ${user.id}) team_id=${teamId} client=${pending.clientName ?? pending.clientId.slice(0, 12)}`
    );
    redirectToClient(res, pending.redirectUri, { code: authCode, state: pending.state });
  };

  private findCode(client: OAuthClientInformationFull, authorizationCode: string): IssuedCode {
    const entry = this.codes.get(authorizationCode);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.codes.delete(authorizationCode);
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (entry.clientId !== client.client_id) {
      throw new InvalidGrantError("Authorization code was not issued to this client");
    }
    return entry;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.findCode(client, authorizationCode).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string
  ): Promise<OAuthTokens> {
    const entry = this.findCode(client, authorizationCode);
    this.codes.delete(authorizationCode); // single use, even if the redirect_uri check below fails
    if (redirectUri !== undefined && redirectUri !== entry.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    return this.mintTokens({
      clickupToken: entry.clickupToken,
      userId: entry.userId,
      username: entry.username,
      teamId: entry.teamId,
      clientId: entry.clientId,
      scopes: entry.scopes,
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[]
  ): Promise<OAuthTokens> {
    let claims: TokenClaims & { jti?: string; exp: number };
    try {
      claims = openToken<Record<string, any>>("refresh", refreshToken, this.options.tokenSecret) as unknown as TokenClaims & {
        jti?: string;
        exp: number;
      };
    } catch {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    if (claims.clientId !== client.client_id) {
      throw new InvalidGrantError("Refresh token was not issued to this client");
    }
    // Rotation: every refresh token works once. Checking and recording happen without an
    // await in between, so two concurrent exchanges of the same token cannot both pass.
    if (!claims.jti || this.usedRefreshTokens.has(claims.jti)) {
      throw new InvalidGrantError("Refresh token was already used");
    }
    // A scope parameter can only ask for the same or less, and the only scope is "clickup":
    // like at /authorize it is ignored, the grant stays what it was.
    const { jti, exp, ...rest } = claims as TokenClaims & { jti: string; exp: number };
    const tokens = this.mintTokens({ ...rest, scopes: [CLICKUP_SCOPE] });
    this.usedRefreshTokens.set(jti, exp);
    return tokens;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let claims: TokenClaims & { exp: number };
    try {
      claims = openToken<Record<string, any>>("access", token, this.options.tokenSecret) as unknown as TokenClaims & {
        exp: number;
      };
    } catch {
      throw new InvalidTokenError("Invalid or expired access token");
    }
    return {
      token,
      clientId: claims.clientId,
      scopes: claims.scopes,
      expiresAt: claims.exp,
      extra: {
        clickupToken: claims.clickupToken,
        userId: claims.userId,
        username: claims.username,
        teamId: claims.teamId,
        userKey: userKeyForToken(claims.clickupToken),
      },
    };
  }

  private mintTokens(claims: TokenClaims): OAuthTokens {
    const { tokenSecret, accessTokenTtlSeconds, refreshTokenTtlSeconds } = this.options;
    return {
      access_token: sealToken("access", { ...claims }, accessTokenTtlSeconds, tokenSecret),
      token_type: "Bearer",
      expires_in: accessTokenTtlSeconds,
      refresh_token: sealToken(
        "refresh",
        { ...claims, jti: randomBytes(16).toString("hex") },
        refreshTokenTtlSeconds,
        tokenSecret
      ),
      scope: claims.scopes.join(" "),
    };
  }
}
