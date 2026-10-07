import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

async function setup(t: any) {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";
  const { registerDocumentToolsRead } = await import("../tools/doc-tools");
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");
  const tools: Record<string, any> = {};
  registerDocumentToolsRead({
    tool: (name: string, _d: any, _s: any, _o: any, handler: any) => {
      tools[name] = handler;
    },
  } as any);
  const run = async (args: any) =>
    (await tools.searchDocuments(args)).content.map((b: any) => b.text || "").join("\n");
  return { mockAgent, client, run };
}

const doc = (id: string, name: string, parentId = "s1") => ({
  id,
  name,
  date_created: 1700000000000,
  date_updated: 1700100000000,
  parent: { id: parentId, type: 4 },
});

test("searchDocuments paginates, fuzzy matches across terms, includes ids and URLs", async (t) => {
  const { mockAgent, client, run } = await setup(t);
  const base = "/api/v3/workspaces/team1/docs";
  client.intercept({ path: `${base}?limit=100`, method: "GET" })
    .reply(200, { docs: [doc("d1", "Onboarding Guide"), doc("d2", "Budget 2026")], next_cursor: "abc" });
  client.intercept({ path: `${base}?limit=100&next_cursor=abc`, method: "GET" })
    .reply(200, { docs: [doc("d3", "Meeting Notes")] });
  client.intercept({ path: "/api/v2/team/team1/space", method: "GET" })
    .reply(200, { spaces: [{ id: "s1", name: "Alpha" }] });

  const text = await run({ terms: ["Onboarding", "Budget"] });
  assert.ok(text.includes("Onboarding Guide (doc_id: d1)"));
  assert.ok(text.includes("Budget 2026 (doc_id: d2)"));
  assert.ok(!text.includes("Meeting Notes"));
  assert.ok(text.includes("https://app.clickup.com/team1/v/dc/d1"));
  assert.ok(text.includes("Space: Alpha (space_id: s1)"));
  assert.ok(text.includes("readDocument"));

  // Second call within 60 s: no further requests (net connect is disabled and no intercepts remain)
  const again = await run({ terms: ["Meeting"] });
  assert.ok(again.includes("Meeting Notes (doc_id: d3)"));

  await mockAgent.close();
  t.mock.timers.tick(60001); // expire caches for the next test
  t.mock.timers.reset();
});

test("searchDocuments stops at the page cap and says so", async (t) => {
  const { mockAgent, client, run } = await setup(t);
  const base = "/api/v3/workspaces/team1/docs";
  for (let i = 0; i < 10; i++) {
    const path = i === 0 ? `${base}?limit=100` : `${base}?limit=100&next_cursor=c${i}`;
    client.intercept({ path, method: "GET" })
      .reply(200, { docs: [doc(`p${i}`, `Page doc ${i}`)], next_cursor: `c${i + 1}` });
  }
  const text = await run({ terms: ["Page doc"], limit: 50 });
  assert.ok(text.includes("stopped after 10 pages"));
  assert.ok(text.includes("(doc_id: p9)"));
  mockAgent.assertNoPendingInterceptors();

  await mockAgent.close();
  t.mock.timers.tick(60001); // expire caches for the next test
  t.mock.timers.reset();
});

test("searchDocuments filters by space_id", async (t) => {
  const { mockAgent, client, run } = await setup(t);
  client
    .intercept({
      path: "/api/v3/workspaces/team1/docs?limit=100&parent_id=s9&parent_type=SPACE",
      method: "GET",
    })
    .reply(200, { docs: [doc("x1", "Roadmap", "s9"), doc("x2", "Roadmap Old", "other")] });
  client.intercept({ path: "/api/v2/team/team1/space", method: "GET" })
    .reply(200, { spaces: [{ id: "s9", name: "Nine" }] });

  const text = await run({ terms: ["Roadmap"], space_id: "s9" });
  assert.ok(text.includes("(doc_id: x1)"));
  assert.ok(!text.includes("(doc_id: x2)"));

  const bad = await run({ terms: ["Roadmap"], space_id: "../x" });
  assert.ok(bad.includes("Invalid space_id"));

  await mockAgent.close();
  t.mock.timers.tick(60001); // expire caches for the next test
  t.mock.timers.reset();
});
