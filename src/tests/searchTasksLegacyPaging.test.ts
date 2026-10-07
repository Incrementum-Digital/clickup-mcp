import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";
import { __resetClickUpFetchState } from "../shared/clickup-fetch";

const base = {
  creator: { username: "creator", id: "1" },
  assignees: [],
  list: { id: "list1", name: "List" },
  space: { id: "space1", name: "Space 1" },
  status: { status: "open", type: "open" },
  date_created: "0",
  date_updated: "0",
};

const makeTasks = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, i) => ({
    ...base,
    id: `${prefix}${i}`,
    name: `Task ${prefix}${i}`,
    url: `https://app.clickup.com/t/${prefix}${i}`,
  }));

async function setup(listId: string) {
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";
  const { registerSearchTools } = await import("../tools/search-tools");

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
  registerSearchTools(serverStub, { user: { username: "me", id: "u1" } });

  // list_ids only -> legacy path. A distinct list id per test keeps the task index cache apart.
  const search = (terms: string[]) => tools.searchTasks({ terms, list_ids: [listId] });
  return { mockAgent, client, search };
}

const textOf = (result: any) => result.content.map((b: any) => b.text || "").join("\n");
const pageOf = (path: string) => Number(/[?&]page=(\d+)/.exec(path)?.[1]);

test("legacy search stops after a short page 0 with exactly one request", async (t) => {
  t.mock.timers.enable();
  const { mockAgent, client, search } = await setup("legacyA");
  try {
    const requestedPages: number[] = [];
    client
      .intercept({ path: /\/api\/v2\/team\/team1\/task.*/, method: "GET" })
      .reply(200, (opts: any) => {
        requestedPages.push(pageOf(opts.path));
        return { tasks: makeTasks(40, "a") };
      })
      .persist();

    const result = await search(["Task a7"]);
    assert.deepEqual(requestedPages, [0], "a short first page must not trigger further requests");
    assert.ok(!result.isError);
    assert.ok(textOf(result).includes("task_id: a7"));
    assert.ok(textOf(result).includes("from 1 page(s)"));
  } finally {
    await mockAgent.close();
    t.mock.timers.reset();
  }
});

test("legacy search pages in waves and stops at the wave containing the first short page", async (t) => {
  t.mock.timers.enable();
  const { mockAgent, client, search } = await setup("legacyB");
  try {
    const requestedPages: number[] = [];
    client
      .intercept({ path: /\/api\/v2\/team\/team1\/task.*/, method: "GET" })
      .reply(200, (opts: any) => {
        const page = pageOf(opts.path);
        requestedPages.push(page);
        // Pages 0 and 1 full, page 2 short, everything after (never expected) is full again
        return { tasks: makeTasks(page === 2 ? 3 : 100, `b${page}_`) };
      })
      .persist();

    const result = await search(["Task b2_1"]);
    assert.deepEqual(
      [...requestedPages].sort((a, b) => a - b),
      [0, 1, 2, 3, 4, 5],
      "page 0 alone, then one wave of 5 pages, nothing beyond",
    );
    assert.ok(!result.isError);
    assert.ok(textOf(result).includes("task_id: b2_1"));
    assert.ok(textOf(result).includes("from 6 page(s)"));
  } finally {
    await mockAgent.close();
    t.mock.timers.reset();
  }
});

test("legacy search surfaces a rate-limit error instead of 'No tasks found'", async (t) => {
  t.mock.timers.enable();
  const { mockAgent, client, search } = await setup("legacyC");
  try {
    // Retry-After far above CLICKUP_RATE_LIMIT_MAX_WAIT_SECONDS: clickupFetch throws at once
    client
      .intercept({ path: /\/api\/v2\/team\/team1\/task.*/, method: "GET" })
      .reply(429, { err: "Rate limit reached" }, { headers: { "retry-after": "3600" } })
      .persist();

    const result = await search(["anything"]);
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /rate limit/i);
    assert.ok(!text.includes("No tasks found"));
  } finally {
    __resetClickUpFetchState();
    await mockAgent.close();
    t.mock.timers.reset();
  }
});

test("legacy search fails on an unparsable 200 page 0 instead of caching an empty result", async (t) => {
  t.mock.timers.enable();
  const { mockAgent, client, search } = await setup("legacyD");
  try {
    client
      .intercept({ path: /\/api\/v2\/team\/team1\/task.*/, method: "GET" })
      .reply(200, "not json")
      .persist();

    const result = await search(["anything"]);
    assert.equal(result.isError, true);
    assert.ok(!textOf(result).includes("No tasks found"));
  } finally {
    await mockAgent.close();
    t.mock.timers.reset();
  }
});
