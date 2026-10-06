import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp, type HttpApp } from '../http/app';
import { sealToken } from '../http/crypto';

const REDIRECT = 'http://127.0.0.1:1/cb';
const TEAM = 'team1';
const SECRET = 'a-test-secret-that-is-at-least-32-characters-long';

let mockAgent: MockAgent;
let httpServer: http.Server;
let app: HttpApp;
let base: string;

function clickup() {
  return mockAgent.get('https://api.clickup.com');
}

/** Stubs everything one ClickUp user needs: code exchange, /user, /team and the spaces createMcpServer loads. */
function stubClickUpUser(n: number, opts: { revokedAfterLogin?: boolean } = {}) {
  const token = `cu-token-${n}`;
  const headers = { authorization: `Bearer ${token}` };
  clickup()
    .intercept({ path: '/api/v2/oauth/token', method: 'POST', body: (b: string) => b.includes(`cu-code-${n}`) })
    .reply(200, { access_token: token });
  const userReply = { user: { id: 100 + n, username: `user${n}`, email: `user${n}@example.com` } };
  if (opts.revokedAfterLogin) {
    // First /user call is the login callback, every later one finds the token revoked
    clickup().intercept({ path: '/api/v2/user', method: 'GET', headers }).reply(200, userReply);
    clickup().intercept({ path: '/api/v2/user', method: 'GET', headers }).reply(401, { err: 'Token invalid', ECODE: 'OAUTH_019' });
  } else {
    clickup().intercept({ path: '/api/v2/user', method: 'GET', headers }).reply(200, userReply).persist();
  }
  clickup()
    .intercept({ path: '/api/v2/team', method: 'GET', headers })
    .reply(200, { teams: [{ id: TEAM, name: 'Team One' }] })
    .persist();
  clickup()
    .intercept({ path: `/api/v2/team/${TEAM}/space`, method: 'GET', headers })
    .reply(200, { spaces: [{ id: 's1', name: 'Alpha', archived: false }] })
    .persist();
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function registerClient(): Promise<string> {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', client_name: 'e2e client' }),
  });
  assert.equal(res.status, 201);
  const body: any = await res.json();
  assert.ok(body.client_id);
  assert.equal(body.client_secret, undefined);
  return body.client_id;
}

/** GET /authorize: the consent page plus the browser-binding cookie (http, so no __Host- prefix). */
async function beginLogin(authorizeUrl: string) {
  const res = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(
    res.headers.get('content-security-policy'),
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://app.clickup.com; frame-ancestors 'none'"
  );
  const setCookie = res.headers.get('set-cookie')!;
  assert.match(setCookie, /^clickup_mcp_auth=[0-9a-f]{64}; Max-Age=600; Path=\/; HttpOnly; SameSite=Lax$/);
  const html = await res.text();
  assert.match(html, /Connect ClickUp to e2e client/);
  assert.match(html, /Continue to ClickUp/);
  return { nonce: /name="nonce" value="([0-9a-f]+)"/.exec(html)![1], cookie: setCookie.split(';')[0] };
}

function consentPost(nonce: string, cookie: string | undefined) {
  return fetch(`${base}/authorize/consent`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams({ nonce }),
  });
}

