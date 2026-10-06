import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { sealToken } from '../http/crypto';
import { ClickUpOAuthProvider, CALLBACK_PATH, CONSENT_PATH } from '../http/provider';
import { userKeyForToken } from '../shared/request-context';

const SECRET = 'a-test-secret-that-is-at-least-32-characters-long';
const REDIRECT = 'http://127.0.0.1:1/cb';

let mockAgent: MockAgent;
let server: Server | undefined;
let provider: ClickUpOAuthProvider;
let base: string;
// Cookie the "browser" received from the last authorize() call
let lastCookie: string | undefined;
let lastSetCookie: string | undefined;

function clickup() {
  return mockAgent.get('https://api.clickup.com');
}

async function start(teamId?: string, allowedRedirectSchemes?: string[]) {
  provider = new ClickUpOAuthProvider({
    publicUrl: new URL('https://mcp.example.com'),
    tokenSecret: SECRET,
    clickupClientId: 'cu-client',
    clickupClientSecret: 'cu-secret',
    teamId,
    allowedRedirectSchemes,
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 86400,
  });
  const app = express();
  app.post(CONSENT_PATH, express.urlencoded({ extended: false }), provider.handleConsent);
  app.get(CALLBACK_PATH, provider.handleClickUpCallback);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

beforeEach(() => {
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  mockAgent.enableNetConnect(/127\.0\.0\.1|localhost/);
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  provider?.shutdown();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
  await mockAgent.close();
});

function stubClickUp(opts: { token?: string; teams?: { id: string; name: string }[]; userId?: number } = {}) {
  clickup()
    .intercept({ path: /^\/api\/v2\/oauth\/token/, method: 'POST' })
    .reply(200, { access_token: opts.token ?? 'cu-token-1' });
  clickup()
    .intercept({ path: '/api/v2/user', method: 'GET' })
    .reply(200, { user: { id: opts.userId ?? 42, username: 'alice', email: 'alice@example.com' } });
  clickup()
    .intercept({ path: '/api/v2/team', method: 'GET' })
    .reply(200, { teams: opts.teams ?? [{ id: 'team1', name: 'Team One' }] });
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function registerPublic(redirectUris = [REDIRECT]) {
  return provider.clientsStore.registerClient!({
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    client_name: 'Test Client',
    client_id: 'generated-uuid',
    client_id_issued_at: 1,
  } as any);
}

/** Runs authorize() with a fake response: returns the consent page and the pending nonce (nothing is redirected yet). */
async function beginAuthorize(client: any, challenge: string, state = 'client-state', scopes = ['clickup']) {
  const out = { status: 0, html: '', headers: {} as Record<string, string> };
  const res: any = {
    status(code: number) { out.status = code; return res; },
    type() { return res; },
    set(name: any, value?: string) { Object.assign(out.headers, typeof name === 'string' ? { [name]: value } : name); return res; },
    append(name: string, value: string) {
      assert.equal(name, 'Set-Cookie');
      lastSetCookie = value;
      lastCookie = value.split(';')[0];
      return res;
    },
    send(body: string) { out.html = body; return res; },
    redirect() { assert.fail('authorize() must not redirect before the user consented'); },
  };
  await provider.authorize(
    client,
    { state, scopes, redirectUri: REDIRECT, codeChallenge: challenge, resource: new URL('https://mcp.example.com/mcp') },
    res
  );
  const nonce = /name="nonce" value="([0-9a-f]+)"/.exec(out.html)?.[1]!;
  return { ...out, nonce };
}

/** The user pressing "Continue to ClickUp": POST /authorize/consent, by default with the cookie authorize() set. */
async function consent(nonce: string | undefined, cookie: string | null | undefined = lastCookie) {
  return fetch(`${base}${CONSENT_PATH}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
    body: new URLSearchParams(nonce ? { nonce } : {}),
  });
}

/** authorize() + consent: returns the ClickUp redirect and its state nonce. */
async function startAuthorize(client: any, challenge: string, state = 'client-state') {
  const { nonce } = await beginAuthorize(client, challenge, state);
  const res = await consent(nonce);
  assert.equal(res.status, 302);
  const url = new URL(res.headers.get('location')!);
  return { url, nonce: url.searchParams.get('state')! };
}

/** Simulates ClickUp sending the browser back; by default with the cookie authorize() set. */
async function callback(query: Record<string, string>, cookie: string | null | undefined = lastCookie) {
  const url = new URL(`${base}${CALLBACK_PATH}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return fetch(url.href, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
}

/** The failure pages offer a link back to the client with an OAuth error and the client's state. */
async function assertReturnLink(res: Response, error: string) {
  const html = (await res.text()).replace(/&#38;/g, '&');
  const href = /<a class="button" href="([^"]+)">Return to Test Client<\/a>/.exec(html)?.[1];
  assert.ok(href, `return link missing in: ${html}`);
  const url = new URL(href.replace(/&#\d+;/g, ''));
  assert.equal(url.origin + url.pathname, REDIRECT);
  assert.equal(url.searchParams.get('error'), error);
  assert.ok(url.searchParams.get('error_description'));
  assert.equal(url.searchParams.get('state'), 'client-state');
}

/** Full happy path up to an authorization code. */
async function authorizeToCode(client: any, challenge: string) {
  stubClickUp();
  const { nonce } = await startAuthorize(client, challenge);
  const res = await callback({ code: 'clickup-code', state: nonce });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location')!);
  return { location, code: location.searchParams.get('code')! };
}

test('registerClient seals the registration into the client_id and getClient reads it back', async () => {
  await start();
  const registered = await registerPublic();
  assert.notEqual(registered.client_id, 'generated-uuid');
  assert.equal(registered.client_secret, undefined);

  const fetched = await provider.clientsStore.getClient(registered.client_id);
  assert.ok(fetched);
  assert.equal(fetched.client_id, registered.client_id);
  assert.deepEqual(fetched.redirect_uris, [REDIRECT]);
  assert.equal(fetched.client_name, 'Test Client');
  assert.equal(fetched.token_endpoint_auth_method, 'none');
  assert.equal(fetched.client_secret, undefined);
  // The scope we advertise is always allowed, otherwise the SDK's authorize handler rejects it
  assert.ok(fetched.scope?.split(' ').includes('clickup'));
});

test('registerClient keeps the generated secret of a confidential client inside the blob', async () => {
  await start();
  const registered = await provider.clientsStore.registerClient!({
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: 'client_secret_post',
    client_name: 'Confidential',
    scope: 'other',
    client_id: 'generated-uuid',
    client_secret: 'generated-secret',
    client_id_issued_at: 1,
    client_secret_expires_at: 12345,
  } as any);
  assert.equal(registered.client_secret, 'generated-secret');
  assert.equal(registered.client_secret_expires_at, 0); // never expires: we cannot re-issue anything

  const fetched = await provider.clientsStore.getClient(registered.client_id);
  assert.equal(fetched?.client_secret, 'generated-secret');
  assert.equal(fetched?.client_secret_expires_at, 0);
  assert.deepEqual(fetched?.scope?.split(' ').sort(), ['clickup', 'other']);
});

test('getClient returns undefined for unknown, tampered or foreign client ids', async () => {
  await start();
  const registered = await registerPublic();
  assert.equal(await provider.clientsStore.getClient('some-uuid'), undefined);
  assert.equal(await provider.clientsStore.getClient(registered.client_id.slice(0, -3) + 'AAA'), undefined);
  const other = new ClickUpOAuthProvider({ ...({} as any), tokenSecret: SECRET + 'x' });
  try {
    assert.equal(await other.clientsStore.getClient(registered.client_id), undefined);
  } finally {
    other.shutdown();
  }
});

test('authorize redirects to ClickUp with the callback redirect_uri and a random state nonce', async () => {
  await start();
  const client = await registerPublic();
  const { url, nonce } = await startAuthorize(client, 'challenge');
  assert.equal(url.origin + url.pathname, 'https://app.clickup.com/api');
  assert.equal(url.searchParams.get('client_id'), 'cu-client');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://mcp.example.com/oauth/clickup/callback');
  assert.match(nonce, /^[0-9a-f]{64}$/);
  assert.notEqual(nonce, (await startAuthorize(client, 'challenge')).nonce);
});

function registerWith(redirectUri: string) {
  return provider.clientsStore.registerClient!({
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'none',
    client_name: 'Policy Client',
    client_id: 'generated-uuid',
  } as any);
}

test('redirect URI policy: https and loopback http are accepted, everything else is refused at registration', async () => {
  await start();
  for (const ok of [
    'https://claude.ai/api/mcp/auth_callback',
    'https://example.com/cb',
    'http://127.0.0.1:1/cb',
    'http://localhost:3000/cb',
    'http://[::1]:5/cb',
  ]) {
    assert.ok((await registerWith(ok)).client_id, ok);
  }
  for (const bad of [
    'javascript:document.forms[0].submit()//',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'blob:https://example.com/x',
    'file:///etc/passwd',
    'http://evil.example/cb',
    'http://localhost.evil.example/cb',
    'http://127.0.0.1.evil.example/cb',
    'cursor://x/cb',
    'not a url',
  ]) {
    await assert.rejects(async () => registerWith(bad), (error: any) => {
      assert.equal(error.errorCode, 'invalid_client_metadata', bad);
      return true;
    }, bad);
  }
});

test('custom redirect schemes need to be listed, and script schemes are never allowed even then', async () => {
  await start();
  await assert.rejects(async () => registerWith('cursor://x/cb'));
  provider.shutdown();
  await new Promise((resolve) => server!.close(resolve));

  await start(undefined, ['cursor', 'javascript', 'http']);
  assert.ok((await registerWith('cursor://x/cb')).client_id);
  assert.ok((await registerWith('CURSOR://x/cb')).client_id);
  await assert.rejects(async () => registerWith('vscode://x/cb'));
  await assert.rejects(async () => registerWith('javascript:alert(1)'));
  await assert.rejects(async () => registerWith('http://evil.example/cb'));
});

test('authorize refuses a redirect_uri that fails the policy even for a client that got through', async () => {
  await start();
  const forged = sealToken(
    'client',
    { redirect_uris: ['javascript:document.forms[0].submit()//'], token_endpoint_auth_method: 'none', client_name: 'Forged' },
    60,
    SECRET
  );
  const client: any = await provider.clientsStore.getClient(forged);
  assert.ok(client);
  await assert.rejects(
    provider.authorize(client, { redirectUri: client.redirect_uris[0], codeChallenge: 'c', scopes: [] }, {} as any),
    (error: any) => error.errorCode === 'invalid_request'
  );
});

test('authorize shows a consent page naming the client and where the result goes, and redirects nowhere', async () => {
  await start();
  const client = { ...(await registerPublic()), client_name: '<b>Evil</b> & "Co"' };
  const page = await beginAuthorize(client, 'c');
  assert.equal(page.status, 200);
  assert.equal(page.headers['Cache-Control'], 'no-store');
  assert.equal(page.headers['X-Frame-Options'], 'DENY');
  assert.equal(
    page.headers['Content-Security-Policy'],
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://app.clickup.com; frame-ancestors 'none'"
  );
  assert.ok(!/href="javascript:/i.test(page.html));
  assert.match(page.html, /Connect ClickUp to &#60;b&#62;Evil&#60;\/b&#62; &#38; &#34;Co&#34;/);
  assert.ok(!page.html.includes('<b>Evil'), 'client name must be escaped');
  assert.match(page.html, /http:\/\/127\.0\.0\.1:1/); // origin of the redirect uri
  assert.match(page.html, /<code>clickup<\/code>/);
  assert.match(page.html, /action="\/authorize\/consent"/);
  assert.match(page.html, /Continue to ClickUp/);
  // Cancel goes back to the client with access_denied and its state
  const cancel = /href="([^"]*error=access_denied[^"]*)"/.exec(page.html)![1].replace(/&#38;/g, '&');
  const cancelUrl = new URL(cancel);
  assert.equal(cancelUrl.origin + cancelUrl.pathname, REDIRECT);
  assert.equal(cancelUrl.searchParams.get('error'), 'access_denied');
  assert.equal(cancelUrl.searchParams.get('state'), 'client-state');
  // Nameless clients get a generic label
  const anonymous = await beginAuthorize({ ...client, client_name: undefined }, 'c');
  assert.match(anonymous.html, /Connect ClickUp to an MCP client/);
});

test('authorize downscopes: unknown scopes are dropped and the grant is exactly clickup', async () => {
  await start();
  const client = await registerPublic();
  stubClickUp();
  const { nonce } = await beginAuthorize(client, 'c', 's', ['clickup', 'admin']);
  assert.equal((await consent(nonce)).status, 302);
  const code = new URL((await callback({ code: 'x', state: nonce })).headers.get('location')!).searchParams.get('code')!;
  const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT);
  assert.equal(tokens.scope, 'clickup');
  assert.deepEqual((await provider.verifyAccessToken(tokens.access_token)).scopes, ['clickup']);
  // Same for a request that names no scope at all
  assert.equal((await beginAuthorize(client, 'c', 's', [])).status, 200);
});

test('consent: POST without the cookie, with a wrong cookie or for an unknown nonce is refused and does not redirect to ClickUp', async () => {
  await start();
  const client = await registerPublic();
  const first = await beginAuthorize(client, 'c');
  const cookieName = lastCookie!.split('=')[0];
  const noCookie = await consent(first.nonce, null);
  assert.equal(noCookie.status, 400);
  assert.equal(noCookie.headers.get('location'), null);
  assert.match(await noCookie.text(), /same browser/);
  // that attempt consumed the pending login
  assert.equal((await consent(first.nonce)).status, 400);

  const second = await beginAuthorize(client, 'c');
  const wrong = await consent(second.nonce, `${cookieName}=${'0'.repeat(64)}`);
  assert.equal(wrong.status, 400);
  assert.equal(wrong.headers.get('location'), null);

  assert.equal((await consent('f'.repeat(64))).status, 400);
  assert.equal((await consent(undefined)).status, 400);
});

test('consent: POST with the cookie redirects to ClickUp once, and the callback then works', async () => {
  await start();
  const client = await registerPublic();
  stubClickUp();
  const { nonce } = await beginAuthorize(client, 'c');
  const res = await consent(nonce);
  assert.equal(res.status, 302);
  const url = new URL(res.headers.get('location')!);
  assert.equal(url.origin + url.pathname, 'https://app.clickup.com/api');
  assert.equal(url.searchParams.get('client_id'), 'cu-client');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://mcp.example.com/oauth/clickup/callback');
  assert.equal(url.searchParams.get('state'), nonce);
  assert.equal(res.headers.get('cache-control'), 'no-store');

  // A second press is refused but must not break the login that is under way
  const again = await consent(nonce);
  assert.equal(again.status, 400);
  assert.equal(again.headers.get('location'), null);
  assert.equal((await callback({ code: 'x', state: nonce })).status, 302);
});

test('the callback before the consent page was confirmed is refused and consumes the login', async () => {
  await start();
  const client = await registerPublic();
  stubClickUp();
  const { nonce } = await beginAuthorize(client, 'c');
  const res = await callback({ code: 'x', state: nonce });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('location'), null);
  assert.equal((await consent(nonce)).status, 400);
});

test('the callback issues a code and redirects to the client with the original state', async () => {
  await start();
  const client = await registerPublic();
  const { location, code } = await authorizeToCode(client, pkce().challenge);
  assert.equal(location.origin + location.pathname, REDIRECT);
  assert.equal(location.searchParams.get('state'), 'client-state');
  assert.match(code, /^[0-9a-f]{64}$/);
});

test('authorize binds the login to the browser with a __Host- cookie on https', async () => {
  await start();
  const client = await registerPublic();
  await startAuthorize(client, 'c');
  assert.match(
    lastSetCookie!,
    /^__Host-clickup_mcp_auth=[0-9a-f]{64}; Max-Age=600; Path=\/; HttpOnly; SameSite=Lax; Secure$/
  );
  assert.ok(!/Domain=/i.test(lastSetCookie!));
});

test('without the browser cookie the callback is refused and issues no code', async () => {
  await start();
  const client = await registerPublic();
  stubClickUp();
  const { nonce } = await startAuthorize(client, 'c');
  const res = await callback({ code: 'x', state: nonce }, null);
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('location'), null);
  assert.match(await res.text(), /same browser/);
  // The pending login is consumed, so even the right browser cannot continue it afterwards
  assert.equal((await callback({ code: 'x', state: nonce })).status, 400);
  // ClickUp was never asked to exchange the code
  assert.equal(((mockAgent.pendingInterceptors() as any[]) ?? []).length, 3);
});

test('with a wrong browser cookie the callback is refused', async () => {
  await start();
  const client = await registerPublic();
  stubClickUp();
  const { nonce } = await startAuthorize(client, 'c');
  const cookieName = lastCookie!.split('=')[0];
  const res = await callback({ code: 'x', state: nonce }, `${cookieName}=${'0'.repeat(64)}`);
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('location'), null);
  assert.match(await res.text(), /same browser/);
});

test('a cookie from another login does not complete this one', async () => {
  await start();
  const client = await registerPublic();
  stubClickUp();
  const victim = await startAuthorize(client, 'c');
  const attackerCookie = (await startAuthorize(client, 'c').then(() => lastCookie))!;
  assert.equal((await callback({ code: 'x', state: victim.nonce }, attackerCookie)).status, 400);
});

test('with the right browser cookie the callback issues a code and clears the cookie', async () => {
  await start();
  const client = await registerPublic();
  stubClickUp();
  const { nonce } = await startAuthorize(client, 'c');
  const res = await callback({ code: 'x', state: nonce });
  assert.equal(res.status, 302);
  assert.ok(new URL(res.headers.get('location')!).searchParams.get('code'));
  assert.match(res.headers.get('set-cookie')!, /^__Host-clickup_mcp_auth=; Max-Age=0; Path=\/; HttpOnly; SameSite=Lax; Secure$/);
});

test('the callback rejects unknown, expired and replayed state', async () => {
  await start();
  const client = await registerPublic();
  assert.equal((await callback({ code: 'x', state: 'nope' })).status, 400);
  assert.equal((await callback({ code: 'x' })).status, 400);

  stubClickUp();
  const { nonce } = await startAuthorize(client, 'c');
  assert.equal((await callback({ code: 'x', state: nonce })).status, 302);
  assert.equal((await callback({ code: 'x', state: nonce })).status, 400, 'state is single use');
});

test('an expired pending authorization is rejected', async (t) => {
  await start();
  const client = await registerPublic();
  const { nonce } = await startAuthorize(client, 'c');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 11 * 60 * 1000 });
  assert.equal((await callback({ code: 'x', state: nonce })).status, 400);
});

test('an error from ClickUp is relayed to the client as access_denied with its state', async () => {
  await start();
  const client = await registerPublic();
  const { nonce } = await startAuthorize(client, 'c', 'my-state');
  const res = await callback({ error: 'access_denied', state: nonce });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location')!);
  assert.equal(location.origin + location.pathname, REDIRECT);
  assert.equal(location.searchParams.get('error'), 'access_denied');
  assert.equal(location.searchParams.get('state'), 'my-state');
  assert.equal(location.searchParams.get('code'), null);
});

test('workspace gate: a user without the configured team gets a 403 page and no code', async () => {
  await start('team-required');
  const client = await registerPublic();
  stubClickUp({ teams: [{ id: 'team1', name: 'Other' }] });
  const { nonce } = await startAuthorize(client, 'c');
  const res = await callback({ code: 'x', state: nonce });
  assert.equal(res.status, 403);
  const html = await res.clone().text();
  assert.match(html, /team-required/);
  await assertReturnLink(res, 'access_denied');
});

test('workspace gate: the configured team wins when the user has several', async () => {
  await start('team2');
  const client = await registerPublic();
  const pk = pkce();
  stubClickUp({ teams: [{ id: 'team1', name: 'One' }, { id: 'team2', name: 'Two' }] });
  const { nonce } = await startAuthorize(client, pk.challenge);
  const res = await callback({ code: 'x', state: nonce });
  const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
  const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT);
  const info = await provider.verifyAccessToken(tokens.access_token);
  assert.equal(info.extra?.teamId, 'team2');
});

test('without CLICKUP_TEAM_ID a single team is used and several teams are refused', async () => {
  await start();
  const client = await registerPublic();

  stubClickUp({ teams: [{ id: 'only', name: 'Only' }] });
  let { nonce } = await startAuthorize(client, 'c');
  let res = await callback({ code: 'x', state: nonce });
  assert.equal(res.status, 302);
  const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
  const tokens = await provider.exchangeAuthorizationCode(client, code);
  assert.equal((await provider.verifyAccessToken(tokens.access_token)).extra?.teamId, 'only');

  stubClickUp({ teams: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
  ({ nonce } = await startAuthorize(client, 'c'));
  res = await callback({ code: 'x', state: nonce });
  assert.equal(res.status, 400);
  assert.match(await res.clone().text(), /CLICKUP_TEAM_ID/);
  await assertReturnLink(res, 'server_error');
});

test('a failed ClickUp token exchange shows an error page and issues no code', async () => {
  await start();
  const client = await registerPublic();
  clickup().intercept({ path: /^\/api\/v2\/oauth\/token/, method: 'POST' }).reply(400, { err: 'bad code' });
  const { nonce } = await startAuthorize(client, 'c');
  const res = await callback({ code: 'x', state: nonce });
  assert.equal(res.status, 502);
  await assertReturnLink(res, 'server_error');
});

test('an authorization code is single use', async () => {
  await start();
  const client = await registerPublic();
  const { code } = await authorizeToCode(client, pkce().challenge);
  await provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT);
  await assert.rejects(provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT), /Invalid or expired/);
  await assert.rejects(provider.challengeForAuthorizationCode(client, code), /Invalid or expired/);
});

test('an authorization code is bound to its client', async () => {
  await start();
  const client = await registerPublic();
  const other = await registerPublic();
  const { code } = await authorizeToCode(client, pkce().challenge);
  await assert.rejects(provider.challengeForAuthorizationCode(other, code), /not issued to this client/);
  await assert.rejects(provider.exchangeAuthorizationCode(other, code, undefined, REDIRECT), /not issued to this client/);
  // The failed attempt of another client must not burn the code for its owner
  await provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT);
});

