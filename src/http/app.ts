import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type Express, type Request, type Response } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { RequestCredentials, runWithCredentials } from "../shared/request-context";
import { createMcpServer } from "../server-factory";
import { CALLBACK_PATH, CLICKUP_SCOPE, CONSENT_PATH, ClickUpOAuthProvider } from "./provider";
import { SessionStore } from "./sessions";

export interface AppOptions {
  /** External origin of this server, e.g. https://clickup-mcp-production.up.railway.app */
  publicUrl: string | URL;
  tokenSecret: string;
  clickupClientId: string;
  clickupClientSecret: string;
  /** Optional workspace gate, see CLICKUP_TEAM_ID. */
  teamId?: string;
  /** Extra native-app redirect schemes allowed besides https and loopback http, see MCP_ALLOWED_REDIRECT_SCHEMES. */
  allowedRedirectSchemes?: string[];
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  sessionIdleSeconds?: number;
  /** Test hook; defaults to the real server factory. */
  createServer?: () => Promise<McpServer>;
}

export type HttpApp = Express & {
  /** Stops timers and closes every open MCP session. */
  shutdown(): Promise<void>;
};

const DEFAULT_ACCESS_TTL = 3600;
const DEFAULT_REFRESH_TTL = 30 * 24 * 3600;
const DEFAULT_SESSION_IDLE = 3600;

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

