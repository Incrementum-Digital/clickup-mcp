import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

async function setup(t: any) {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";
  const { registerTaskAdminTools } = await import("../tools/task-admin-tools");
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");
  const tools: Record<string, any> = {};
  registerTaskAdminTools({
    tool: (name: string, _d: string, _s: any, _o: any, handler: any) => { tools[name] = handler; },
  } as any);
  const taskReply = { id: "t1", name: "My Task", list: { id: "L1", name: "Home" } };
  const cleanup = async () => {
    await mockAgent.close();
    t.mock.timers.runAll();
    t.mock.timers.reset();
  };
  return { client, tools, taskReply, cleanup };
}

test("deleteTask refuses without confirm and sends no DELETE", async (t) => {
  const { client, tools, taskReply, cleanup } = await setup(t);
  client.intercept({ path: "/api/v2/task/t1", method: "GET" }).reply(200, taskReply);
  let deleted = false;
  client.intercept({ path: "/api/v2/task/t1", method: "DELETE" }).reply(() => { deleted = true; return { statusCode: 204, data: "" }; });

  const result = await tools.deleteTask({ task_id: "t1", confirm: false });
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("My Task (task_id: t1)"));
  assert.ok(result.content[0].text.includes("(list_id: L1)"));
  assert.equal(deleted, false);
  await cleanup();
});

test("deleteTask deletes with confirm", async (t) => {
  const { client, tools, taskReply, cleanup } = await setup(t);
  client.intercept({ path: "/api/v2/task/t1", method: "GET" }).reply(200, taskReply);
  let deleted = false;
  client.intercept({ path: "/api/v2/task/t1", method: "DELETE" }).reply(() => { deleted = true; return { statusCode: 204, data: "" }; });

  const result = await tools.deleteTask({ task_id: "t1", confirm: true });
  assert.ok(!result.isError);
  assert.equal(deleted, true);
  assert.ok(result.content[0].text.includes("Deleted task: My Task (task_id: t1)"));
  await cleanup();
});

const destList = { id: "L2", name: "Dest", statuses: [{ id: "s1", status: "Open", type: "open" }, { id: "s2", status: "Done", type: "closed" }] };
const taskWithStatus = (status: string) => ({ id: "t1", name: "My Task", list: { id: "L1", name: "Home" }, status: { id: "src1", status } });
const MOVE_PATH = "/api/v3/workspaces/team1/tasks/t1/home_list/L2";

test("moveTask with matching status sends no status_mappings", async (t) => {
  const { client, tools, cleanup } = await setup(t);
  client.intercept({ path: "/api/v2/task/t1", method: "GET" }).reply(200, taskWithStatus("open"));
  client.intercept({ path: "/api/v2/list/L2", method: "GET" }).reply(200, destList);
  let body: any;
  client.intercept({ path: MOVE_PATH, method: "PUT" }).reply((opts) => { body = JSON.parse(String(opts.body)); return { statusCode: 200, data: { data: { task_id: "t1", new_list_id: "L2" } } }; });

  const result = await tools.moveTask({ task_id: "t1", list_id: "L2" });
  assert.ok(!result.isError);
  assert.deepEqual(body, { move_custom_fields: true });
  assert.ok(result.content[0].text.includes("https://app.clickup.com/t/t1"));
  assert.ok(result.content[0].text.includes("Status:"));
  await cleanup();
});

test("moveTask with status mismatch and no status lists destination statuses and sends no PUT", async (t) => {
  const { client, tools, cleanup } = await setup(t);
  client.intercept({ path: "/api/v2/task/t1", method: "GET" }).reply(200, taskWithStatus("in review"));
  client.intercept({ path: "/api/v2/list/L2", method: "GET" }).reply(200, destList);
  let put = false;
  client.intercept({ path: MOVE_PATH, method: "PUT" }).reply(() => { put = true; return { statusCode: 200, data: {} }; });

  const result = await tools.moveTask({ task_id: "t1", list_id: "L2" });
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("Open (status_id: s1)"));
  assert.ok(result.content[0].text.includes("Done (status_id: s2)"));
  assert.equal(put, false);
  await cleanup();
});

