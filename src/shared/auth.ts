import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { formatAuthHeader, readOptionalEnv, setCredentials } from "./config";

export { formatAuthHeader };

const API_BASE = "https://api.clickup.com/api/v2";
const AUTHORIZE_URL = "https://app.clickup.com/api";
const DEFAULT_OAUTH_PORT = 8787;
const DEFAULT_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

export interface StoredToken {
  client_id: string;
  access_token: string;
  created_at: string;
}

export interface OAuthFlowOptions {
  port?: number;
  openBrowser?: (url: string) => void | Promise<void>;
  timeoutMs?: number;
  tokenFile?: string;
  clientId?: string;
  clientSecret?: string;
  fetch?: typeof fetch;
}

export function getTokenFilePath(): string {
  return (
    readOptionalEnv("CLICKUP_TOKEN_FILE") ??
    path.join(os.homedir(), ".config", "clickup-mcp", "token.json")
  );
}

export function getOAuthClientCredentials(): { clientId?: string; clientSecret?: string } {
  return {
    clientId: readOptionalEnv("CLICKUP_CLIENT_ID"),
    clientSecret: readOptionalEnv("CLICKUP_CLIENT_SECRET"),
  };
}

function getOAuthPort(): number {
  const raw = readOptionalEnv("CLICKUP_OAUTH_PORT");
  if (raw === undefined) return DEFAULT_OAUTH_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid CLICKUP_OAUTH_PORT "${raw}". Expected a port number between 1 and 65535.`);
  }
  return port;
}

/**
 * Reads the stored OAuth token. A missing, unreadable or malformed file counts as
 * "no stored token" so the caller can fall through to the next credential source.
 */
export function readStoredToken(tokenFile: string = getTokenFilePath()): StoredToken | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(tokenFile, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      console.error(`Could not read token file ${tokenFile}: ${error?.message ?? error}`);
    }
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.access_token !== "string" || !parsed.access_token) {
      throw new Error("missing access_token");
    }
    return {
      client_id: typeof parsed.client_id === "string" ? parsed.client_id : "",
      access_token: parsed.access_token,
      created_at: typeof parsed.created_at === "string" ? parsed.created_at : "",
    };
  } catch (error: any) {
    console.error(`Ignoring invalid token file ${tokenFile}: ${error?.message ?? error}`);
    return undefined;
  }
}

function writeStoredToken(tokenFile: string, token: StoredToken): void {
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenFile, JSON.stringify(token, null, 2) + "\n", { mode: 0o600 });
  // `mode` only applies when the file is created; tighten a pre-existing file too.
  fs.chmodSync(tokenFile, 0o600);
}

/** Deletes the token file. Returns whether anything was removed. */
export function logout(tokenFile: string = getTokenFilePath()): boolean {
  try {
    fs.unlinkSync(tokenFile);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function defaultOpenBrowser(url: string): void {
  try {
    let child;
    if (process.platform === "darwin") {
      child = spawn("open", [url], { detached: true, stdio: "ignore" });
    } else if (process.platform === "win32") {
      // `&` is a command separator for cmd, so it has to be escaped in the verbatim argument.
      child = spawn("cmd", ["/c", "start", '""', url.replace(/&/g, "^&")], {
        detached: true,
        stdio: "ignore",
        windowsVerbatimArguments: true,
      });
    } else {
      child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    }
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is printed to stderr, the user can open it manually.
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function htmlPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>ClickUp MCP</title></head><body><p>${escapeHtml(message)}</p></body></html>`;
}

