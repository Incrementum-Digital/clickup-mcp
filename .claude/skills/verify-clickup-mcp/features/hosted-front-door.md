# Hosted front door (Railway)

## Sub-features
- `GET /health` → `{"status":"ok"}` (Railway's healthcheck path).
- OAuth 2.1 authorization server: `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource[/mcp]`, `/authorize`, consent and ClickUp callback (`src/http/provider.ts`), dynamic client registration.
- `POST|GET /mcp`: Streamable HTTP MCP, one session per bearer token, idle timeout `MCP_SESSION_IDLE_SECONDS`.
- Workspace gate: `CLICKUP_TEAM_ID` limits who may connect.

## How to get to it (user POV)
Add the server URL (`https://<railway domain>/mcp`) to an MCP client; the client discovers the OAuth metadata, opens the browser, the person logs in to ClickUp and consents; the client gets a token and calls tools as that person.

## Driving it with curl
`drive.sh all` (no credential): `health`, `metadata` (issuer and endpoints present), `guards` (POST without token, POST with a bad token and GET without token are all 401). `launch.sh` starts this mode with a throwaway `MCP_TOKEN_SECRET` and dummy ClickUp client id/secret; the real login cannot be driven locally because ClickUp would redirect to the registered production callback.

## Gotchas
- `MCP_TOKEN_SECRET` is never generated at start; rotating it logs every user out.
- Start refuses to run with any configuration problem and lists them all (exit 1).
- `MCP_PUBLIC_URL` falls back to `https://$RAILWAY_PUBLIC_DOMAIN`; locally it must be set (launch.sh does).
- Railway's `RAILPACK_INSTALL_CMD` on the service starts with the Corepack prefix because of the `packageManager` pin; removing the prefix breaks the build.
