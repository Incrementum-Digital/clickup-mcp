import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

const MEMBERS = [
  { user: { id: 101, username: "Jane Doe", email: "jane@example.com", role: 3 } },
  { user: { id: 102, username: "John Smith", email: "john.smith@example.com", role: 2 } },
  { user: { id: 103, username: "Joan Rivers", email: "joan@example.com", role: 4 } },
  { user: { id: 104, username: "Ann", email: "ann@example.com", role: 3 } },
  { user: { id: 105, username: "Anna Lee", email: "anna.lee@example.com", role: 3 } },
];

async function setup(t: any, members: any[] = MEMBERS, expectTeamRequest = true) {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const mod = await import("../shared/members");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  let teamRequests = 0;
  if (expectTeamRequest) {
    client
      .intercept({ path: "/api/v2/team", method: "GET" })
      .reply(() => {
        teamRequests++;
        return { statusCode: 200, data: { teams: [{ id: "other", members: [] }, { id: "team1", members }] } };
      })
      .persist();
  }

  const cleanup = async () => {
    await mockAgent.close();
    t.mock.timers.runAll();
    t.mock.timers.reset();
  };
  return { mod, client, cleanup, teamRequests: () => teamRequests };
}

test("resolveAssignee passes numeric ids through without a members request", async (t) => {
  const { mod, cleanup } = await setup(t, MEMBERS, false);
  assert.equal(await mod.resolveAssignee("12345"), "12345");
  assert.deepEqual(await mod.resolveAssignees([" 7 ", "8"]), ["7", "8"]);
  await cleanup();
});

test("resolveAssignee matches username and email case-insensitively", async (t) => {
  const { mod, cleanup, teamRequests } = await setup(t);
  assert.equal(await mod.resolveAssignee("jane doe"), "101");
  assert.equal(await mod.resolveAssignee("JOHN.SMITH@EXAMPLE.COM"), "102");
  // The members are loaded once and cached for the following lookups.
  assert.equal(teamRequests(), 1);
  await cleanup();
});

test("resolveAssignee accepts a unique prefix and a unique contains match", async (t) => {
  const { mod, cleanup } = await setup(t);
  assert.equal(await mod.resolveAssignee("jan"), "101"); // prefix of "Jane Doe"
  assert.equal(await mod.resolveAssignee("rivers"), "103"); // contained in "Joan Rivers"
  await cleanup();
});

test("resolveAssignee prefers an exact match over longer prefix matches", async (t) => {
  const { mod, cleanup } = await setup(t);
  assert.equal(await mod.resolveAssignee("ann"), "104"); // "Ann" exactly, "Anna Lee" only by prefix
  await cleanup();
});

test("resolveAssignee rejects an ambiguous name and lists the candidates", async (t) => {
  const { mod, cleanup } = await setup(t);
  await assert.rejects(
    () => mod.resolveAssignee("jo"),
    (error: Error) => {
      assert.match(error.message, /Ambiguous assignee "jo"/);
      assert.match(error.message, /John Smith \(user_id: 102\)/);
      assert.match(error.message, /Joan Rivers \(user_id: 103\)/);
      assert.doesNotMatch(error.message, /Jane Doe/);
      return true;
    }
  );
  await cleanup();
});

test("resolveAssignee rejects an unknown name and lists the known members", async (t) => {
  const { mod, cleanup } = await setup(t);
  await assert.rejects(
    () => mod.resolveAssignee("nobody"),
    (error: Error) => {
      assert.match(error.message, /Unknown assignee "nobody"\. Known members: /);
      assert.match(error.message, /Jane Doe \(user_id: 101\)/);
      return true;
    }
  );
  await cleanup();
});

test("unknown assignee error lists at most 30 members", async (t) => {
  const many = Array.from({ length: 35 }, (_, i) => ({ user: { id: 1000 + i, username: `Person${i}`, email: `p${i}@example.com` } }));
  const { mod, cleanup } = await setup(t, many);
  await assert.rejects(
    () => mod.resolveAssignee("zzz"),
    (error: Error) => {
      assert.match(error.message, /Person29 \(user_id: 1029\)/);
      assert.doesNotMatch(error.message, /Person30 /);
      assert.match(error.message, /and 5 more/);
      return true;
    }
  );
  await cleanup();
});

test("resolveAssignees keeps the order, mixes ids and names and drops duplicates", async (t) => {
  const { mod, cleanup } = await setup(t);
  assert.deepEqual(await mod.resolveAssignees(["john.smith@example.com", "999", "John Smith", "jane"]), ["102", "999", "101"]);
  await cleanup();
});

test("resolveAssignee rejects empty input", async (t) => {
  const { mod, cleanup } = await setup(t, MEMBERS, false);
  await assert.rejects(() => mod.resolveAssignee("  "), /Empty assignee/);
  await cleanup();
});

test("getMembers tool lists workspace members with ids, email and role", async (t) => {
  const { cleanup } = await setup(t);
  const { registerWorkspaceTools } = await import("../tools/workspace-tools");
  const tools: Record<string, any> = {};
  registerWorkspaceTools({ tool: (name: string, _d: string, _s: any, _o: any, handler: any) => { tools[name] = handler; } } as any);

  const result = await tools.getMembers({});
  const text = result.content[0].text;
  assert.match(text, /5 member\(s\) in workspace team1/);
  assert.match(text, /Jane Doe \(user_id: 101\) jane@example\.com role: member/);
  assert.match(text, /John Smith \(user_id: 102\) john\.smith@example\.com role: admin/);
  await cleanup();
});

test("getMembers tool with list_id reads the list members endpoint", async (t) => {
  const { client, cleanup } = await setup(t, MEMBERS, false);
  client
    .intercept({ path: "/api/v2/list/list9/member", method: "GET" })
    .reply(200, { members: [{ id: 7, username: "Zed", email: "zed@example.com" }] });

  const { registerWorkspaceTools } = await import("../tools/workspace-tools");
  const tools: Record<string, any> = {};
  registerWorkspaceTools({ tool: (name: string, _d: string, _s: any, _o: any, handler: any) => { tools[name] = handler; } } as any);

  const result = await tools.getMembers({ list_id: "list9" });
  assert.match(result.content[0].text, /Zed \(user_id: 7\) zed@example\.com/);
  await cleanup();
});