/** DCR + authorize + (simulated) ClickUp login + token exchange for ClickUp user n. */
async function login(n: number, opts: { revokedAfterLogin?: boolean; scope?: string } = {}) {
  stubClickUpUser(n, opts);
  const clientId = await registerClient();
  const { verifier, challenge } = pkce();

  const authorize = new URL(`${base}/authorize`);
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: `state-${n}`,
    scope: opts.scope ?? 'clickup',
    resource: `${base}/mcp`,
  })) {
    authorize.searchParams.set(k, v);
  }
  // 1. /authorize shows a consent page instead of redirecting, and binds the login to this browser
  const { nonce } = await beginLogin(authorize.href);

  // 2. A different browser (no cookie) cannot press "Continue", and that consumes the pending login
  const noCookie = await consentPost(nonce, undefined);
  assert.equal(noCookie.status, 400);
  const retry = await beginLogin(authorize.href);

  // 3. The right browser continues to ClickUp...
  const consentRes = await consentPost(retry.nonce, retry.cookie);
  assert.equal(consentRes.status, 302);
  const clickupUrl = new URL(consentRes.headers.get('location')!);
  assert.equal(clickupUrl.origin + clickupUrl.pathname, 'https://app.clickup.com/api');
  assert.equal(clickupUrl.searchParams.get('redirect_uri'), `${base}/oauth/clickup/callback`);
  assert.equal(clickupUrl.searchParams.get('state'), retry.nonce);

  // 4. ...and ClickUp sends it back to us
  const cbRes = await fetch(`${base}/oauth/clickup/callback?code=cu-code-${n}&state=${retry.nonce}`, {
    redirect: 'manual',
    headers: { Cookie: retry.cookie },
  });
  assert.equal(cbRes.status, 302);
  const back = new URL(cbRes.headers.get('location')!);
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get('state'), `state-${n}`);
  const code = back.searchParams.get('code')!;

  const tokenRes = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
    }),
  });
  assert.equal(tokenRes.status, 200);
  const tokens: any = await tokenRes.json();
  assert.equal(tokens.token_type, 'Bearer');
  return { clientId, tokens };
}

before(async () => {
  process.env.CLICKUP_API_KEY = process.env.CLICKUP_API_KEY ?? 'test-key';
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  mockAgent.enableNetConnect(/127\.0\.0\.1|localhost/);
  setGlobalDispatcher(mockAgent);

  // The public URL has to contain the port, so bind first and attach the app afterwards.
  httpServer = http.createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  app = createApp({
    publicUrl: base,
    tokenSecret: SECRET,
    clickupClientId: 'cu-client',
    clickupClientSecret: 'cu-secret',
    teamId: TEAM,
  });
  httpServer.on('request', app);
});

after(async () => {
  await app.shutdown();
  httpServer.closeAllConnections();
  await new Promise((resolve) => httpServer.close(resolve));
  await mockAgent.close();
});

test('discovery documents point at this server and /mcp', async () => {
  const as: any = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.issuer, `${base}/`);
  assert.equal(as.authorization_endpoint, `${base}/authorize`);
  assert.equal(as.token_endpoint, `${base}/token`);
  assert.equal(as.registration_endpoint, `${base}/register`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.ok(as.token_endpoint_auth_methods_supported.includes('none'));

  const rs: any = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  assert.equal(rs.resource, `${base}/mcp`);
  assert.deepEqual(rs.authorization_servers, [`${base}/`]);
  // RFC 9728 path-aware form
  const rsPath = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(rsPath.status, 200);
});

test('health and landing page', async () => {
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const root = await fetch(`${base}/`);
  assert.equal(root.status, 200);
  assert.match(await root.text(), /\/mcp/);
});

