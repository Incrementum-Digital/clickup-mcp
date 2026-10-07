import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

test("searchSpaces fetches spaces and related content", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerSpaceTools } = await import("../tools/space-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client
    .intercept({ path: "/api/v2/team/team1/space", method: "GET" })
    .reply(200, {
      spaces: [
        { id: "s1", name: "Alpha", archived: false },
        { id: "s2", name: "Beta", archived: false },
      ],
    });

  // Content fetches for space s1 (only matching space)
  client
    .intercept({ path: "/api/v2/space/s1/folder", method: "GET" })
    .reply(200, { folders: [] });
  client
    .intercept({ path: "/api/v2/space/s1/list", method: "GET" })
    .reply(200, { lists: [] });
  client
    .intercept({
      path: "/api/v3/workspaces/team1/docs?parent_id=s1",
      method: "GET",
    })
    .reply(200, { docs: [] });

  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (
      name: string,
      _desc: string,
      _schema: any,
      _opts: any,
      handler: any,
    ) => {
      tools[name] = handler;
    },
  } as any;

  registerSpaceTools(serverStub);

  const result = await tools.searchSpaces({ terms: ["Alpha"] });
  const text = result.content.map((b: any) => b.text || "").join("\n");
  assert.ok(text.includes("SPACE: Alpha"));

  await mockAgent.close();
  t.mock.timers.runAll(); // expire the caches so the next test starts clean
  t.mock.timers.reset();
});

test("searchSpaces without terms expands spaces within the request budget and flags a partial result", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerSpaceTools } = await import("../tools/space-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  const spaces = Array.from({ length: 25 }, (_, i) => ({ id: `s${i + 1}`, name: `Space${i + 1}`, archived: false }));
  spaces.push({ id: "sx", name: "Gone", archived: true });
  let requests = 0;
  client.intercept({ path: "/api/v2/team/team1/space", method: "GET" }).reply(() => {
    requests++;
    return { statusCode: 200, data: { spaces } };
  });
  for (let i = 1; i <= 19; i++) {
    client.intercept({ path: `/api/v2/space/s${i}/folder`, method: "GET" }).reply(() => {
      requests++;
      return { statusCode: 200, data: { folders: i === 1 ? [{ id: "f1", name: "Fold", lists: [{ id: "l1", name: "InFolder" }] }] : [] } };
    });
    client.intercept({ path: `/api/v2/space/s${i}/list`, method: "GET" }).reply(() => {
      requests++;
      return { statusCode: 200, data: { lists: i === 1 ? [{ id: "l2", name: "Loose" }] : [] } };
    });
  }

  const tools: Record<string, any> = {};
  registerSpaceTools({ tool: (n: string, _d: string, _s: any, _o: any, h: any) => { tools[n] = h; } } as any);

  const result = await tools.searchSpaces({});
  const text = result.content.map((b: any) => b.text || "").join("\n");
  assert.equal(requests, 39); // 1 space list + 2 x 19 spaces, never above the budget of 40
  assert.match(text, /PARTIAL result/);
  assert.match(text, /searchDocuments/);
  assert.match(text, /WITHOUT their folders and lists \(6\)/);
  assert.match(text, /space_id: s1\b/);
  assert.match(text, /folder_id: f1/);
  assert.match(text, /InFolder \(list_id: l1/);
  assert.match(text, /Loose \(list_id: l2/);
  assert.match(text, /Space20 \(space_id: s20\).*contents not loaded/);
  assert.match(text, /Space25 \(space_id: s25\).*contents not loaded/);
  assert.ok(!text.includes("Gone"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});
