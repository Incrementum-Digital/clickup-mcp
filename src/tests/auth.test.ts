import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';

const ENV_KEYS = [
  'CLICKUP_API_KEY',
  'CLICKUP_TEAM_ID',
  'CLICKUP_CLIENT_ID',
  'CLICKUP_CLIENT_SECRET',
  'CLICKUP_OAUTH_PORT',
  'CLICKUP_TOKEN_FILE',
];

let tmpDir: string;
let tokenFile: string;
let mockAgent: MockAgent;

/** Fresh copies of config.ts and auth.ts so module-level state (credentials, promise cache) starts clean. */
async function loadAuth() {
  for (const mod of ['../shared/config', '../shared/auth']) {
    delete require.cache[require.resolve(mod)];
  }
  const auth = await import('../shared/auth');
  const config = await import('../shared/config');
  return { auth, config };
}

function clickup() {
  return mockAgent.get('https://api.clickup.com');
}

beforeEach(async () => {
  for (const key of ENV_KEYS) delete process.env[key];
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clickup-auth-test-'));
  tokenFile = path.join(tmpDir, 'nested', 'token.json');
  process.env.CLICKUP_TOKEN_FILE = tokenFile;
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  await mockAgent.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) delete process.env[key];
  // Other test files expect these values
  process.env.CLICKUP_API_KEY = 'test-key';
  process.env.CLICKUP_TEAM_ID = 'team1';
});

function assertPortClosed(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`port ${port} is still listening`));
    });
    socket.once('error', () => resolve());
  });
}

/**
 * Builds an openBrowser stub that simulates the browser: it reads redirect_uri and state
 * from the authorize URL and hits the loopback callback with the given query.
 */
function fakeBrowser(
  buildQuery: (state: string) => Record<string, string>,
  seen: { port?: number; authorizeUrl?: URL; response?: Promise<{ status: number; body: string }> } = {}
) {
  return (url: string) => {
    const authorizeUrl = new URL(url);
    const redirect = new URL(authorizeUrl.searchParams.get('redirect_uri')!);
    const state = authorizeUrl.searchParams.get('state')!;
    seen.authorizeUrl = authorizeUrl;
    seen.port = Number(redirect.port);
    // The server binds 127.0.0.1 only; skip DNS for `localhost` in the test client.
    const callback = new URL(`http://127.0.0.1:${redirect.port}${redirect.pathname}`);
    for (const [k, v] of Object.entries(buildQuery(state))) callback.searchParams.set(k, v);
    seen.response = fetch(callback.toString()).then(async (r) => ({ status: r.status, body: await r.text() }));
  };
}

test('formatAuthHeader sends pk_ tokens raw and everything else as Bearer', async () => {
  const { auth } = await loadAuth();
  assert.equal(auth.formatAuthHeader('pk_123_ABC'), 'pk_123_ABC');
  assert.equal(auth.formatAuthHeader('oauthtoken123'), 'Bearer oauthtoken123');
});

test('ensureCredentials prefers the env token and env team without network access', async () => {
  process.env.CLICKUP_API_KEY = 'pk_env';
  process.env.CLICKUP_TEAM_ID = 'env-team';
  // A stored token must not win over the env token
  await fs.mkdir(path.dirname(tokenFile), { recursive: true });
  await fs.writeFile(tokenFile, JSON.stringify({ client_id: 'c', access_token: 'stored', created_at: 'x' }));

  const { auth, config } = await loadAuth();
  const creds = await auth.ensureCredentials();
  assert.deepEqual(creds, { token: 'pk_env', teamId: 'env-team' });
  assert.equal(config.CONFIG.apiKey, 'pk_env');
  assert.equal(config.CONFIG.teamId, 'env-team');
  assert.equal(config.CONFIG.authHeader, 'pk_env');
  // Concurrent/repeated calls share one promise
  assert.equal(auth.ensureCredentials(), auth.ensureCredentials());
});

test('CONFIG throws a clear error while credentials are unresolved', async () => {
  const { config } = await loadAuth();
  assert.throws(() => config.CONFIG.apiKey, /credentials not resolved/);
  assert.throws(() => config.CONFIG.authHeader, /credentials not resolved/);
});

