import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

async function setup(t: any) {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";
  const mod = await import("../tools/hierarchy-tools");
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
  mod.registerHierarchyToolsRead(serverStub);
  mod.registerHierarchyToolsWrite(serverStub);
  const cleanup = async () => {
    await mockAgent.close();
    t.mock.timers.runAll();
    t.mock.timers.reset();
  };
  return { client, tools, cleanup };
}

test("getFolder lists the space and lists with ids", async (t) => {
  const { client, tools, cleanup } = await setup(t);
  client.intercept({ path: "/api/v2/folder/f1", method: "GET" }).reply(200, {
    id: "f1", name: "Folder One", hidden: false, space: { id: "s1", name: "Space" },
    lists: [{ id: "l1", name: "Backlog", task_count: 7 }],
  });
  const result = await tools.getFolder({ folder_id: "f1" });
  const text = result.content[0].text;
  assert.match(text, /Folder One \(folder_id: f1\)/);
  assert.match(text, /Space \(space_id: s1\)/);
  assert.match(text, /Backlog \(list_id: l1\) task_count=7 https:\/\/app\.clickup\.com\/team1\/v\/li\/l1/);
  await cleanup();
});

test("createFolder posts the name to the space", async (t) => {
  const { client, tools, cleanup } = await setup(t);
  let body: any;
  client.intercept({ path: "/api/v2/space/s1/folder", method: "POST" }).reply((opts) => {
    body = JSON.parse(String(opts.body));
    return { statusCode: 200, data: { id: "f9", name: "New", space: { id: "s1", name: "Space" } } };
  });
  const result = await tools.createFolder({ space_id: "s1", name: "New" });
  assert.deepEqual(body, { name: "New" });
  assert.match(result.content[0].text, /New \(folder_id: f9\)/);
  await cleanup();
});

test("updateFolder puts the new name", async (t) => {
  const { client, tools, cleanup } = await setup(t);
  let body: any;
  client.intercept({ path: "/api/v2/folder/f1", method: "PUT" }).reply((opts) => {
    body = JSON.parse(String(opts.body));
    return { statusCode: 200, data: { id: "f1", name: "Renamed" } };
  });
  const result = await tools.updateFolder({ folder_id: "f1", name: "Renamed" });
  assert.deepEqual(body, { name: "Renamed" });
  assert.match(result.content[0].text, /Renamed \(folder_id: f1\)/);
  await cleanup();
});

test("createList in a folder and in a space", async (t) => {
  const { client, tools, cleanup } = await setup(t);
  const bodies: any[] = [];
  const reply = (opts: any) => {
    bodies.push(JSON.parse(String(opts.body)));
    return {
      statusCode: 200,
      data: { id: "l5", name: "L", statuses: [{ status: "to do" }, { status: "done" }], space: { id: "s1", name: "Space" } },
    };
  };
  client.intercept({ path: "/api/v2/folder/f1/list", method: "POST" }).reply(reply);
  client.intercept({ path: "/api/v2/space/s1/list", method: "POST" }).reply(reply);

  const inFolder = await tools.createList({ name: "L", folder_id: "f1", content: "# Hi", priority: 2, due_date: "2025-01-31" });
  assert.equal(bodies[0].name, "L");
  assert.equal(bodies[0].markdown_content, "# Hi");
  assert.equal(bodies[0].priority, 2);
  assert.equal(bodies[0].due_date, Date.parse("2025-01-31T00:00:00Z"));
  assert.match(inFolder.content[0].text, /L \(list_id: l5\)/);
  assert.match(inFolder.content[0].text, /Statuses: to do, done/);

  await tools.createList({ name: "L", space_id: "s1" });
  assert.deepEqual(bodies[1], { name: "L" });
  await cleanup();
});

test("createList requires exactly one parent and makes no request", async (t) => {
  const { tools, cleanup } = await setup(t);
  const none = await tools.createList({ name: "L" });
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /exactly one of folder_id or space_id/);
  const both = await tools.createList({ name: "L", folder_id: "f1", space_id: "s1" });
  assert.equal(both.isError, true);
  await cleanup();
});

test("createList resolves assignee username to a user id", async (t) => {
  const { client, tools, cleanup } = await setup(t);
  client.intercept({ path: "/api/v2/team", method: "GET" }).reply(200, {
    teams: [{ id: "team1", members: [{ user: { id: 101, username: "Jane Doe", email: "jane@example.com", role: 3 } }] }],
  });
  let body: any;
  client.intercept({ path: "/api/v2/space/s1/list", method: "POST" }).reply((opts) => {
    body = JSON.parse(String(opts.body));
    return { statusCode: 200, data: { id: "l5", name: "L" } };
  });
  await tools.createList({ name: "L", space_id: "s1", assignee: "jane@example.com" });
  assert.equal(body.assignee, 101);
  await cleanup();
});

test("bad ids are rejected without any request", async (t) => {
  const { tools, cleanup } = await setup(t);
  // disableNetConnect + no interceptors: any request would throw a different error
  for (const [tool, args] of [
    ["getFolder", { folder_id: "../x" }],
    ["createFolder", { space_id: "1/2", name: "n" }],
    ["updateFolder", { folder_id: "a?b", name: "n" }],
    ["createList", { name: "n", folder_id: "../x" }],
    ["createList", { name: "n", space_id: "../x" }],
  ] as const) {
    const result = await tools[tool](args);
    assert.equal(result.isError, true, tool);
    assert.match(result.content[0].text, /Invalid (folder_id|space_id)/, tool);
  }
  await cleanup();
});
