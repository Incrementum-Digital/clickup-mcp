import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

async function setup(t: any) {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";
  const { registerTaskToolsExtra } = await import("../tools/task-tools");
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");
  const tools: Record<string, any> = {};
  registerTaskToolsExtra({
    tool: (name: string, _d: string, _s: any, _o: any, handler: any) => { tools[name] = handler; },
  } as any);
  const cleanup = async () => {
    await mockAgent.close();
    t.mock.timers.reset();
  };
  return { client, tools, cleanup };
}

const shape = (current: number, history: [string, number][]) => ({
  current_status: { status: "in progress", color: "#fff", total_time: { by_minute: current, since: "1700000000000" } },
  status_history: history.map(([status, m], i) => ({
    status, color: "#000", type: "custom", orderindex: i, total_time: { by_minute: m, since: "1690000000000" },
  })),
});

test("getTimeInStatus with one id uses the single endpoint and formats minutes", async (t) => {
  const { client, tools, cleanup } = await setup(t);
  client.intercept({ path: "/api/v2/task/abc123/time_in_status", method: "GET" })
    .reply(200, shape(1500, [["open", 45], ["review", 0], ["blocked", 1440 + 120 + 5]]));

  const result = await tools.getTimeInStatus({ task_ids: ["abc123"] });
  assert.ok(!result.isError);
  const text = result.content[0].text;
  assert.ok(text.includes("task_id: abc123"));
  assert.ok(text.includes("Current status: in progress - 1d 1h 0m"));
  assert.ok(text.includes("1. open - 45m"));
  assert.ok(text.includes("2. review - 0m"));
  assert.ok(text.includes("3. blocked - 1d 2h 5m"));
  assert.ok(text.indexOf("1. open") < text.indexOf("3. blocked"));
  await cleanup();
});

test("getTimeInStatus with several ids uses the bulk endpoint with repeated task_ids", async (t) => {
  const { client, tools, cleanup } = await setup(t);
  let path = "";
  client.intercept({ path: /\/api\/v2\/task\/bulk_time_in_status\/task_ids.*/, method: "GET" })
    .reply((opts) => {
      path = String(opts.path);
      return { statusCode: 200, data: { aaa111: shape(90, [["open", 10]]), bbb222: shape(5, []) } };
    });

  const result = await tools.getTimeInStatus({ task_ids: ["aaa111", "bbb222"] });
  assert.ok(!result.isError);
  assert.equal(path, "/api/v2/task/bulk_time_in_status/task_ids?task_ids=aaa111&task_ids=bbb222");
  const text = result.content[0].text;
  assert.ok(text.includes("task_id: aaa111"));
  assert.ok(text.includes("task_id: bbb222"));
  assert.ok(text.includes("Current status: in progress - 1h 30m"));
  assert.ok(text.includes("History: none recorded"));
  await cleanup();
});

test("getTimeInStatus rejects unsafe ids without any request", async (t) => {
  const { tools, cleanup } = await setup(t);
  const result = await tools.getTimeInStatus({ task_ids: ["../x"] });
  assert.equal(result.isError, true);
  await cleanup();
});