test('ensureCredentials uses the token file when no env token is set, as a Bearer header', async () => {
  process.env.CLICKUP_TEAM_ID = 'team9';
  await fs.mkdir(path.dirname(tokenFile), { recursive: true });
  await fs.writeFile(
    tokenFile,
    JSON.stringify({ client_id: 'cid', access_token: 'stored-oauth', created_at: new Date().toISOString() })
  );

  const { auth, config } = await loadAuth();
  const creds = await auth.ensureCredentials();
  assert.deepEqual(creds, { token: 'stored-oauth', teamId: 'team9' });
  assert.equal(config.CONFIG.authHeader, 'Bearer stored-oauth');
});

test('a token file for a different client id is not used', async () => {
  process.env.CLICKUP_TEAM_ID = 'team9';
  process.env.CLICKUP_CLIENT_ID = 'other-client';
  await fs.mkdir(path.dirname(tokenFile), { recursive: true });
  await fs.writeFile(tokenFile, JSON.stringify({ client_id: 'cid', access_token: 'stored', created_at: 'x' }));

  const { auth } = await loadAuth();
  // No client secret, so the OAuth flow is not available either
  await assert.rejects(auth.ensureCredentials(), /CLICKUP_API_KEY[\s\S]*CLICKUP_CLIENT_ID/);
});

test('ensureCredentials explains the options when nothing is configured', async () => {
  const { auth } = await loadAuth();
  await assert.rejects(
    auth.ensureCredentials(),
    /CLICKUP_API_KEY[\s\S]*CLICKUP_CLIENT_ID[\s\S]*CLICKUP_CLIENT_SECRET[\s\S]*auth/
  );
});

test('team auto-detection succeeds with exactly one workspace', async () => {
  process.env.CLICKUP_API_KEY = 'pk_env';
  clickup()
    .intercept({ path: '/api/v2/team', method: 'GET', headers: { authorization: 'pk_env' } })
    .reply(200, { teams: [{ id: '123', name: 'Only Team' }] });

  const { auth, config } = await loadAuth();
  const creds = await auth.ensureCredentials();
  assert.equal(creds.teamId, '123');
  assert.equal(config.CONFIG.teamId, '123');
});

test('team auto-detection throws and lists every workspace when there are several', async () => {
  process.env.CLICKUP_API_KEY = 'oauth-token';
  clickup()
    .intercept({ path: '/api/v2/team', method: 'GET', headers: { authorization: 'Bearer oauth-token' } })
    .reply(200, { teams: [{ id: '111', name: 'Alpha' }, { id: '222', name: 'Beta' }] });

  const { auth } = await loadAuth();
  await assert.rejects(auth.ensureCredentials(), (error: Error) => {
    assert.match(error.message, /Alpha \(team_id: 111\)/);
    assert.match(error.message, /Beta \(team_id: 222\)/);
    assert.match(error.message, /CLICKUP_TEAM_ID/);
    return true;
  });
});

test('team auto-detection throws when no workspace is authorized', async () => {
  process.env.CLICKUP_API_KEY = 'pk_env';
  clickup().intercept({ path: '/api/v2/team', method: 'GET' }).reply(200, { teams: [] });
  const { auth } = await loadAuth();
  await assert.rejects(auth.ensureCredentials(), /no authorized workspaces/);
});