test("moveTask with status mismatch and status sends the mapping", async (t) => {
  const { client, tools, cleanup } = await setup(t);
  client.intercept({ path: "/api/v2/task/t1", method: "GET" }).reply(200, taskWithStatus("in review"));
  client.intercept({ path: "/api/v2/list/L2", method: "GET" }).reply(200, destList);
  let body: any;
  client.intercept({ path: MOVE_PATH, method: "PUT" }).reply((opts) => { body = JSON.parse(String(opts.body)); return { statusCode: 200, data: { data: { task_id: "t1", new_list_id: "L2" } } }; });

  const result = await tools.moveTask({ task_id: "t1", list_id: "L2", status: "done", move_custom_fields: false });
  assert.ok(!result.isError);
  assert.deepEqual(body, { move_custom_fields: false, status_mappings: [{ source_status_id: "src1", destination_status_id: "s2" }] });
  await cleanup();
});

test("moveTask stops when the task is already in the target list", async (t) => {
  const { client, tools, cleanup } = await setup(t);
  client.intercept({ path: "/api/v2/task/t1", method: "GET" }).reply(200, taskWithStatus("open"));
  const result = await tools.moveTask({ task_id: "t1", list_id: "L1" });
  assert.ok(!result.isError);
  assert.ok(result.content[0].text.includes("already in list"));
  await cleanup();
});

test("moveTask returns ClickUp's error text when the PUT fails", async (t) => {
  const { client, tools, cleanup } = await setup(t);
  client.intercept({ path: "/api/v2/task/t1", method: "GET" }).reply(200, taskWithStatus("open"));
  client.intercept({ path: "/api/v2/list/L2", method: "GET" }).reply(200, destList);
  client.intercept({ path: MOVE_PATH, method: "PUT" }).reply(400, { err: "Cannot move across spaces" });
  const result = await tools.moveTask({ task_id: "t1", list_id: "L2" });
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("Cannot move across spaces"));
  await cleanup();
});

test("invalid ids are rejected in every tool with no request made", async (t) => {
  const { tools, cleanup } = await setup(t); // no interceptors: any request fails
  for (const bad of ["../list/123", "..", "abc/def", "", "a b"]) {
    for (const [name, args] of [
      ["deleteTask", { task_id: bad, confirm: true }],
      ["moveTask", { task_id: bad, list_id: "L2" }],
      ["moveTask", { task_id: "t1", list_id: bad }],
      ["addTaskToList", { task_id: bad, list_id: "L2" }],
      ["addTaskToList", { task_id: "t1", list_id: bad }],
      ["removeTaskFromList", { task_id: bad, list_id: "L2", confirm: true }],
      ["removeTaskFromList", { task_id: "t1", list_id: bad, confirm: true }],
    ] as [string, any][]) {
      const result = await tools[name](args);
      assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
      assert.ok(result.content[0].text.includes("Invalid"), result.content[0].text);
    }
  }
  await cleanup();
});

test("assertSafeId accepts normal ids", async () => {
  const { assertSafeId } = await import("../shared/ids");
  for (const ok of ["abc123", "ABC-123", "901234"]) assert.equal(assertSafeId(ok, "task_id"), ok);
  assert.equal(assertSafeId(" abc ", "task_id"), "abc");
  for (const bad of ["../list/123", "..", "abc/def", "", "a b"]) assert.throws(() => assertSafeId(bad, "task_id"), /Invalid task_id/);
});

test("addTaskToList returns ClickUp's error plus the ClickApp hint on failure", async (t) => {
  const { client, tools, cleanup } = await setup(t);
  client
    .intercept({ path: "/api/v2/list/L2/task/t1", method: "POST" })
    .reply(400, { err: "Tasks in multiple lists is disabled", ECODE: "X" });

  const result = await tools.addTaskToList({ task_id: "t1", list_id: "L2" });
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("Tasks in multiple lists is disabled"));
  assert.ok(result.content[0].text.includes("Enable the Tasks in Multiple Lists ClickApp for this Space"));
  await cleanup();
});

test("removeTaskFromList refuses to remove the home list", async (t) => {
  const { client, tools, taskReply, cleanup } = await setup(t);
  client.intercept({ path: "/api/v2/task/t1", method: "GET" }).reply(200, taskReply);
  const result = await tools.removeTaskFromList({ task_id: "t1", list_id: "L1", confirm: true });
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes("moveTask"));
  assert.ok(result.content[0].text.includes("deleteTask"));
  await cleanup();
});
