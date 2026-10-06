import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

const TASK_PATH = "/api/v2/team/team1/task?";

function makeTask(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    creator: { username: "creator", id: "1" },
    assignees: [],
    list: { id: "list1", name: "List" },
    space: { id: "space1", name: "Space 1" },
    status: { status: "open", type: "open" },
    url: `https://app.clickup.com/t/${id}`,
    date_created: "0",
    date_updated: "0",
    ...extra,
  };
}

function fullPage(prefix: string) {
  return Array.from({ length: 100 }, (_, i) => makeTask(`${prefix}${i}`, `${prefix} task ${i}`));
}

/**
 * Registers the search tools against a mocked ClickUp API. `respond` gets each
 * team task request path and returns the JSON body (and optionally a status).
 */
async function setup(
  t: any,
  respond: (path: string, page: number) => { body: any; status?: number },
) {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";
  const { registerSearchTools } = await import("../tools/search-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  const requests: string[] = [];
  client
    .intercept({ path: (p: string) => p.startsWith(TASK_PATH), method: "GET" })
    .reply(((opts: { path: string }) => {
      requests.push(opts.path);
      const page = Number(/[?&]page=(\d+)/.exec(opts.path)?.[1] ?? "0");
      const { body, status } = respond(opts.path, page);
      return { statusCode: status ?? 200, data: JSON.stringify(body), responseOptions: { headers: { "content-type": "application/json" } } };
    }) as any)
    .persist();

  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (name: string, _d: string, _s: any, _o: any, handler: any) => {
      tools[name] = handler;
    },
  } as any;
  registerSearchTools(serverStub, { user: { username: "me", id: "u1" } });

  return {
    tools,
    requests,
    client,
    done: async () => {
      await mockAgent.close();
      t.mock.timers.reset();
    },
  };
}

const textOf = (result: any) => result.content.map((b: any) => b.text || "").join("\n");

test("searchTasks sends every filter in the format ClickUp expects", async (t) => {
  const { tools, requests, done } = await setup(t, () => ({ body: { tasks: [makeTask("a1", "Alpha")] } }));

  await tools.searchTasks({
    assignees: ["u2"],
    assigned_to_me: true,
    tags: ["bug", "needs review"],
    due_date_from: "2025-01-01",
    due_date_to: "2025-01-31",
    include_closed: true,
    custom_fields: [{ field_id: "f1", operator: "=", value: "high" }],
  });

  assert.equal(requests.length, 1);
  console.log("Generated query string:", requests[0]);
  const customFields = encodeURIComponent(JSON.stringify([{ field_id: "f1", operator: "=", value: "high" }]));
  assert.equal(
    requests[0],
    `${TASK_PATH}order_by=updated` +
      `&assignees[]=u1&assignees[]=u2` +
      `&tags[]=bug&tags[]=needs%20review` +
      `&include_closed=true` +
      `&due_date_gt=${Date.UTC(2025, 0, 1)}` +
      `&due_date_lt=${Date.UTC(2025, 0, 31, 23, 59, 59, 999)}` +
      `&custom_fields=${customFields}` +
      `&page=0`,
  );
  await done();
});

test("searchTasks maps folders, status, subtasks, parent and ordering", async (t) => {
  const { tools, requests, done } = await setup(t, () => ({ body: { tasks: [] } }));

  await tools.searchTasks({
    folder_ids: ["f9"],
    status: ["In Progress"],
    include_subtasks: true,
    parent_task_id: "p1",
    created_from: "2025-03-01T10:00:00Z",
    updated_to: "2025-03-02T10:00:00+02:00",
    done_from: "2025-03-01",
    order_by: "due_date",
    descending: true,
  });

  assert.equal(
    requests[0],
    `${TASK_PATH}order_by=due_date&reverse=true&project_ids[]=f9&statuses[]=in%20progress` +
      `&include_closed=true&subtasks=true` +
      `&date_created_gt=${Date.parse("2025-03-01T10:00:00Z")}` +
      `&date_updated_lt=${Date.parse("2025-03-02T08:00:00Z")}` +
      `&date_done_gt=${Date.UTC(2025, 2, 1)}` +
      `&parent=p1&page=0`,
  );
  await done();
});

test("searchTasks stops after a short page", async (t) => {
  const { tools, requests, done } = await setup(t, (_p, page) => ({
    body: { tasks: page === 0 ? fullPage("p0_") : [makeTask("last", "Last one")] },
  }));

  const result = await tools.searchTasks({ tags: ["short-page"], limit: 200 });

  assert.equal(requests.length, 2, "page 1 was short, so page 2 must not be requested");
  const text = textOf(result);
  assert.ok(text.includes("Fetched 101 task(s) from 2 page(s)"));
  assert.ok(!text.includes("Page cap reached"));
  assert.ok(text.includes("task_id: last"));
  await done();
});