test('runOAuthFlow exchanges the code, writes the token file and closes the server', async () => {
  mockAgent.enableNetConnect(/127\.0\.0\.1|localhost/);
  let exchange: { path: string; method: string; body: any } | undefined;
  clickup()
    .intercept({ path: /^\/api\/v2\/oauth\/token/, method: 'POST' })
    .reply(200, (opts: any) => {
      exchange = { path: opts.path, method: opts.method, body: JSON.parse(String(opts.body)) };
      return { access_token: 'new-oauth-token' };
    });

  const { auth } = await loadAuth();
  const seen: Parameters<typeof fakeBrowser>[1] = {};
  const token = await auth.runOAuthFlow({
    port: 0,
    clientId: 'my-client',
    clientSecret: 'my-secret',
    tokenFile,
    openBrowser: fakeBrowser((state) => ({ code: 'the-code', state }), seen),
  });

  assert.equal(token, 'new-oauth-token');

  // Authorize URL
  assert.equal(seen.authorizeUrl!.origin + seen.authorizeUrl!.pathname, 'https://app.clickup.com/api');
  assert.equal(seen.authorizeUrl!.searchParams.get('client_id'), 'my-client');
  assert.equal(seen.authorizeUrl!.searchParams.get('redirect_uri'), `http://localhost:${seen.port}/callback`);

  // Browser got a friendly page
  const page = await seen.response!;
  assert.equal(page.status, 200);
  assert.match(page.body, /Authorized\. You can close this tab\./);

  // The first exchange attempt keeps the secret out of the URL: JSON body only, no query string
  assert.ok(exchange);
  assert.equal(exchange.method, 'POST');
  assert.equal(exchange.path, '/api/v2/oauth/token');
  assert.deepEqual(exchange.body, { client_id: 'my-client', client_secret: 'my-secret', code: 'the-code' });

  // Token file
  const stored = JSON.parse(await fs.readFile(tokenFile, 'utf8'));
  assert.equal(stored.client_id, 'my-client');
  assert.equal(stored.access_token, 'new-oauth-token');
  assert.ok(!Number.isNaN(Date.parse(stored.created_at)));
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(tokenFile)).mode & 0o777, 0o600);
  }

  await assertPortClosed(seen.port!);

  // And the stored token is picked up on the next start
  process.env.CLICKUP_TEAM_ID = 'team1';
  const second = await loadAuth();
  assert.deepEqual(await second.auth.ensureCredentials(), { token: 'new-oauth-token', teamId: 'team1' });
});

test('runOAuthFlow ignores callbacks with a wrong state and still completes with the right one', async () => {
  mockAgent.enableNetConnect(/127\.0\.0\.1|localhost/);
  clickup()
    .intercept({ path: /^\/api\/v2\/oauth\/token/, method: 'POST' })
    .reply(200, { access_token: 'real-token' });
  const { auth } = await loadAuth();
  const statuses: number[] = [];
  let port = 0;
  let last: Promise<Response> | undefined;
  const token = await auth.runOAuthFlow({
    port: 0,
    clientId: 'c',
    clientSecret: 's',
    tokenFile,
    openBrowser: async (url: string) => {
      const authorizeUrl = new URL(url);
      const redirect = new URL(authorizeUrl.searchParams.get('redirect_uri')!);
      port = Number(redirect.port);
      const callback = (query: Record<string, string>) => {
        const u = new URL(`http://127.0.0.1:${port}${redirect.pathname}`);
        for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
        return fetch(u.toString());
      };
      // Stray requests: wrong state, missing state, and a forged error. None may settle the flow.
      statuses.push((await callback({ code: 'x', state: 'not-the-state' })).status);
      statuses.push((await callback({ code: 'x' })).status);
      statuses.push((await callback({ error: 'access_denied', state: 'not-the-state' })).status);
      statuses.push((await callback({ error: 'access_denied' })).status);
      last = callback({ code: 'the-code', state: authorizeUrl.searchParams.get('state')! });
    },
  });
  statuses.push((await last!).status);
  assert.deepEqual(statuses, [400, 400, 400, 400, 200]);
  assert.equal(token, 'real-token');
  assert.equal(JSON.parse(await fs.readFile(tokenFile, 'utf8')).access_token, 'real-token');
  await assertPortClosed(port);
});

test('runOAuthFlow rejects when ClickUp reports an error', async () => {
  mockAgent.enableNetConnect(/127\.0\.0\.1|localhost/);
  const { auth } = await loadAuth();
  const seen: Parameters<typeof fakeBrowser>[1] = {};
  await assert.rejects(
    auth.runOAuthFlow({
      port: 0,
      clientId: 'c',
      clientSecret: 's',
      tokenFile,
      openBrowser: fakeBrowser((state) => ({ error: 'access_denied', state }), seen),
    }),
    /access_denied/
  );
  await assertPortClosed(seen.port!);
});

