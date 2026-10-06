import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

test("createTask posts task with defaults", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client
    .intercept({ path: "/api/v2/user", method: "GET" })
    .reply(200, { user: { id: "u1", username: "me" } });

  let bodyCaptured: any;
  client
    .intercept({ path: "/api/v2/list/list123/task", method: "POST" })
    .reply((opts) => {
      bodyCaptured = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { id: "task999", name: "New Task", status: { status: "open" }, assignees: [{ id: "u1", username: "me" }], url: "https://app.clickup.com/t/task999" } };
    });

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

  registerTaskToolsWrite(serverStub, { user: { username: "me", id: "u1" } });

  const result = await tools.createTask({ list_id: "list123", name: "New Task", description: "Desc" });

  assert.equal(bodyCaptured.name, "New Task");
  assert.equal(bodyCaptured.markdown_description, "Desc");
  assert.deepEqual(bodyCaptured.assignees, ["u1"]);
  assert.ok(result.content[0].text.includes("Task created successfully"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("createTask applies tags via the dedicated tag endpoints", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client
    .intercept({ path: "/api/v2/user", method: "GET" })
    .reply(200, { user: { id: "u1", username: "me" } });

  let bodyCaptured: any;
  client
    .intercept({ path: "/api/v2/list/list123/task", method: "POST" })
    .reply((opts) => {
      bodyCaptured = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { id: "task999", name: "Tagged Task", status: { status: "open" }, assignees: [{ id: "u1", username: "me" }], url: "https://app.clickup.com/t/task999" } };
    });

  const taggedPaths: string[] = [];
  for (const tag of ["alpha", "beta gamma"]) {
    client
      .intercept({ path: `/api/v2/task/task999/tag/${encodeURIComponent(tag)}`, method: "POST" })
      .reply((opts) => {
        taggedPaths.push(String(opts.path));
        return { statusCode: 200, data: {} };
      });
  }

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

  registerTaskToolsWrite(serverStub, { user: { username: "me", id: "u1" } });

  const result = await tools.createTask({ list_id: "list123", name: "Tagged Task", tags: ["alpha", "beta gamma"] });

  // Tags never travel in the create body - they go through the dedicated endpoints.
  assert.equal(bodyCaptured.tags, undefined);
  assert.deepEqual(taggedPaths, [
    "/api/v2/task/task999/tag/alpha",
    "/api/v2/task/task999/tag/beta%20gamma",
  ]);
  assert.ok(result.content[0].text.includes("Task created successfully"));
  assert.ok(!result.content[0].text.includes("tag_warnings"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

function registerCreateTask(registerTaskToolsWrite: any) {
  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (name: string, _desc: string, _schema: any, _opts: any, handler: any) => {
      tools[name] = handler;
    },
  } as any;
  registerTaskToolsWrite(serverStub, { user: { username: "me", id: "u1" } });
  return tools.createTask;
}

test("createTask resolves assignee names and sends custom_fields in the create body", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client
    .intercept({ path: "/api/v2/user", method: "GET" })
    .reply(200, { user: { id: "u1", username: "me" } });
  client
    .intercept({ path: "/api/v2/team", method: "GET" })
    .reply(200, { teams: [{ id: "team1", members: [{ user: { id: 11, username: "Jane Doe", email: "jane@example.com" } }, { user: { id: 12, username: "Bob Ross", email: "bob@example.com" } }] }] });
  client
    .intercept({ path: "/api/v2/list/list123/field", method: "GET" })
    .reply(200, {
      fields: [
        { id: "f-drop", name: "Tier", type: "drop_down", type_config: { options: [{ id: "opt-gold", name: "Gold" }] } },
        { id: "f-num", name: "Budget", type: "number", type_config: {} },
      ],
    });

  let bodyCaptured: any;
  client
    .intercept({ path: "/api/v2/list/list123/task", method: "POST" })
    .reply((opts) => {
      bodyCaptured = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { id: "task999", name: "New Task", status: { status: "open" }, assignees: [{ id: 11, username: "Jane Doe" }, { id: 12, username: "Bob Ross" }], url: "https://app.clickup.com/t/task999",
        // ClickUp kept "Tier" but silently dropped "Budget" (not applicable to this task type)
        custom_fields: [{ id: "f-drop", name: "Tier", type: "drop_down", value: 0 }, { id: "f-num", name: "Budget", type: "number" }] } };
    });

  const createTask = registerCreateTask(registerTaskToolsWrite);
  const result = await createTask({
    list_id: "list123",
    name: "New Task",
    assignees: ["jane@example.com", "Bob", "42"],
    custom_fields: { tier: "gold", Budget: "1500" },
  });

  assert.deepEqual(bodyCaptured.assignees, ["11", "12", "42"]);
  assert.deepEqual(bodyCaptured.custom_fields, [
    { id: "f-drop", value: "opt-gold" },
    { id: "f-num", value: 1500 },
  ]);
  const text = result.content[0].text;
  assert.ok(text.includes("Task created successfully"));
  assert.ok(text.includes("Jane Doe (user_id: 11)"));
  assert.ok(text.includes("  - Tier (field_id: f-drop): set"));
  assert.ok(text.includes("  - Budget (field_id: f-num): not saved by ClickUp, the field may not apply to this task type"));
  assert.ok(!text.includes("custom_fields_set"));
  assert.ok(text.includes("assignees_resolved: Jane Doe (user_id: 11), Bob Ross (user_id: 12), user_id: 42"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("createTask aborts before creating anything when an assignee or custom field is invalid", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client
    .intercept({ path: "/api/v2/user", method: "GET" })
    .reply(200, { user: { id: "u1", username: "me" } });
  client
    .intercept({ path: "/api/v2/team", method: "GET" })
    .reply(200, { teams: [{ id: "team1", members: [{ user: { id: 11, username: "Jane Doe", email: "jane@example.com" } }] }] });
  client
    .intercept({ path: "/api/v2/list/list123/field", method: "GET" })
    .reply(200, { fields: [{ id: "f-num", name: "Budget", type: "number", type_config: {} }] });

  // No POST /list/list123/task interceptor: reaching it would fail the request.
  const createTask = registerCreateTask(registerTaskToolsWrite);

  const unknownAssignee = await createTask({ list_id: "list123", name: "T", assignees: ["Nobody"] });
  assert.match(unknownAssignee.content[0].text, /Error creating task: Unknown assignee "Nobody"\. Known members: Jane Doe \(user_id: 11\)/);

  const unknownField = await createTask({ list_id: "list123", name: "T", custom_fields: { Nope: 1 } });
  assert.match(unknownField.content[0].text, /Error creating task: Unknown custom field "Nope"/);

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("createTask reads the created task back when the create response has no custom_fields", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client
    .intercept({ path: "/api/v2/user", method: "GET" })
    .reply(200, { user: { id: "u1", username: "me" } });
  client
    .intercept({ path: "/api/v2/list/list123/field", method: "GET" })
    .reply(200, { fields: [{ id: "f-text", name: "Client", type: "short_text", type_config: {} }, { id: "f-num", name: "Budget", type: "number", type_config: {} }] });
  client
    .intercept({ path: "/api/v2/list/list123/task", method: "POST" })
    .reply(200, { id: "task999", name: "New Task", status: { status: "open" }, assignees: [], url: "https://app.clickup.com/t/task999" });
  client
    .intercept({ path: "/api/v2/task/task999", method: "GET" })
    .reply(200, { id: "task999", custom_fields: [{ id: "f-text", name: "Client", type: "short_text", value: "Acme" }, { id: "f-num", name: "Budget", type: "number" }] });

  const createTask = registerCreateTask(registerTaskToolsWrite);
  const result = await createTask({ list_id: "list123", name: "New Task", custom_fields: { Client: "Acme", Budget: 10 } });
  const text = result.content[0].text;

  assert.ok(text.includes("  - Client (field_id: f-text): set"));
  assert.ok(text.includes("  - Budget (field_id: f-num): not saved by ClickUp"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});
