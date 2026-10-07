import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

async function toolNamesFor(t: any, mode: string): Promise<string[]> {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";
  const { CONFIG } = await import("../shared/config");
  const { createMcpServer } = await import("../server-factory");
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");
  client.intercept({ path: "/api/v2/user", method: "GET" })
    .reply(200, { user: { id: 1, username: "me", email: "me@example.com" } }).persist();
  client.intercept({ path: "/api/v2/team", method: "GET" })
    .reply(200, { teams: [{ id: "team1", name: "T" }] }).persist();
  client.intercept({ path: "/api/v2/team/team1/space", method: "GET" })
    .reply(200, { spaces: [] }).persist();

  const original = CONFIG.mode;
  (CONFIG as any).mode = mode;
  try {
    const server: any = await createMcpServer();
    return Object.keys(server._registeredTools);
  } finally {
    (CONFIG as any).mode = original;
    await mockAgent.close();
    t.mock.timers.runAll();
    t.mock.timers.reset();
  }
}

test("read-minimal registers exactly getTaskById and searchTasks", async (t) => {
  const names = await toolNamesFor(t, "read-minimal");
  assert.deepEqual([...names].sort(), ["getTaskById", "searchTasks"]);
});

test("read and write modes include getTimeInStatus", async (t) => {
  assert.ok((await toolNamesFor(t, "read")).includes("getTimeInStatus"));
  const write = await toolNamesFor(t, "write");
  assert.ok(write.includes("getTimeInStatus"));
  assert.ok(write.includes("deleteComment") && write.includes("mergeTasks"));
});