function statesMatch(expected: string, actual: string | null): boolean {
  if (actual === null) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Exchanges an authorization code for a ClickUp access token (ClickUp tokens never expire).
 *
 * The secret goes into a JSON body, not the URL, so it stays out of proxy and access logs.
 * ClickUp's docs are inconsistent about the accepted form, so on a 4xx the request is
 * retried as a urlencoded body and, as a last resort, with the params in the query string
 * (the older documented form; that one logs a warning because it leaks the secret into URLs).
 */
export async function exchangeClickUpCode(
  fetchFn: typeof fetch,
  clientId: string,
  clientSecret: string,
  code: string
): Promise<string> {
  const fields = { client_id: clientId, client_secret: clientSecret, code };
  const attempts: { name: string; url: string; init: RequestInit }[] = [
    {
      name: "json",
      url: `${API_BASE}/oauth/token`,
      init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) },
    },
    {
      name: "form",
      url: `${API_BASE}/oauth/token`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      },
    },
    {
      name: "query",
      url: `${API_BASE}/oauth/token?${new URLSearchParams(fields).toString()}`,
      init: { method: "POST" },
    },
  ];

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    const response = await fetchFn(attempt.url, attempt.init);
    const bodyText = await response.text();
    if (!response.ok) {
      const retryable = response.status >= 400 && response.status < 500 && i < attempts.length - 1;
      if (retryable) continue;
      throw new Error(`ClickUp token exchange failed: ${response.status} ${bodyText}`);
    }
    let accessToken: unknown;
    try {
      accessToken = JSON.parse(bodyText)?.access_token;
    } catch {
      // handled below
    }
    if (typeof accessToken !== "string" || !accessToken) {
      throw new Error(`ClickUp token exchange returned no access_token: ${bodyText}`);
    }
    if (attempt.name === "query") {
      console.error("Warning: ClickUp only accepted the token exchange with the credentials in the query string.");
    }
    return accessToken;
  }
  throw new Error("ClickUp token exchange failed");
}

/**
 * Runs the OAuth authorization-code flow against a loopback HTTP server, stores the
 * resulting token in the token file and resolves with it.
 */
