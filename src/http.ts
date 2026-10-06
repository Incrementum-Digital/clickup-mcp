import { readOptionalEnv } from "./shared/config";
import { MIN_SECRET_LENGTH } from "./http/crypto";
import { createApp } from "./http/app";
import { isValidRedirectScheme } from "./http/provider";

/**
 * Hosted mode entry point: MCP over Streamable HTTP at /mcp, with an OAuth 2.1
 * authorization server in front of it whose login delegates to ClickUp OAuth.
 */

function readSeconds(name: string, fallback: number, problems: string[]): number {
  const raw = readOptionalEnv(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    problems.push(`${name} must be a positive integer number of seconds (got "${raw}")`);
    return fallback;
  }
  return value;
}

function main(): void {
  const problems: string[] = [];
  const railwayDomain = readOptionalEnv("RAILWAY_PUBLIC_DOMAIN");
  const publicUrl = readOptionalEnv("MCP_PUBLIC_URL") ?? (railwayDomain ? `https://${railwayDomain}` : undefined);
  const tokenSecret = readOptionalEnv("MCP_TOKEN_SECRET");
  const clickupClientId = readOptionalEnv("CLICKUP_CLIENT_ID");
  const clickupClientSecret = readOptionalEnv("CLICKUP_CLIENT_SECRET");
  const teamId = readOptionalEnv("CLICKUP_TEAM_ID");
  const allowedRedirectSchemes = (readOptionalEnv("MCP_ALLOWED_REDIRECT_SCHEMES") ?? "")
    .split(",")
    .map((scheme) => scheme.trim().toLowerCase().replace(/:$/, ""))
    .filter(Boolean);
  for (const scheme of allowedRedirectSchemes) {
    if (!isValidRedirectScheme(scheme)) {
      problems.push(`MCP_ALLOWED_REDIRECT_SCHEMES contains "${scheme}", which is not a usable custom scheme (http, https, javascript, data, file and similar are never allowed)`);
    }
  }
  const rawPort = readOptionalEnv("PORT");
  const port = rawPort === undefined ? 3000 : Number(rawPort);

  if (!publicUrl) problems.push("MCP_PUBLIC_URL is required (or RAILWAY_PUBLIC_DOMAIN), e.g. https://clickup-mcp.example.com");
  else {
    try {
      const url = new URL(publicUrl);
      if (url.pathname !== "/" || url.search || url.hash) throw new Error("not an origin");
    } catch {
      problems.push(`MCP_PUBLIC_URL must be an origin like https://clickup-mcp.example.com (got "${publicUrl}")`);
    }
  }
  if (!tokenSecret) {
    problems.push(
      `MCP_TOKEN_SECRET is required (at least ${MIN_SECRET_LENGTH} characters, e.g. from "openssl rand -hex 32"). ` +
        "It is never generated automatically: a new secret on every restart would invalidate every issued token"
    );
  } else if (tokenSecret.length < MIN_SECRET_LENGTH) {
    problems.push(`MCP_TOKEN_SECRET must be at least ${MIN_SECRET_LENGTH} characters long (got ${tokenSecret.length})`);
  }
  if (!clickupClientId) problems.push("CLICKUP_CLIENT_ID is required");
  if (!clickupClientSecret) problems.push("CLICKUP_CLIENT_SECRET is required");
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`PORT must be a port number (got "${rawPort}")`);
  const accessTokenTtlSeconds = readSeconds("MCP_ACCESS_TOKEN_TTL_SECONDS", 3600, problems);
  const refreshTokenTtlSeconds = readSeconds("MCP_REFRESH_TOKEN_TTL_SECONDS", 30 * 24 * 3600, problems);
  const sessionIdleSeconds = readSeconds("MCP_SESSION_IDLE_SECONDS", 3600, problems);

  if (problems.length > 0) {
    console.error("Cannot start the hosted ClickUp MCP server:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  const app = createApp({
    publicUrl: publicUrl!,
    tokenSecret: tokenSecret!,
    clickupClientId: clickupClientId!,
    clickupClientSecret: clickupClientSecret!,
    teamId,
    allowedRedirectSchemes,
    accessTokenTtlSeconds,
    refreshTokenTtlSeconds,
    sessionIdleSeconds,
  });

  const server = app.listen(port, () => {
    console.error(`ClickUp MCP listening on port ${port}`);
    console.error(`MCP endpoint: ${new URL("/mcp", publicUrl).href}`);
    console.error(`Register this redirect URL in your ClickUp app: ${new URL("/oauth/clickup/callback", publicUrl).href}`);
    if (allowedRedirectSchemes.length > 0) console.error(`Extra redirect schemes allowed: ${allowedRedirectSchemes.join(", ")}`);
    if (!teamId) console.error("CLICKUP_TEAM_ID is not set: users must have authorized exactly one workspace");
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    server.close();
    (server as any).closeIdleConnections?.();
    app.shutdown().finally(() => {
      (server as any).closeAllConnections?.();
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