test('an authorization code is bound to its redirect_uri, and a mismatch burns the code', async () => {
  await start();
  const client = await registerPublic();
  const { code } = await authorizeToCode(client, pkce().challenge);
  await assert.rejects(provider.exchangeAuthorizationCode(client, code, undefined, 'http://127.0.0.1:1/other'), /redirect_uri/);
  await assert.rejects(provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT), /Invalid or expired/);
});

test('an authorization code expires after 60 seconds', async (t) => {
  await start();
  const client = await registerPublic();
  const { code } = await authorizeToCode(client, pkce().challenge);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 61_000 });
  await assert.rejects(provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT), /Invalid or expired/);
});

test('challengeForAuthorizationCode returns the stored PKCE challenge', async () => {
  await start();
  const client = await registerPublic();
  const pk = pkce();
  const { code } = await authorizeToCode(client, pk.challenge);
  assert.equal(await provider.challengeForAuthorizationCode(client, code), pk.challenge);
});

test('exchangeAuthorizationCode yields tokens whose access token carries the ClickUp token', async () => {
  await start();
  const client = await registerPublic();
  const { code } = await authorizeToCode(client, pkce().challenge);
  const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT);
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(tokens.expires_in, 3600);
  assert.ok(tokens.refresh_token);
  assert.ok(!tokens.access_token.includes('cu-token-1'));

  const info = await provider.verifyAccessToken(tokens.access_token);
  assert.equal(info.clientId, client.client_id);
  assert.deepEqual(info.scopes, ['clickup']);
  assert.ok(info.expiresAt! > Date.now() / 1000);
  assert.deepEqual(info.extra, {
    clickupToken: 'cu-token-1',
    userId: '42',
    username: 'alice',
    teamId: 'team1',
    userKey: userKeyForToken('cu-token-1'),
  });
});