export async function runOAuthFlow(options: OAuthFlowOptions = {}): Promise<string> {
  const env = getOAuthClientCredentials();
  const clientId = options.clientId ?? env.clientId;
  const clientSecret = options.clientSecret ?? env.clientSecret;
  if (!clientId || !clientSecret) {
    throw new Error("OAuth requires CLICKUP_CLIENT_ID and CLICKUP_CLIENT_SECRET to be set.");
  }
  const port = options.port ?? getOAuthPort();
  const tokenFile = options.tokenFile ?? getTokenFilePath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS;
  const openBrowser = options.openBrowser ?? defaultOpenBrowser;
  const fetchFn = options.fetch ?? globalThis.fetch;
  const state = crypto.randomBytes(16).toString("hex");

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let exchanging = false;
    let timer: NodeJS.Timeout | undefined;
    let redirectUri = "";

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      res.setHeader("Connection", "close");
      if (req.method !== "GET" || url.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }
      // The state comes first: a stray or forged request must neither be answered with
      // details nor settle (abort) the login that is really in progress.
      if (!statesMatch(state, url.searchParams.get("state"))) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(htmlPage("Invalid state parameter."));
        return;
      }
      if (settled || exchanging) {
        res.writeHead(409, { "Content-Type": "text/html" });
        res.end(htmlPage("This authorization was already handled."));
        return;
      }

      const error = url.searchParams.get("error");
      if (error) {
        const description = url.searchParams.get("error_description");
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(htmlPage(`Authorization failed: ${error}`));
        finish(new Error(`ClickUp authorization failed: ${error}${description ? ` (${description})` : ""}`));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(htmlPage("Missing authorization code."));
        finish(new Error("ClickUp callback did not include an authorization code."));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(htmlPage("Authorized. You can close this tab."));
      // Claim the flow now so a second callback cannot trigger a second exchange.
      exchanging = true;
      exchangeClickUpCode(fetchFn, clientId, clientSecret, code)
        .then((token) => {
          writeStoredToken(tokenFile, {
            client_id: clientId,
            access_token: token,
            created_at: new Date().toISOString(),
          });
          exchanging = false;
          finish(undefined, token);
        })
        .catch((err) => {
          exchanging = false;
          finish(err instanceof Error ? err : new Error(String(err)));
        });
    });

    function finish(error?: Error, token?: string) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const done = () => (error ? reject(error) : resolve(token as string));
      if (server.listening) {
        server.close(() => done());
        (server as any).closeIdleConnections?.();
      } else {
        done();
      }
    }

    server.once("error", (err: NodeJS.ErrnoException) => {
      const hint =
        err.code === "EADDRINUSE"
          ? ` Port ${port} is already in use; set CLICKUP_OAUTH_PORT to a free port (and register the matching redirect URL in your ClickUp app).`
          : "";
      finish(new Error(`OAuth callback server failed: ${err.message}.${hint}`));
    });

    server.listen(port, "127.0.0.1", () => {
      const actualPort = (server.address() as { port: number }).port;
      redirectUri = `http://localhost:${actualPort}/callback`;
      const authorizeUrl =
        `${AUTHORIZE_URL}?` +
        new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state }).toString();

      timer = setTimeout(() => {
        finish(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ClickUp authorization.`));
      }, timeoutMs);

      console.error(`Open this URL to authorize ClickUp access (redirect URL: ${redirectUri}):`);
      console.error(authorizeUrl);
      console.error("If your browser did not open automatically, open the URL above manually.");
      try {
        Promise.resolve(openBrowser(authorizeUrl)).catch(() => {});
      } catch {
        // ignore: the URL is printed above
      }
    });
  });
}

let credentialsPromise: Promise<{ token: string; teamId: string }> | null = null;

async function detectTeamId(token: string): Promise<string> {
  const response = await fetch(`${API_BASE}/team`, {
    headers: { Authorization: formatAuthHeader(token) },
  });
  if (!response.ok) {
    throw new Error(
      `Could not detect the ClickUp workspace (GET /team): ${response.status} ${await response.text()}`
    );
  }
  const data: any = await response.json();
  const teams: Array<{ id: string | number; name?: string }> = data?.teams ?? [];
  if (teams.length === 0) {
    throw new Error("This ClickUp token has no authorized workspaces. Authorize at least one workspace, or set CLICKUP_TEAM_ID.");
  }
  if (teams.length > 1) {
    const list = teams.map((t) => `${t.name ?? "Unnamed"} (team_id: ${t.id})`).join(", ");
    throw new Error(`Multiple ClickUp workspaces are available: ${list}. Set CLICKUP_TEAM_ID to the one you want to use.`);
  }
  return String(teams[0].id);
}

async function resolveCredentials(): Promise<{ token: string; teamId: string }> {
  let token = readOptionalEnv("CLICKUP_API_KEY");

  if (!token) {
    const stored = readStoredToken();
    const { clientId, clientSecret } = getOAuthClientCredentials();
    if (stored && (!clientId || clientId === stored.client_id)) {
      token = stored.access_token;
    } else if (clientId && clientSecret) {
      token = await runOAuthFlow();
    }
  }

  if (!token) {
    throw new Error(
      "No ClickUp credentials found. Either set CLICKUP_API_KEY (a personal token or an OAuth access token), " +
        "or set CLICKUP_CLIENT_ID and CLICKUP_CLIENT_SECRET and run the `auth` subcommand (e.g. `npx @hauptsache.net/clickup-mcp auth`) to authorize via OAuth."
    );
  }

  const teamId = readOptionalEnv("CLICKUP_TEAM_ID") ?? (await detectTeamId(token));
  setCredentials(token, teamId);
  return { token, teamId };
}

/**
 * Resolves the token (env, stored OAuth token, or interactive OAuth) and the team ID
 * (env or auto-detected) and publishes them via setCredentials. The promise is cached
 * so concurrent callers share one resolution; a failure is not cached so it can be retried.
 */
export function ensureCredentials(): Promise<{ token: string; teamId: string }> {
  if (!credentialsPromise) {
    const promise = resolveCredentials();
    credentialsPromise = promise;
    promise.catch(() => {
      if (credentialsPromise === promise) credentialsPromise = null;
    });
  }
  return credentialsPromise;
}