test('runOAuthFlow reports status and body when the token exchange fails', async () => {
  mockAgent.enableNetConnect(/127\.0\.0\.1|localhost/);
  clickup()
    .intercept({ path: /^\/api\/v2\/oauth\/token/, method: 'POST' })
    .reply(400, { err: 'Code invalid', ECODE: 'OAUTH_030' })
    .times(3); // json, form and query attempts

  const { auth } = await loadAuth();
  const seen: Parameters<typeof fakeBrowser>[1] = {};
  await assert.rejects(
    auth.runOAuthFlow({
      port: 0,
      clientId: 'c',
      clientSecret: 's',
      tokenFile,
      openBrowser: fakeBrowser((state) => ({ code: 'bad', state }), seen),
    }),
    /400[\s\S]*OAUTH_030/
  );
  await assert.rejects(fs.stat(tokenFile), { code: 'ENOENT' });
  await assertPortClosed(seen.port!);
});

test('exchangeClickUpCode falls back from JSON to a form body to query params, warning about the last one', async () => {
  const seen: { path: string; contentType: string; body: string }[] = [];
  const record = (opts: any) => {
    seen.push({
      path: opts.path,
      contentType: String(opts.headers?.['content-type'] ?? opts.headers?.['Content-Type'] ?? ''),
      body: String(opts.body ?? ''),
    });
  };
  clickup()
    .intercept({ path: /^\/api\/v2\/oauth\/token/, method: 'POST' })
    .reply(400, (opts: any) => { record(opts); return { err: 'nope' }; })
    .times(2);
  clickup()
    .intercept({ path: /^\/api\/v2\/oauth\/token/, method: 'POST' })
    .reply(200, (opts: any) => { record(opts); return { access_token: 'fallback-token' }; });

  const { auth } = await loadAuth();
  const warnings: string[] = [];
  const originalError = console.error;
  console.error = (...args: any[]) => { warnings.push(args.join(' ')); };
  let token: string;
  try {
    token = await auth.exchangeClickUpCode(fetch, 'cid', 'csecret', 'ccode');
  } finally {
    console.error = originalError;
  }
  assert.equal(token, 'fallback-token');
  assert.equal(seen.length, 3);
  assert.equal(seen[0].path, '/api/v2/oauth/token');
  assert.match(seen[0].contentType, /application\/json/);
  assert.deepEqual(JSON.parse(seen[0].body), { client_id: 'cid', client_secret: 'csecret', code: 'ccode' });
  assert.equal(seen[1].path, '/api/v2/oauth/token');
  assert.match(seen[1].contentType, /application\/x-www-form-urlencoded/);
  assert.equal(new URLSearchParams(seen[1].body).get('client_secret'), 'csecret');
  assert.equal(new URL(seen[2].path, 'https://api.clickup.com').searchParams.get('client_secret'), 'csecret');
  assert.equal(warnings.filter((w) => /query string/.test(w)).length, 1);
});

test('exchangeClickUpCode does not retry on a server error', async () => {
  clickup().intercept({ path: /^\/api\/v2\/oauth\/token/, method: 'POST' }).reply(500, 'boom');
  const { auth } = await loadAuth();
  await assert.rejects(auth.exchangeClickUpCode(fetch, 'cid', 'csecret', 'ccode'), /500 boom/);
});

test('runOAuthFlow times out and closes the server', async () => {
  const { auth } = await loadAuth();
  const seen: Parameters<typeof fakeBrowser>[1] = {};
  await assert.rejects(
    auth.runOAuthFlow({
      port: 0,
      clientId: 'c',
      clientSecret: 's',
      tokenFile,
      timeoutMs: 50,
      openBrowser: (url) => {
        seen.port = Number(new URL(new URL(url).searchParams.get('redirect_uri')!).port);
      },
    }),
    /Timed out/
  );
  await assertPortClosed(seen.port!);
});

test('runOAuthFlow requires client id and secret', async () => {
  const { auth } = await loadAuth();
  await assert.rejects(auth.runOAuthFlow({ port: 0, tokenFile }), /CLICKUP_CLIENT_ID/);
});

test('logout removes the token file and reports whether anything was removed', async () => {
  await fs.mkdir(path.dirname(tokenFile), { recursive: true });
  await fs.writeFile(tokenFile, '{}');
  const { auth } = await loadAuth();
  assert.equal(auth.logout(), true);
  assert.equal(auth.logout(), false);
});