test('verifyAccessToken rejects garbage, refresh tokens and expired tokens', async (t) => {
  await start();
  const client = await registerPublic();
  const { code } = await authorizeToCode(client, pkce().challenge);
  const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT);
  await assert.rejects(provider.verifyAccessToken('garbage'), /Invalid or expired/);
  await assert.rejects(provider.verifyAccessToken(tokens.refresh_token!), /Invalid or expired/);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 3601_000 });
  await assert.rejects(provider.verifyAccessToken(tokens.access_token), /Invalid or expired/);
});

test('exchangeRefreshToken mints a new pair and rejects refresh tokens of another client', async () => {
  await start();
  const client = await registerPublic();
  const other = await registerPublic();
  const { code } = await authorizeToCode(client, pkce().challenge);
  const first = await provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT);

  const second = await provider.exchangeRefreshToken(client, first.refresh_token!);
  assert.notEqual(second.access_token, first.access_token);
  assert.notEqual(second.refresh_token, first.refresh_token);
  const info = await provider.verifyAccessToken(second.access_token);
  assert.equal(info.extra?.clickupToken, 'cu-token-1');
  assert.equal(info.clientId, client.client_id);

  await assert.rejects(provider.exchangeRefreshToken(other, first.refresh_token!), /not issued to this client/);
  await assert.rejects(provider.exchangeRefreshToken(client, first.access_token), /Invalid or expired/);
  await assert.rejects(provider.exchangeRefreshToken(client, 'garbage'), /Invalid or expired/);
  // A scope parameter at refresh cannot widen the grant: it is ignored
  const narrowed = await provider.exchangeRefreshToken(client, second.refresh_token!, ['admin']);
  assert.equal(narrowed.scope, 'clickup');
});

