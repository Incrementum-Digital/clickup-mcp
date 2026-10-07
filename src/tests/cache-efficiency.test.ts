import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

async function setup(t: any) {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");
  const cleanup = async () => {
    await mockAgent.close();
    t.mock.timers.runAll(); // expire the caches so the next test starts clean
    t.mock.timers.reset();
  };
  return { client, cleanup };
}

test("searchSpaces uses embedded folder lists without a per-folder request", async (t) => {
  const { client, cleanup } = await setup(t);
  const { registerSpaceTools } = await import("../tools/space-tools");

  client.intercept({ path: "/api/v2/team/team1/space", method: "GET" })
    .reply(200, { spaces: [{ id: "s1", name: "Alpha", archived: false }, { id: "s2", name: "Beta", archived: false }] });
  client.intercept({ path: "/api/v2/space/s1/folder", method: "GET" })
    .reply(200, { folders: [{ id: "f1", name: "Fold", lists: [{ id: "l1", name: "InFolder" }] }] });
  client.intercept({ path: "/api/v2/space/s1/list", method: "GET" }).reply(200, { lists: [] });
  client.intercept({ path: "/api/v3/workspaces/team1/docs?parent_id=s1", method: "GET" }).reply(200, { docs: [] });
  let folderListRequests = 0;
  client.intercept({ path: "/api/v2/folder/f1/list", method: "GET" }).reply(() => {
    folderListRequests++;
    return { statusCode: 200, data: { lists: [] } };
  });

  const tools: Record<string, any> = {};
  registerSpaceTools({ tool: (n: string, _d: string, _s: any, _o: any, h: any) => { tools[n] = h; } } as any);

  const result = await tools.searchSpaces({ terms: ["Alpha"] });
  const text = result.content.map((b: any) => b.text || "").join("\n");
  assert.equal(folderListRequests, 0);
  assert.match(text, /InFolder \(list_id: l1/);
  await cleanup();
});

for (const order of ["members-first", "ids-first"]) {
  test(`getAllTeamMembers and getWorkspaceMembers share one GET /team (${order})`, async (t) => {
    const { client, cleanup } = await setup(t);
    const utils = await import("../shared/utils");
    const members = await import("../shared/members");

    let teamRequests = 0;
    client.intercept({ path: "/api/v2/team", method: "GET" }).reply(() => {
      teamRequests++;
      return { statusCode: 200, data: { teams: [{ id: "team1", members: [{ user: { id: 101, username: "Jane" } }] }] } };
    }).persist();

    if (order === "members-first") {
      assert.equal((await members.getWorkspaceMembers())[0].username, "Jane");
      assert.deepEqual(await utils.getAllTeamMembers(), ["101"]);
    } else {
      assert.deepEqual(await utils.getAllTeamMembers(), ["101"]);
      assert.equal((await members.getWorkspaceMembers())[0].username, "Jane");
    }
    assert.equal(teamRequests, 1);
    await cleanup();
  });
}

test("getAllTeamMembers returns [] instead of throwing when the request fails", async (t) => {
  const { client, cleanup } = await setup(t);
  const utils = await import("../shared/utils");
  client.intercept({ path: "/api/v2/team", method: "GET" }).reply(500, {}).persist();
  assert.deepEqual(await utils.getAllTeamMembers(), []);
  await cleanup();
});

test("getTaskSearchIndex truncates text_content to TEXT_CONTENT_INDEX_CHARS", async (t) => {
  const { client, cleanup } = await setup(t);
  const utils = await import("../shared/utils");

  client.intercept({ path: (p: string) => p.startsWith("/api/v2/team/team1/task"), method: "GET" })
    .reply(200, { tasks: [{ id: "t1", name: "Long", text_content: "x".repeat(5000), date_updated: "1" }], last_page: true })
    .persist();

  const result = await utils.getTaskSearchIndex({});
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].text_content.length, utils.TEXT_CONTENT_INDEX_CHARS);
  await cleanup();
});

test("getSpaceDetails expiry timer of a rejected promise does not evict its replacement", async (t) => {
  const { client, cleanup } = await setup(t);
  const { getSpaceDetails } = await import("../shared/utils");

  client.intercept({ path: "/api/v2/space/sX", method: "GET" }).reply(500, { err: "boom" });
  await getSpaceDetails("sX").catch(() => {});
  t.mock.timers.tick(30000); // the replacement's own timer must expire later than the rejected promise's

  let requests = 0;
  client.intercept({ path: "/api/v2/space/sX", method: "GET" }).reply(() => {
    requests++;
    return { statusCode: 200, data: { id: "sX", name: "Fixed" } };
  }).persist();

  assert.equal((await getSpaceDetails("sX")).name, "Fixed");
  t.mock.timers.tick(30000); // fires only the rejected promise's timer (t=60s)
  assert.equal((await getSpaceDetails("sX")).name, "Fixed");
  assert.equal(requests, 1, "successful entry must survive the first promise's timer");
  await cleanup();
});
