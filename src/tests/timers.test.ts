import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

const BASE = "/api/v2/team/team1/time_entries";

async function setup() {
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";
  const { registerTimeToolsRead, registerTimeToolsWrite } = await import("../tools/time-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (name: string, _d: string, _s: any, _o: any, handler: any) => {
      tools[name] = handler;
    },
  } as any;
  registerTimeToolsRead(serverStub);
  registerTimeToolsWrite(serverStub);
  return { tools, client, mockAgent };
}

test("startTimer refuses when a timer is already running", async () => {
  const { tools, client, mockAgent } = await setup();
  client.intercept({ path: `${BASE}/current`, method: "GET" }).reply(200, {
    data: { id: "e9", task: { id: "task99", name: "Busy task" }, start: String(Date.now() - 3600000), duration: "-1" },
  });
  // No /start interceptor: a POST would fail with disableNetConnect.
  const result = await tools.startTimer({ task_id: "task1" });
  const text = result.content[0].text;
  assert.ok(text.includes("already running"));
  assert.ok(text.includes("stopTimer"));
  assert.ok(text.includes("Busy task"));
  assert.ok(text.includes("task99"));
  assert.ok(text.includes("elapsed: 1h"));
  await mockAgent.close();
});

test("startTimer posts body fields and reports the entry", async () => {
  const { tools, client, mockAgent } = await setup();
  client.intercept({ path: `${BASE}/current`, method: "GET" }).reply(200, { data: null });
  let body: any;
  client.intercept({ path: `${BASE}/start`, method: "POST" }).reply((opts) => {
    body = JSON.parse(String(opts.body));
    return { statusCode: 200, data: { data: { id: "e1", start: "1700000000000", duration: "-1700000000000" } } };
  });
  client.intercept({ path: "/api/v2/task/task1", method: "GET" }).reply(200, { id: "task1", name: "My task" });

  const result = await tools.startTimer({ task_id: "task1", description: "Work", billable: true });
  const text = result.content[0].text;
  assert.deepEqual(body, { tid: "task1", description: "Work", billable: true });
  assert.ok(text.includes("Timer started"));
  assert.ok(text.includes("entry_id: e1"));
  assert.ok(text.includes("My task (task_id: task1)"));
  assert.ok(text.includes("https://app.clickup.com/t/task1"));
  assert.ok(text.includes("description: Work"));
  await mockAgent.close();
});

const RUNNING = { data: { id: "e1", task: { id: "task1", name: "My task" }, start: "1700000000000", duration: "-1" } };

test("stopTimer reports duration as decimal hours and h:mm", async () => {
  const { tools, client, mockAgent } = await setup();
  const start = 1700000000000;
  client.intercept({ path: `${BASE}/current`, method: "GET" }).reply(200, RUNNING);
  client.intercept({ path: `${BASE}/stop`, method: "POST" }).reply(200, {
    data: { id: "e1", task: { id: "task1", name: "My task" }, start: String(start), end: String(start + 5400000), duration: "5400000" },
  });
  const result = await tools.stopTimer({});
  const text = result.content[0].text;
  assert.ok(!result.isError);
  assert.ok(text.includes("Timer stopped"));
  assert.ok(text.includes("duration: 1.50 hours (1:30)"));
  assert.ok(text.includes("entry_id: e1"));
  assert.ok(text.includes("task_id: task1"));
  assert.ok(text.includes("start_time:"));
  assert.ok(text.includes("end_time:"));
  await mockAgent.close();
});

test("stopTimer makes no POST when nothing is running", async () => {
  const { tools, client, mockAgent } = await setup();
  client.intercept({ path: `${BASE}/current`, method: "GET" }).reply(200, { data: null });
  // No /stop interceptor: a POST would fail with disableNetConnect and surface as an error.
  const result = await tools.stopTimer({});
  assert.ok(!result.isError);
  assert.ok(result.content[0].text.includes("No timer running"));
  await mockAgent.close();
});

for (const status of [401, 429]) {
  test(`stopTimer reports ${status} on stop as an error`, async () => {
    const { tools, client, mockAgent } = await setup();
    client.intercept({ path: `${BASE}/current`, method: "GET" }).reply(200, RUNNING);
    client.intercept({ path: `${BASE}/stop`, method: "POST" }).reply(status, { err: `clickup says ${status}` });
    const result = await tools.stopTimer({});
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes(String(status)));
    assert.ok(result.content[0].text.includes(`clickup says ${status}`));
    await mockAgent.close();
  });
}

test("stopTimer reports a failing current-check as an error", async () => {
  const { tools, client, mockAgent } = await setup();
  client.intercept({ path: `${BASE}/current`, method: "GET" }).reply(401, { err: "Oauth token invalid" });
  const result = await tools.stopTimer({});
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("401"));
  await mockAgent.close();
});

test("getRunningTimer reports both states", async () => {
  const { tools, client, mockAgent } = await setup();
  client.intercept({ path: `${BASE}/current`, method: "GET" }).reply(200, { data: null });
  const none = await tools.getRunningTimer({});
  assert.ok(none.content[0].text.includes("No timer running"));

  client.intercept({ path: `${BASE}/current`, method: "GET" }).reply(200, {
    data: { id: "e2", task: { id: "task2", name: "Live task" }, start: String(Date.now() - 7200000), duration: "-1" },
  });
  const running = await tools.getRunningTimer({});
  const text = running.content[0].text;
  assert.ok(text.includes("Timer running"));
  assert.ok(text.includes("Live task (task_id: task2)"));
  assert.ok(text.includes("https://app.clickup.com/t/task2"));
  assert.ok(text.includes("elapsed: 2h"));
  await mockAgent.close();
});