test('refresh tokens rotate: a used one is rejected and the newly issued one works', async () => {
  await start();
  const client = await registerPublic();
  const { code } = await authorizeToCode(client, pkce().challenge);
  const first = await provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT);

  const second = await provider.exchangeRefreshToken(client, first.refresh_token!);
  await assert.rejects(provider.exchangeRefreshToken(client, first.refresh_token!), /already used/);

  const third = await provider.exchangeRefreshToken(client, second.refresh_token!);
  assert.equal((await provider.verifyAccessToken(third.access_token)).extra?.clickupToken, 'cu-token-1');
  await assert.rejects(provider.exchangeRefreshToken(client, second.refresh_token!), /already used/);
});

test('concurrent exchanges of the same refresh token let only one through', async () => {
  await start();
  const client = await registerPublic();
  const { code } = await authorizeToCode(client, pkce().challenge);
  const { refresh_token } = await provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT);
  const results = await Promise.allSettled([
    provider.exchangeRefreshToken(client, refresh_token!),
    provider.exchangeRefreshToken(client, refresh_token!),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
});

test('used refresh token ids are forgotten once the token would have expired anyway', async (t) => {
  await start();
  const client = await registerPublic();
  const { code } = await authorizeToCode(client, pkce().challenge);
  const { refresh_token } = await provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT);
  await provider.exchangeRefreshToken(client, refresh_token!);
  const used = (provider as any).usedRefreshTokens as Map<string, number>;
  assert.equal(used.size, 1);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 86401_000 });
  (provider as any).sweep();
  assert.equal(used.size, 0);
});