export function createApp(options: AppOptions): HttpApp {
  const publicUrl = new URL(options.publicUrl);
  const mcpUrl = new URL("/mcp", publicUrl);
  const provider = new ClickUpOAuthProvider({
    publicUrl,
    tokenSecret: options.tokenSecret,
    clickupClientId: options.clickupClientId,
    clickupClientSecret: options.clickupClientSecret,
    teamId: options.teamId,
    allowedRedirectSchemes: options.allowedRedirectSchemes,
    accessTokenTtlSeconds: options.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TTL,
    refreshTokenTtlSeconds: options.refreshTokenTtlSeconds ?? DEFAULT_REFRESH_TTL,
  });
  const sessions = new SessionStore((options.sessionIdleSeconds ?? DEFAULT_SESSION_IDLE) * 1000);
  const buildServer = options.createServer ?? createMcpServer;

  const app = express() as HttpApp;
  app.set("trust proxy", 1); // Railway terminates TLS in front of us; needed for rate limiting by client IP
  app.disable("x-powered-by");
  app.use(cors({ exposedHeaders: ["mcp-session-id", "www-authenticate"] }));

  // The SDK's mcpAuthRouter (1.15.x) hardcodes two things we need different: it advertises
  // only client_secret_post at the token endpoint (we also serve public PKCE clients with
  // "none") and it names the issuer, not /mcp, as the protected resource. Mounting our own
  // metadata first makes it win over the router's copies of the same two documents.
  const oauthMetadata = {
    ...createOAuthMetadata({ provider, issuerUrl: publicUrl, baseUrl: publicUrl, scopesSupported: [CLICKUP_SCOPE] }),
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
  };
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl: mcpUrl,
      scopesSupported: [CLICKUP_SCOPE],
      resourceName: "ClickUp MCP",
    })
  );
  // RFC 9728 path-aware form for the resource at /mcp, which some clients probe first.
  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.json({
      resource: mcpUrl.href,
      authorization_servers: [oauthMetadata.issuer],
      scopes_supported: [CLICKUP_SCOPE],
      resource_name: "ClickUp MCP",
    });
  });
  // Unknown scopes are downscoped, not refused: the grant is always exactly "clickup". The SDK's
  // authorize handler would reject any scope the client did not register before the provider
  // is even called, so the scope parameter is normalised in front of it.
  app.all("/authorize", express.urlencoded({ extended: false }), (req, _res, next) => {
    if (req.method === "POST" && typeof req.body?.scope === "string") {
      req.body.scope = CLICKUP_SCOPE;
    } else if (req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      if (url.searchParams.has("scope")) {
        url.searchParams.set("scope", CLICKUP_SCOPE);
        req.url = url.pathname + url.search;
      }
    }
    next();
  });
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: publicUrl,
      baseUrl: publicUrl,
      scopesSupported: [CLICKUP_SCOPE],
      resourceName: "ClickUp MCP",
    })
  );

  app.post(CONSENT_PATH, express.urlencoded({ extended: false }), provider.handleConsent);
  app.get(CALLBACK_PATH, provider.handleClickUpCallback);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/", (_req, res) => {
    res
      .type("html")
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><title>ClickUp MCP</title></head>` +
          `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
          `<h1>ClickUp MCP</h1><p>This is a remote MCP server for ClickUp. Add <code>${mcpUrl.href}</code> as a custom connector in your MCP client and sign in with ClickUp.</p></body></html>`
      );
  });

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpUrl);
  const requireAuth = requireBearerAuth({ verifier: provider, requiredScopes: [CLICKUP_SCOPE], resourceMetadataUrl });

  /**
   * ClickUp answered 401: the user revoked the app (or the token otherwise died). Our own
   * token is still fine, so answer like the bearer middleware does and let the client
   * re-authenticate instead of showing an internal error.
   */
  function answerRevokedClickUpToken(error: unknown, res: Response): boolean {
    const message = error instanceof Error ? error.message : String(error);
    if (!/^Error fetching (user info|spaces): 401\b/.test(message)) return false;
    if (!res.headersSent) {
      res
        .set(
          "WWW-Authenticate",
          `Bearer error="invalid_token", error_description="ClickUp rejected the stored token", resource_metadata="${resourceMetadataUrl}"`
        )
        .status(401)
        .json({ error: "invalid_token", error_description: "ClickUp rejected the stored token, authorize again" });
    }
    return true;
  }

  function credentialsOf(req: Request): RequestCredentials {
    const extra = (req.auth?.extra ?? {}) as Record<string, string>;
    return {
      token: extra.clickupToken,
      teamId: extra.teamId,
      userKey: extra.userKey,
      userId: extra.userId,
      username: extra.username,
    };
  }

  function whoami(creds: RequestCredentials): string {
    return `user=${creds.username} (user_id: ${creds.userId})`;
  }

  function logToolCalls(body: unknown, creds: RequestCredentials): void {
    for (const message of Array.isArray(body) ? body : [body]) {
      if (message && (message as any).method === "tools/call") {
        console.error(`tool=${(message as any).params?.name} ${whoami(creds)}`);
      }
    }
  }

  /** Finds the caller's session or answers the request; undefined means the response was sent. */
  function sessionFor(req: Request, res: Response, creds: RequestCredentials) {
    const sessionId = req.header("mcp-session-id");
    if (!sessionId) {
      jsonRpcError(res, 400, -32000, "Bad Request: Mcp-Session-Id header is required");
      return undefined;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      jsonRpcError(res, 404, -32001, "Session not found");
      return undefined;
    }
    // A session id is not a credential: it only works for the user who created the session.
    if (session.userKey !== creds.userKey) {
      jsonRpcError(res, 403, -32003, "Forbidden: session belongs to another user");
      return undefined;
    }
    sessions.touch(sessionId);
    return session;
  }

  app.post("/mcp", requireAuth, express.json({ limit: "10mb" }), async (req, res) => {
    const creds = credentialsOf(req);
    try {
      if (req.header("mcp-session-id")) {
        const session = sessionFor(req, res, creds);
        if (!session) return;
        logToolCalls(req.body, creds);
        // The request stream is already consumed by express.json(), so the body must be passed along.
        await runWithCredentials(creds, () => session.transport.handleRequest(req, res, req.body));
        return;
      }
      if (!isInitializeRequest(req.body)) {
        jsonRpcError(res, 400, -32000, "Bad Request: no session, and the request is not an initialize request");
        return;
      }
      let registered = false;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          registered = true;
          sessions.add(id, { transport, server, userKey: creds.userKey, username: creds.username });
          console.error(`session ${id} ${whoami(creds)} ua=${req.header("user-agent") ?? "unknown"}`);
        },
      });
      const server = await runWithCredentials(creds, buildServer);
      // Set before connect(): connect() chains whatever onclose was already there.
      transport.onclose = () => {
        if (transport.sessionId) void sessions.remove(transport.sessionId);
      };
      try {
        await server.connect(transport);
        await runWithCredentials(creds, () => transport.handleRequest(req, res, req.body));
      } finally {
        if (!registered) await server.close().catch(() => undefined);
      }
    } catch (error) {
      console.error(`POST /mcp failed: ${error instanceof Error ? error.message : String(error)}`);
      if (answerRevokedClickUpToken(error, res)) return;
      jsonRpcError(res, 500, -32603, "Internal server error");
    }
  });

  const sessionRequest = async (req: Request, res: Response) => {
    const creds = credentialsOf(req);
    try {
      const session = sessionFor(req, res, creds);
      if (!session) return;
      await runWithCredentials(creds, () => session.transport.handleRequest(req, res, req.body));
    } catch (error) {
      console.error(`${req.method} /mcp failed: ${error instanceof Error ? error.message : String(error)}`);
      if (answerRevokedClickUpToken(error, res)) return;
      jsonRpcError(res, 500, -32603, "Internal server error");
    }
  };
  app.get("/mcp", requireAuth, sessionRequest);
  app.delete("/mcp", requireAuth, sessionRequest);

  app.shutdown = async () => {
    provider.shutdown();
    await sessions.shutdown();
  };
  return app;
}
