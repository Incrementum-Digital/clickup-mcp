import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

test("updateTask updates name and description", async (t) => {
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
    .intercept({ path: "/api/v2/task/task123?include_markdown_description=true", method: "GET" })
    .reply(200, { id: "task123", name: "Old", markdown_description: "existing", status: { status: "open", type: "open" }, assignees: [], url: "https://app.clickup.com/t/task123" });

  let bodyCaptured: any;
  client
    .intercept({ path: "/api/v2/task/task123", method: "PUT" })
    .reply((opts) => {
      bodyCaptured = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { id: "task123", name: "New Name", status: { status: "open", type: "open" }, assignees: [], url: "https://app.clickup.com/t/task123" } };
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

  const result = await tools.updateTask({ task_id: "task123", name: "New Name", append_description: "More details" });

  assert.equal(bodyCaptured.name, "New Name");
  assert.ok(bodyCaptured.markdown_description.includes("More details"));
  assert.ok(result.content[0].text.includes("Task updated successfully"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("updateTask removes only the links left out of linked_tasks", async (t) => {
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

  // Two existing links, one recorded in each direction: the API stores
  // `task_id`/`link_id` and puts the task being read on either side.
  const linkedTasks = [
    { task_id: "keepme", link_id: "task123" },
    { task_id: "task123", link_id: "dropme" },
  ];

  client
    .intercept({ path: "/api/v2/task/task123?include_markdown_description=true", method: "GET" })
    .reply(200, { id: "task123", name: "Task", markdown_description: "", status: { status: "open", type: "open" }, assignees: [], url: "https://app.clickup.com/t/task123", linked_tasks: linkedTasks });

  let removed: string[] = [];
  client
    .intercept({ path: "/api/v2/task/task123/link/dropme", method: "DELETE" })
    .reply(() => {
      removed.push("dropme");
      return { statusCode: 200, data: {} };
    });

  client
    .intercept({ path: "/api/v2/task/task123", method: "GET" })
    .reply(200, { id: "task123", name: "Task", status: { status: "open", type: "open" }, assignees: [], url: "https://app.clickup.com/t/task123", linked_tasks: [linkedTasks[0]] });

  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (name: string, _desc: string, _schema: any, _opts: any, handler: any) => {
      tools[name] = handler;
    },
  } as any;

  registerTaskToolsWrite(serverStub, { user: { username: "me", id: "u1" } });

  // Only `keepme` is requested, so only `dropme` may be removed. Nothing else is
  // intercepted, so an attempt to re-add `keepme` or to delete
  // `/link/undefined` fails the test instead of passing silently.
  const result = await tools.updateTask({ task_id: "task123", linked_tasks: ["keepme"] });

  assert.deepEqual(removed, ["dropme"]);
  assert.ok(result.content[0].text.includes("Task updated successfully"));
  assert.ok(!result.content[0].text.includes("dependency_warnings"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

function registerUpdateTask(registerTaskToolsWrite: any) {
  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (name: string, _desc: string, _schema: any, _opts: any, handler: any) => {
      tools[name] = handler;
    },
  } as any;
  registerTaskToolsWrite(serverStub, { user: { username: "me", id: "u1" } });
  return tools.updateTask;
}

test("updateTask replaces the whole description when `description` is given", async (t) => {
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
    .intercept({ path: "/api/v2/task/task123?include_markdown_description=true", method: "GET" })
    .reply(200, { id: "task123", name: "Task", markdown_description: "old text that must vanish", status: { status: "open", type: "open" }, assignees: [], url: "https://app.clickup.com/t/task123" });

  let bodyCaptured: any;
  client
    .intercept({ path: "/api/v2/task/task123", method: "PUT" })
    .reply((opts) => {
      bodyCaptured = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { id: "task123", name: "Task", status: { status: "open", type: "open" }, assignees: [], url: "https://app.clickup.com/t/task123" } };
    });

  const updateTask = registerUpdateTask(registerTaskToolsWrite);
  const result = await updateTask({ task_id: "task123", description: "# New\n\n- fresh list" });

  // Exact equality: no separator, no "Edit (date)" prefix, no remnant of the old text.
  assert.equal(bodyCaptured.markdown_description, "# New\n\n- fresh list");
  assert.ok(result.content[0].text.includes("Task updated successfully"));
  assert.ok(result.content[0].text.includes("description: replaced"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("updateTask appends a dated edit section when `append_description` is given", async (t) => {
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
    .intercept({ path: "/api/v2/task/task123?include_markdown_description=true", method: "GET" })
    .reply(200, { id: "task123", name: "Task", markdown_description: "existing", status: { status: "open", type: "open" }, assignees: [], url: "https://app.clickup.com/t/task123" });

  let bodyCaptured: any;
  client
    .intercept({ path: "/api/v2/task/task123", method: "PUT" })
    .reply((opts) => {
      bodyCaptured = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { id: "task123", name: "Task", status: { status: "open", type: "open" }, assignees: [], url: "https://app.clickup.com/t/task123" } };
    });

  const updateTask = registerUpdateTask(registerTaskToolsWrite);
  const result = await updateTask({ task_id: "task123", append_description: "addendum" });

  assert.match(bodyCaptured.markdown_description, /^existing\n\n---\n\*\*Edit \(\d{4}-\d{2}-\d{2}\):\*\* addendum$/);
  assert.ok(result.content[0].text.includes("description: appended"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

test("updateTask rejects `description` together with `append_description` without touching the task", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  // No intercepts at all: any request would fail the test.
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  const updateTask = registerUpdateTask(registerTaskToolsWrite);
  const result = await updateTask({ task_id: "task123", description: "a", append_description: "b" });

  assert.ok(result.content[0].text.includes("mutually exclusive"));
  assert.ok(result.content[0].text.includes("NOT updated"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

function updateTaskHarness(t: any) {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");
  client
    .intercept({ path: "/api/v2/user", method: "GET" })
    .reply(200, { user: { id: "u1", username: "me" } });
  const baseTask = {
    id: "task123", name: "Task", markdown_description: "", status: { status: "open", type: "open" },
    assignees: [], url: "https://app.clickup.com/t/task123", list: { id: "list1" },
  };
  const cleanup = async () => {
    await mockAgent.close();
    t.mock.timers.runAll();
    t.mock.timers.reset();
  };
  return { client, baseTask, cleanup };
}

test("updateTask add_tags / remove_tags use the single tag endpoints and skip no-ops", async (t) => {
  const { client, baseTask, cleanup } = updateTaskHarness(t);
  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  const taskWithTags = { ...baseTask, tags: [{ name: "old" }, { name: "keep" }] };
  client
    .intercept({ path: "/api/v2/task/task123?include_markdown_description=true", method: "GET" })
    .reply(200, taskWithTags);

  const calls: string[] = [];
  // Only these two requests are intercepted: "keep" is already present and "ghost"
  // is not on the task, so neither may produce a request.
  client
    .intercept({ path: "/api/v2/task/task123/tag/new%20tag", method: "POST" })
    .reply(() => { calls.push("POST new tag"); return { statusCode: 200, data: {} }; });
  client
    .intercept({ path: "/api/v2/task/task123/tag/old", method: "DELETE" })
    .reply(() => { calls.push("DELETE old"); return { statusCode: 200, data: {} }; });
  client
    .intercept({ path: "/api/v2/task/task123", method: "GET" })
    .reply(200, { ...baseTask, tags: [{ name: "keep" }, { name: "new tag" }] });

  const updateTask = registerUpdateTask(registerTaskToolsWrite);
  const result = await updateTask({
    task_id: "task123",
    add_tags: ["new tag", "KEEP"],
    remove_tags: ["old", "ghost"],
  });

  assert.deepEqual(calls, ["POST new tag", "DELETE old"]);
  const text = result.content[0].text;
  assert.ok(text.includes("Task updated successfully"));
  assert.ok(text.includes("tags_added: new tag"));
  assert.ok(text.includes("tags_removed: old"));
  assert.ok(!text.includes("tag_warnings"));
  await cleanup();
});

test("updateTask rejects `tags` combined with add_tags / remove_tags without touching the task", async (t) => {
  const { cleanup } = updateTaskHarness(t);
  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");
  const updateTask = registerUpdateTask(registerTaskToolsWrite);

  const result = await updateTask({ task_id: "task123", tags: ["a"], add_tags: ["b"] });
  assert.match(result.content[0].text, /cannot be combined with `add_tags` \/ `remove_tags`/);
  const result2 = await updateTask({ task_id: "task123", tags: ["a"], remove_tags: ["b"] });
  assert.match(result2.content[0].text, /cannot be combined/);
  await cleanup();
});

test("updateTask removes waiting_on and blocking dependencies read from task.dependencies", async (t) => {
  const { client, baseTask, cleanup } = updateTaskHarness(t);
  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  client
    .intercept({ path: "/api/v2/task/task123?include_markdown_description=true", method: "GET" })
    .reply(200, {
      ...baseTask,
      dependencies: [
        { task_id: "task123", depends_on: "keepwait", type: 1 },
        { task_id: "task123", depends_on: "dropwait", type: 1 },
        { task_id: "keepblk", depends_on: "task123", type: 1 },
        { task_id: "dropblk", depends_on: "task123", type: 1 },
      ],
    });

  // Only the two removals are intercepted. Re-adding the kept ones or hitting
  // `/dependency?depends_on=undefined` would fail the test.
  const calls: string[] = [];
  client
    .intercept({ path: "/api/v2/task/task123/dependency?depends_on=dropwait", method: "DELETE" })
    .reply(() => { calls.push("task123 stops waiting on dropwait"); return { statusCode: 200, data: {} }; });
  client
    .intercept({ path: "/api/v2/task/dropblk/dependency?depends_on=task123", method: "DELETE" })
    .reply(() => { calls.push("dropblk stops waiting on task123"); return { statusCode: 200, data: {} }; });
  client
    .intercept({ path: "/api/v2/task/task123", method: "GET" })
    .reply(200, baseTask);

  const updateTask = registerUpdateTask(registerTaskToolsWrite);
  const result = await updateTask({ task_id: "task123", waiting_on: ["keepwait"], blocking: ["keepblk"] });

  assert.deepEqual(calls.sort(), ["dropblk stops waiting on task123", "task123 stops waiting on dropwait"]);
  const text = result.content[0].text;
  assert.ok(text.includes("Task updated successfully"));
  assert.ok(!text.includes("dependency_warnings"));
  assert.ok(!text.includes("undefined"));
  await cleanup();
});

test("updateTask adds only the missing dependencies", async (t) => {
  const { client, baseTask, cleanup } = updateTaskHarness(t);
  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  client
    .intercept({ path: "/api/v2/task/task123?include_markdown_description=true", method: "GET" })
    .reply(200, { ...baseTask, dependencies: [{ task_id: "task123", depends_on: "already", type: 1 }] });

  const posted: any[] = [];
  client
    .intercept({ path: "/api/v2/task/task123/dependency", method: "POST" })
    .reply((opts) => { posted.push(JSON.parse(String(opts.body)).depends_on); return { statusCode: 200, data: {} }; });
  client
    .intercept({ path: "/api/v2/task/task123", method: "GET" })
    .reply(200, baseTask);

  const updateTask = registerUpdateTask(registerTaskToolsWrite);
  await updateTask({ task_id: "task123", waiting_on: ["already", "newone"] });

  assert.deepEqual(posted, ["newone"]);
  await cleanup();
});

test("updateTask resolves assignee names and sets custom fields via the list of the task", async (t) => {
  const { client, baseTask, cleanup } = updateTaskHarness(t);
  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  client
    .intercept({ path: "/api/v2/task/task123?include_markdown_description=true", method: "GET" })
    .reply(200, baseTask);
  client
    .intercept({ path: "/api/v2/team", method: "GET" })
    .reply(200, { teams: [{ id: "team1", members: [{ user: { id: 11, username: "Jane Doe", email: "jane@example.com" } }] }] });
  client
    .intercept({ path: "/api/v2/list/list1/field", method: "GET" })
    .reply(200, { fields: [{ id: "f-drop", name: "Tier", type: "drop_down", type_config: { options: [{ id: "opt-gold", name: "Gold" }] } }] });

  let updateBody: any;
  client
    .intercept({ path: "/api/v2/task/task123", method: "PUT" })
    .reply((opts) => {
      updateBody = JSON.parse(String(opts.body));
      return { statusCode: 200, data: { ...baseTask, assignees: [{ id: 11, username: "Jane Doe" }] } };
    });

  let fieldBody: any;
  client
    .intercept({ path: "/api/v2/task/task123/field/f-drop", method: "POST" })
    .reply((opts) => {
      fieldBody = JSON.parse(String(opts.body));
      return { statusCode: 200, data: {} };
    });

  const updateTask = registerUpdateTask(registerTaskToolsWrite);
  const result = await updateTask({ task_id: "task123", assignees: ["jane"], custom_fields: { Tier: "Gold" } });

  assert.deepEqual(updateBody.assignees, { add: ["11"], rem: [] });
  assert.deepEqual(fieldBody, { value: "opt-gold" });
  const text = result.content[0].text;
  assert.ok(text.includes("assignees: Jane Doe (user_id: 11)"));
  assert.ok(text.includes("custom_fields_set: Tier (field_id: f-drop)"));
  assert.ok(!text.includes("custom_field_warnings"));
  assert.ok(text.startsWith("Task updated successfully"));
  await cleanup();
});

test("updateTask rejects an unknown assignee before changing anything", async (t) => {
  const { client, baseTask, cleanup } = updateTaskHarness(t);
  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  client
    .intercept({ path: "/api/v2/team", method: "GET" })
    .reply(200, { teams: [{ id: "team1", members: [{ user: { id: 11, username: "Jane Doe", email: "jane@example.com" } }] }] });
  // The task is never fetched or written: no interceptors for it.
  void baseTask;

  const updateTask = registerUpdateTask(registerTaskToolsWrite);
  const result = await updateTask({ task_id: "task123", name: "X", assignees: ["Nobody"] });
  assert.match(result.content[0].text, /Error updating task: Unknown assignee "Nobody"/);
  await cleanup();
});

test("updateTask aborts without a PUT when the custom field definitions cannot be loaded (429)", async (t) => {
  const { client, baseTask, cleanup } = updateTaskHarness(t);
  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  client
    .intercept({ path: "/api/v2/task/task123?include_markdown_description=true", method: "GET" })
    .reply(200, baseTask);
  client
    .intercept({ path: "/api/v2/list/list1/field", method: "GET" })
    .reply(429, { err: "Rate limit reached" });
  // No PUT interceptor: a write attempt would fail the request with a network error
  // and be visible in the message below.

  const updateTask = registerUpdateTask(registerTaskToolsWrite);
  const result = await updateTask({ task_id: "task123", name: "Renamed", custom_fields: { Tier: "Gold" } });
  const text = result.content[0].text;
  assert.match(text, /^Error updating task: /);
  assert.match(text, /429/);
  assert.match(text, /The task was NOT updated/);
  await cleanup();
});

test("updateTask aborts without a PUT when a custom field is unknown or its value is invalid", async (t) => {
  const { client, baseTask, cleanup } = updateTaskHarness(t);
  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  client
    .intercept({ path: "/api/v2/task/task123?include_markdown_description=true", method: "GET" })
    .reply(200, baseTask)
    .times(2);
  client
    .intercept({ path: "/api/v2/list/list1/field", method: "GET" })
    .reply(200, { fields: [{ id: "f-drop", name: "Tier", type: "drop_down", type_config: { options: [{ id: "opt-gold", name: "Gold" }] } }] });

  const updateTask = registerUpdateTask(registerTaskToolsWrite);
  const unknown = await updateTask({ task_id: "task123", name: "Renamed", custom_fields: { Tier: "Gold", Nope: 1 } });
  assert.match(unknown.content[0].text, /Unknown custom field "Nope".*The task was NOT updated/);
  const invalid = await updateTask({ task_id: "task123", name: "Renamed", custom_fields: { Tier: "Bronze" } });
  assert.match(invalid.content[0].text, /Unknown option "Bronze".*The task was NOT updated/);
  await cleanup();
});

test("updateTask reports a partial success when a field write fails after the task update", async (t) => {
  const { client, baseTask, cleanup } = updateTaskHarness(t);
  const { registerTaskToolsWrite } = await import("../tools/task-write-tools");

  client
    .intercept({ path: "/api/v2/task/task123?include_markdown_description=true", method: "GET" })
    .reply(200, baseTask);
  client
    .intercept({ path: "/api/v2/list/list1/field", method: "GET" })
    .reply(200, {
      fields: [
        { id: "f-text", name: "Client", type: "short_text", type_config: {} },
        { id: "f-num", name: "Budget", type: "number", type_config: {} },
      ],
    });

  let putCount = 0;
  client
    .intercept({ path: "/api/v2/task/task123", method: "PUT" })
    .reply(() => {
      putCount++;
      return { statusCode: 200, data: { ...baseTask, name: "Renamed" } };
    });
  client
    .intercept({ path: "/api/v2/task/task123/field/f-text", method: "POST" })
    .reply(200, {});
  client
    .intercept({ path: "/api/v2/task/task123/field/f-num", method: "POST" })
    .reply(500, { err: "boom" });

  const updateTask = registerUpdateTask(registerTaskToolsWrite);
  const result = await updateTask({ task_id: "task123", name: "Renamed", custom_fields: { Client: "Acme", Budget: 5 } });
  const text = result.content[0].text;

  assert.equal(putCount, 1);
  assert.ok(text.startsWith("Task updated PARTIALLY: the task changes were saved, but 1 of 2 custom field(s) were NOT written."));
  assert.ok(!text.includes("Task updated successfully"));
  assert.ok(text.includes("committed_changes: name"));
  assert.ok(text.includes("custom_fields_not_written: Budget"));
  assert.ok(text.includes("custom_fields_set: Client (field_id: f-text)"));
  assert.match(text, /custom_field_warnings: Budget: 500/);
  await cleanup();
});
