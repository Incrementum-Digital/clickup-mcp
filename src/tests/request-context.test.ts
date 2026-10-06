import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

process.env.CLICKUP_API_KEY = "test-key";
process.env.CLICKUP_TEAM_ID = "team1";

function creds(token: string, teamId: string, userKeyOf: (t: string) => string) {
  return { token, teamId, userKey: userKeyOf(token) };
}

test("CONFIG reflects the request credentials inside runWithCredentials and the env outside", async () => {
  const { CONFIG } = await import("../shared/config");
  const { runWithCredentials, userKeyForToken } = await import("../shared/request-context");

  assert.equal(CONFIG.apiKey, "test-key");
  assert.equal(CONFIG.teamId, "team1");
  assert.equal(CONFIG.authHeader, "Bearer test-key");

  runWithCredentials(creds("oauth-token", "team-ctx", userKeyForToken), () => {
    assert.equal(CONFIG.apiKey, "oauth-token");
    assert.equal(CONFIG.teamId, "team-ctx");
    assert.equal(CONFIG.authHeader, "Bearer oauth-token");
  });

  // Personal tokens are sent raw, also from the request context
  runWithCredentials(creds("pk_personal", "team-ctx", userKeyForToken), () => {
    assert.equal(CONFIG.authHeader, "pk_personal");
  });

  assert.equal(CONFIG.apiKey, "test-key");
  assert.equal(CONFIG.teamId, "team1");
  assert.equal(CONFIG.authHeader, "Bearer test-key");
});

test("interleaved async contexts only see their own credentials", async () => {
  const { CONFIG } = await import("../shared/config");
  const { runWithCredentials, userKeyForToken } = await import("../shared/request-context");

  const observed: Record<string, string[]> = { A: [], B: [] };
  const run = (name: string, token: string, teamId: string) =>
    runWithCredentials(creds(token, teamId, userKeyForToken), async () => {
      for (let i = 0; i < 3; i++) {
        observed[name].push(`${CONFIG.apiKey}/${CONFIG.teamId}/${CONFIG.authHeader}`);
        await new Promise(setImmediate);
      }
    });

  await Promise.all([run("A", "token-a", "team-a"), run("B", "token-b", "team-b")]);

  assert.deepEqual(observed.A, Array(3).fill("token-a/team-a/Bearer token-a"));
  assert.deepEqual(observed.B, Array(3).fill("token-b/team-b/Bearer token-b"));
});

test("getCurrentUser caches per credential context", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { runWithCredentials, userKeyForToken } = await import("../shared/request-context");
  const { getCurrentUser } = await import("../shared/utils");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  const seenAuth: string[] = [];
  const intercept = (auth: string, id: number) =>
    client
      .intercept({ path: "/api/v2/user", method: "GET", headers: { authorization: auth } })
      .reply(200, (opts: any) => {
        seenAuth.push(opts.headers.authorization ?? opts.headers.Authorization);
        return { user: { id, username: `user${id}` } };
      });
  intercept("Bearer token-a", 1);
  intercept("Bearer token-b", 2);

  const as = (token: string) => (fn: () => Promise<any>) =>
    runWithCredentials(creds(token, "team1", userKeyForToken), fn);

  const a1 = await as("token-a")(() => getCurrentUser());
  const b1 = await as("token-b")(() => getCurrentUser());
  // Same contexts again: served from the per-user cache, no new requests (net connect is disabled
  // and every interceptor is already consumed, so a second request would throw)
  const a2 = await as("token-a")(() => getCurrentUser());
  const [b2, b3] = await Promise.all([
    as("token-b")(() => getCurrentUser()),
    as("token-b")(() => getCurrentUser()),
  ]);

  assert.equal(a1.user.username, "user1");
  assert.equal(b1.user.username, "user2");
  assert.equal(a2.user.username, "user1");
  assert.equal(b2.user.username, "user2");
  assert.equal(b3.user.username, "user2");
  assert.deepEqual(seenAuth, ["Bearer token-a", "Bearer token-b"]);

  // Entries still expire per user after the refresh interval
  t.mock.timers.tick(60000);
  intercept("Bearer token-a", 1);
  await as("token-a")(() => getCurrentUser());
  assert.deepEqual(seenAuth, ["Bearer token-a", "Bearer token-b", "Bearer token-a"]);

  await mockAgent.close();
});

test("cache key is 'stdio' outside a context and a per-token hex hash inside", async () => {
  const { credentialCacheKey, userKeyForToken, runWithCredentials, getRequestCredentials } =
    await import("../shared/request-context");

  assert.equal(credentialCacheKey(), "stdio");
  assert.equal(getRequestCredentials(), undefined);

  const keyA = userKeyForToken("token-a");
  const keyB = userKeyForToken("token-b");
  assert.match(keyA, /^[0-9a-f]{32}$/);
  assert.match(keyB, /^[0-9a-f]{32}$/);
  assert.notEqual(keyA, keyB);
  assert.equal(keyA, userKeyForToken("token-a"));
  assert.ok(!keyA.includes("token-a"));

  runWithCredentials({ token: "token-a", teamId: "t", userKey: keyA }, () => {
    assert.equal(credentialCacheKey(), keyA);
    assert.equal(getRequestCredentials()?.teamId, "t");
  });
  assert.equal(credentialCacheKey(), "stdio");
});