test("searchTasks reports when the page cap is hit and honours limit", async (t) => {
  const { tools, requests, done } = await setup(t, (_p, page) => ({ body: { tasks: fullPage(`c${page}_`) } }));

  const result = await tools.searchTasks({ tags: ["capped"] });

  assert.equal(requests.length, 5, "never more than 5 pages");
  const text = textOf(result);
  assert.ok(text.includes("Page cap reached: only the first 500 matching tasks were fetched"));
  assert.ok(text.includes("Showing 50 of 500 matching tasks (limit 50)"));
  // 1 summary block + 50 tasks, in the order the API returned them
  assert.equal(result.content.length, 51);
  assert.ok(result.content[1].text.includes("task_id: c0_0"));
  assert.ok(result.content[50].text.includes("task_id: c0_49"));
  await done();
});

test("searchTasks applies terms to the filtered set only", async (t) => {
  const { tools, requests, done } = await setup(t, () => ({
    body: { tasks: [makeTask("a1", "Alpha report"), makeTask("b1", "Beta invoice")] },
  }));

  const result = await tools.searchTasks({ terms: ["invoice"], assignees: ["u7"] });

  assert.equal(requests.length, 1, "no direct fetch for the id-like term when other filters scope the search");
  assert.ok(requests[0].includes("assignees[]=u7"));
  const text = textOf(result);
  assert.ok(text.includes("task_id: b1"));
  assert.ok(!text.includes("task_id: a1"));
  assert.ok(text.includes("Search terms: invoice."));
  assert.ok(text.includes("assignees (user ids): u7"));
  await done();
});

test("searchTasks without terms returns the filtered tasks in API order", async (t) => {
  const { tools, done } = await setup(t, () => ({
    body: { tasks: [makeTask("z1", "Zeta", { date_updated: "1" }), makeTask("y1", "Yankee", { date_updated: "999" })] },
  }));

  const result = await tools.searchTasks({ tags: ["order"] });
  const text = textOf(result);
  assert.ok(text.indexOf("task_id: z1") < text.indexOf("task_id: y1"), "no client-side re-sorting");
  await done();
});

test("searchTasks rejects calls without terms or filters", async (t) => {
  const { tools, requests, done } = await setup(t, () => ({ body: { tasks: [] } }));

  for (const args of [{}, { terms: [] }, { terms: ["  "] }, { include_closed: true, limit: 10, order_by: "created" }]) {
    const result = await tools.searchTasks(args);
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.ok(text.includes("Available filters:"));
    assert.ok(text.includes("assignees") && text.includes("custom_fields") && text.includes("due_date_from/to"));
  }
  assert.equal(requests.length, 0, "no API calls for a rejected search");
  await done();
});

test("searchTasks rejects invalid dates", async (t) => {
  const { tools, requests, done } = await setup(t, () => ({ body: { tasks: [] } }));

  const result = await tools.searchTasks({ due_date_from: "next tuesday" });
  assert.equal(result.isError, true);
  assert.ok(textOf(result).includes("Invalid due_date_from"));

  const impossible = await tools.searchTasks({ created_to: "2025-02-31" });
  assert.equal(impossible.isError, true);
  assert.equal(requests.length, 0);
  await done();
});

test("parseDateFilter handles date-only, datetime and offsets", async () => {
  const { parseDateFilter } = await import("../shared/utils");
  assert.equal(parseDateFilter("x", "2025-06-01"), Date.UTC(2025, 5, 1));
  assert.equal(parseDateFilter("x", "2025-06-01", true), Date.UTC(2025, 5, 1, 23, 59, 59, 999));
  assert.equal(parseDateFilter("x", "2025-06-01T12:30:00", true), Date.UTC(2025, 5, 1, 12, 30), "datetime values are not shifted to end of day");
  assert.equal(parseDateFilter("x", "2025-06-01T12:30:00-05:00"), Date.UTC(2025, 5, 1, 17, 30));
  assert.throws(() => parseDateFilter("x", "garbage"));
});

test("searchTasks surfaces API errors and does not cache them", async (t) => {
  let calls = 0;
  const { tools, done } = await setup(t, () => {
    calls++;
    return calls === 1
      ? { status: 400, body: { err: "Custom field invalid", ECODE: "X" } }
      : { body: { tasks: [makeTask("ok1", "Recovered")] } };
  });

  const failed = await tools.searchTasks({ tags: ["flaky"] });
  assert.equal(failed.isError, true);
  assert.ok(textOf(failed).includes("ClickUp API error 400: Custom field invalid"));

  const retried = await tools.searchTasks({ tags: ["flaky"] });
  assert.ok(textOf(retried).includes("task_id: ok1"));
  await done();
});

test("searchTasks warns when a later page fails", async (t) => {
  const { tools, done } = await setup(t, (_p, page) =>
    page === 0 ? { body: { tasks: fullPage("w_") } } : { status: 429, body: { err: "Rate limit reached" } },
  );

  const result = await tools.searchTasks({ tags: ["partial"] });
  const text = textOf(result);
  assert.ok(text.includes("Fetching page 2 failed"));
  assert.ok(text.includes("Fetched 100 task(s) from 1 page(s)"));
  await done();
});