test('scopes: extra requested scopes are downscoped to clickup, and a token without the scope is refused at /mcp', async () => {
  // GET with an unknown extra scope succeeds and the token carries only clickup
  const user = await login(4, { scope: 'clickup foo' });
  assert.equal(user.tokens.scope, 'clickup');
  const clientId = user.clientId;
  // ...also when none of the requested scopes is ours, and via POST
  const post = await fetch(`${base}/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkce().challenge,
      code_challenge_method: 'S256', state: 's', scope: 'foo bar',
    }),
  });
  assert.equal(post.status, 200);
  assert.match(await post.text(), /Continue to ClickUp/);

  const noScope = sealToken(
    'access',
    { clickupToken: 'cu-token-1', userId: '101', username: 'user1', teamId: TEAM, clientId, scopes: [] },
    60,
    SECRET
  );
  const denied = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${noScope}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(denied.status, 403);
  assert.match(denied.headers.get('www-authenticate') ?? '', /insufficient_scope/);
});

test('registering a client with a dangerous or insecure redirect_uri is an OAuth 400 and issues no client', async () => {
  for (const redirect_uris of [['javascript:document.forms[0].submit()//'], ['http://evil.example/cb'], [REDIRECT, 'data:text/html,x']]) {
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris, token_endpoint_auth_method: 'none', client_name: 'bad' }),
    });
    assert.equal(res.status, 400, JSON.stringify(redirect_uris));
    const body: any = await res.json();
    assert.equal(body.error, 'invalid_client_metadata');
    assert.equal(body.client_id, undefined);
  }
  // https and loopback http are accepted
  for (const uri of ['https://claude.ai/api/mcp/auth_callback', 'http://127.0.0.1:1/cb']) {
    const res = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [uri], token_endpoint_auth_method: 'none' }),
    });
    assert.equal(res.status, 201, uri);
  }
});

test('/mcp without a valid bearer token answers 401 with resource_metadata', async () => {
  for (const headers of [{}, { Authorization: 'Bearer nope' }] as Record<string, string>[]) {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', /resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource"/);
  }
  assert.equal((await fetch(`${base}/mcp`)).status, 401);
  assert.equal((await fetch(`${base}/mcp`, { method: 'DELETE' })).status, 401);
});

test('a ClickUp token that was revoked after login makes /mcp answer 401 so the client re-authorizes', async () => {
  const user = await login(3, { revokedAfterLogin: true });
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${user.tokens.access_token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '1.0.0' } },
    }),
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /^Bearer error="invalid_token".*resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource"/);
});

test('full flow: DCR, PKCE login via ClickUp, refresh, MCP session, and session binding per user', async () => {
  const user1 = await login(1);
  const bearer1 = { Authorization: `Bearer ${user1.tokens.access_token}` };

  // MCP client over Streamable HTTP with the issued token
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: bearer1 } });
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('getTaskById'), `tools: ${names.join(', ')}`);
  const sessionId = transport.sessionId;
  assert.ok(sessionId);

  // Another ClickUp user must not be able to use user 1's session id
  const user2 = await login(2);
  const bearer2 = { Authorization: `Bearer ${user2.tokens.access_token}` };
  const listToolsBody = JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} });
  const mcpHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const stolen = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...mcpHeaders, ...bearer2, 'mcp-session-id': sessionId! },
    body: listToolsBody,
  });
  assert.equal(stolen.status, 403);
  assert.equal((await fetch(`${base}/mcp`, { headers: { ...bearer2, 'mcp-session-id': sessionId! } })).status, 403);
  assert.equal((await fetch(`${base}/mcp`, { method: 'DELETE', headers: { ...bearer2, 'mcp-session-id': sessionId! } })).status, 403);

  // Unknown session and missing session header
  const unknown = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...mcpHeaders, ...bearer1, 'mcp-session-id': 'does-not-exist' },
    body: listToolsBody,
  });
  assert.equal(unknown.status, 404);
  const noSession = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...mcpHeaders, ...bearer1 }, body: listToolsBody });
  assert.equal(noSession.status, 400);

  // The owner still works after the failed attempts, also with a refreshed token
  const refreshRes = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: user1.tokens.refresh_token,
      client_id: user1.clientId,
    }),
  });
  assert.equal(refreshRes.status, 200);
  const refreshed: any = await refreshRes.json();
  // Rotation: the same refresh token cannot be used twice
  const replay = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: user1.tokens.refresh_token,
      client_id: user1.clientId,
    }),
  });
  assert.equal(replay.status, 400);
  assert.equal(((await replay.json()) as any).error, 'invalid_grant');
  const owner = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...mcpHeaders, Authorization: `Bearer ${refreshed.access_token}`, 'mcp-session-id': sessionId! },
    body: listToolsBody,
  });
  assert.equal(owner.status, 200);

  // A refresh token of another client is rejected
  const foreign = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: user1.tokens.refresh_token,
      client_id: user2.clientId,
    }),
  });
  assert.equal(foreign.status, 400);

  // DELETE ends the session; afterwards it is gone
  const deleted = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { ...bearer1, 'mcp-session-id': sessionId! } });
  assert.equal(deleted.status, 200);
  const gone = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...mcpHeaders, ...bearer1, 'mcp-session-id': sessionId! },
    body: listToolsBody,
  });
  assert.equal(gone.status, 404);
  await client.close().catch(() => undefined);
});