test("searchTasks keeps the deep legacy fetch when no new filter is set", async (t) => {
  const { tools, requests, done } = await setup(t, (_p, page) => ({ body: { tasks: fullPage(`l${page}_`) } }));

  // Pure terms search: 30 pages requested in parallel, even though every page is full
  const result = await tools.searchTasks({ terms: ["l29_99"] });
  assert.equal(requests.length, 30, "legacy path requests 30 pages, not 5");
  assert.ok(requests.every((r) => r.includes("order_by=updated") && r.includes("subtasks=true")));
  const pages = new Set(requests.map((r) => /page=(\d+)/.exec(r)![1]));
  assert.equal(pages.size, 30);
  const text = textOf(result);
  assert.ok(text.includes("Fetched 3000 task(s)"));
  assert.ok(!text.includes("Page cap reached"));
  assert.ok(text.includes("task_id: l29_99"), "text match found on a task far beyond the 5th page");

  // Scoped by a pre-existing filter only: legacy depth of 10 pages
  requests.length = 0;
  await tools.searchTasks({ terms: ["zzz"], list_ids: ["listX"], assigned_to_me: true });
  assert.equal(requests.length, 10);
  assert.ok(requests[0].includes("list_ids[]=listX") && requests[0].includes("assignees[]=u1"));

  // A new filter switches to the sequential 5-page path
  requests.length = 0;
  await tools.searchTasks({ terms: ["zzz"], tags: ["legacy-switch"] });
  assert.equal(requests.length, 5);
  await done();
});

test("searchTasks applies include_closed / include_subtasks to directly fetched tasks", async (t) => {
  const { tools, client, done } = await setup(t, () => ({ body: { tasks: [] } }));
  client
    .intercept({ path: "/api/v2/task/abc123", method: "GET" })
    .reply(200, makeTask("abc123", "Closed subtask", { parent: "p1", status: { status: "complete", type: "closed" } }))
    .persist();

  const excluded = await tools.searchTasks({ terms: ["abc123"], include_closed: false, include_subtasks: false });
  assert.ok(!textOf(excluded).includes("task_id: abc123"), "closed subtask must be excluded when both flags are false");
  assert.ok(textOf(excluded).includes("No tasks found"));

  const included = await tools.searchTasks({ terms: ["abc123"], include_closed: true, include_subtasks: true });
  assert.ok(textOf(included).includes("task_id: abc123"), "included when both flags are true");

  // Only one of the flags false is enough to exclude this closed subtask
  const closedOnly = await tools.searchTasks({ terms: ["abc123"], include_closed: false, include_subtasks: true, order_by: "created" });
  assert.ok(!textOf(closedOnly).includes("task_id: abc123"));
  await done();
});

test("searchTasks keeps space-name lookups within the request budget", async (t) => {
  const { tools, requests, client, done } = await setup(t, (_p, page) => ({
    body: {
      tasks: page === 0
        ? Array.from({ length: 100 }, (_, i) => makeTask(`sp${i}`, `Task ${i}`, { space: { id: `bs${i}` } }))
        : [makeTask("sp100", "Task 100", { space: { id: "bs100" } })],
    },
  }));

  let spaceListRequests = 0;
  const spaceLookups = new Set<string>();
  client
    .intercept({ path: "/api/v2/team/team1/space", method: "GET" })
    .reply(200, () => {
      spaceListRequests++;
      return { spaces: [{ id: "bs3", name: "Indexed Space" }] };
    })
    .persist();
  client
    .intercept({ path: (p: string) => p.startsWith("/api/v2/space/"), method: "GET" })
    .reply(((opts: { path: string }) => {
      const id = opts.path.split("/").pop()!;
      spaceLookups.add(id);
      return { statusCode: 200, data: JSON.stringify({ id, name: `Space ${id}` }), responseOptions: { headers: { "content-type": "application/json" } } };
    }) as any)
    .persist();

  const result = await tools.searchTasks({ tags: ["many-spaces"], limit: 200 });
  const text = textOf(result);

  assert.equal(result.content.length, 102, "summary + 101 tasks");
  assert.equal(requests.length, 2, "two task pages");
  assert.equal(spaceListRequests, 1, "one cold-cache spaces request");
  assert.ok(spaceLookups.size <= 10, `at most 10 individual space lookups, got ${spaceLookups.size}`);
  assert.equal(spaceLookups.size, 10);
  assert.ok(text.includes("space: Indexed Space (bs3)"), "name resolved from the space list without a lookup");
  assert.ok(!spaceLookups.has("bs3"));
  assert.ok(text.includes("space_id: bs100"), "beyond the budget only the id is printed");
  await done();
});
