import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

const DROPDOWN = {
  id: "f-drop", name: "Priority Tier", type: "drop_down",
  type_config: { options: [{ id: "opt-a", name: "Gold", orderindex: 0 }, { id: "opt-b", name: "Silver", orderindex: 1 }] },
};
const LABELS = {
  id: "f-labels", name: "Channels", type: "labels",
  type_config: { options: [{ id: "lab-1", label: "Amazon", orderindex: 0 }, { id: "lab-2", label: "TikTok", orderindex: 1 }] },
};
const DATE = { id: "f-date", name: "Go Live", type: "date", type_config: {} };
const CHECKBOX = { id: "f-check", name: "Approved", type: "checkbox", type_config: {} };
const NUMBER = { id: "f-num", name: "Budget", type: "number", type_config: {} };
const TEXT = { id: "f-text", name: "Client", type: "short_text", type_config: {} };
const USERS = { id: "f-users", name: "Reviewers", type: "users", type_config: {} };
const FORMULA = { id: "f-formula", name: "Score", type: "formula", type_config: {} };

async function setup(t: any) {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const mod = await import("../shared/custom-fields");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  const cleanup = async () => {
    await mockAgent.close();
    t.mock.timers.runAll();
    t.mock.timers.reset();
  };
  return { mod, client, cleanup };
}

test("dropdown accepts an option name (case-insensitive) or an option id", async (t) => {
  const { mod, cleanup } = await setup(t);
  assert.deepEqual(await mod.buildCustomFieldValue(DROPDOWN, "silver"), { value: "opt-b" });
  assert.deepEqual(await mod.buildCustomFieldValue(DROPDOWN, "opt-a"), { value: "opt-a" });
  await cleanup();
});

test("dropdown with an unknown option lists the valid options", async (t) => {
  const { mod, cleanup } = await setup(t);
  await assert.rejects(
    () => mod.buildCustomFieldValue(DROPDOWN, "Bronze"),
    (error: Error) => {
      assert.match(error.message, /Unknown option "Bronze" for custom field "Priority Tier"/);
      assert.match(error.message, /"Gold" \(option_id: opt-a\)/);
      assert.match(error.message, /"Silver" \(option_id: opt-b\)/);
      return true;
    }
  );
  await cleanup();
});

test("labels accept option names and ids and produce an array of option ids", async (t) => {
  const { mod, cleanup } = await setup(t);
  assert.deepEqual(await mod.buildCustomFieldValue(LABELS, ["amazon", "lab-2"]), { value: ["lab-1", "lab-2"] });
  assert.deepEqual(await mod.buildCustomFieldValue(LABELS, "TikTok"), { value: ["lab-2"] });
  await assert.rejects(() => mod.buildCustomFieldValue(LABELS, ["Amazon", "Nope"]), /Unknown option "Nope"/);
  await cleanup();
});

test("date converts an ISO string to Unix ms and flags a time of day", async (t) => {
  const { mod, cleanup } = await setup(t);
  assert.deepEqual(await mod.buildCustomFieldValue(DATE, "2025-12-31"), { value: Date.UTC(2025, 11, 31) });
  assert.deepEqual(await mod.buildCustomFieldValue(DATE, "2025-12-31T14:30:00+01:00"), {
    value: Date.UTC(2025, 11, 31, 13, 30),
    value_options: { time: true },
  });
  assert.deepEqual(await mod.buildCustomFieldValue(DATE, 1767139200000), { value: 1767139200000 });
  assert.deepEqual(await mod.buildCustomFieldValue(DATE, "1767139200000"), { value: 1767139200000 });
  await assert.rejects(() => mod.buildCustomFieldValue(DATE, "next tuesday"), /needs an ISO date/);
  await cleanup();
});

test("checkbox accepts booleans and the strings true/false", async (t) => {
  const { mod, cleanup } = await setup(t);
  assert.deepEqual(await mod.buildCustomFieldValue(CHECKBOX, true), { value: true });
  assert.deepEqual(await mod.buildCustomFieldValue(CHECKBOX, "TRUE"), { value: true });
  assert.deepEqual(await mod.buildCustomFieldValue(CHECKBOX, "false"), { value: false });
  await assert.rejects(() => mod.buildCustomFieldValue(CHECKBOX, "maybe"), /needs true or false/);
  await cleanup();
});

test("number accepts numbers and numeric strings, rejects the rest", async (t) => {
  const { mod, cleanup } = await setup(t);
  assert.deepEqual(await mod.buildCustomFieldValue(NUMBER, 1500), { value: 1500 });
  assert.deepEqual(await mod.buildCustomFieldValue(NUMBER, "12.5"), { value: 12.5 });
  await assert.rejects(() => mod.buildCustomFieldValue(NUMBER, "abc"), /needs a number/);
  await assert.rejects(() => mod.buildCustomFieldValue(NUMBER, ""), /needs a number/);
  await cleanup();
});

test("users resolve names, emails and ids into add/rem lists", async (t) => {
  const { mod, client, cleanup } = await setup(t);
  client
    .intercept({ path: "/api/v2/team", method: "GET" })
    .reply(200, { teams: [{ id: "team1", members: [{ user: { id: 11, username: "Jane Doe", email: "jane@example.com" } }, { user: { id: 12, username: "Bob", email: "bob@example.com" } }] }] });

  assert.deepEqual(await mod.buildCustomFieldValue(USERS, ["Jane Doe", "99"]), { value: { add: [11, 99], rem: [] } });
  assert.deepEqual(await mod.buildCustomFieldValue(USERS, { rem: ["bob@example.com"] }), { value: { add: [], rem: [12] } });
  await cleanup();
});

test("an unsupported field type is rejected by name", async (t) => {
  const { mod, cleanup } = await setup(t);
  await assert.rejects(
    () => mod.buildCustomFieldValue(FORMULA, "1"),
    (error: Error) => {
      assert.match(error.message, /Custom field "Score" has type "formula"/);
      assert.match(error.message, /Supported types:/);
      return true;
    }
  );
  await cleanup();
});

test("setTaskCustomFields POSTs converted values and DELETEs on null", async (t) => {
  const { mod, client, cleanup } = await setup(t);

  client
    .intercept({ path: "/api/v2/list/list1/field", method: "GET" })
    .reply(200, { fields: [DROPDOWN, DATE, TEXT, NUMBER] });

  const posted: Record<string, any> = {};
  for (const id of ["f-drop", "f-date", "f-text"]) {
    client
      .intercept({ path: `/api/v2/task/task123/field/${id}`, method: "POST" })
      .reply((opts) => {
        posted[id] = JSON.parse(String(opts.body));
        return { statusCode: 200, data: {} };
      });
  }
  let deleted = 0;
  client
    .intercept({ path: "/api/v2/task/task123/field/f-num", method: "DELETE" })
    .reply(() => {
      deleted++;
      return { statusCode: 200, data: {} };
    });

  const result = await mod.setTaskCustomFields("task123", "list1", {
    "priority tier": "Gold", // matched by name, case-insensitive
    "f-date": "2025-12-31T09:00:00Z", // matched by id
    Client: "Acme",
    Budget: null,
  });

  assert.deepEqual(posted["f-drop"], { value: "opt-a" });
  assert.deepEqual(posted["f-date"], { value: Date.UTC(2025, 11, 31, 9), value_options: { time: true } });
  assert.deepEqual(posted["f-text"], { value: "Acme" });
  assert.equal(deleted, 1);
  assert.equal(result.failed.length, 0);
  assert.deepEqual(result.set.map((f) => f.field_id), ["f-drop", "f-date", "f-text", "f-num"]);
  assert.equal(result.set[3].cleared, true);
  await cleanup();
});

test("setTaskCustomFields reports bad fields and still writes the others", async (t) => {
  const { mod, client, cleanup } = await setup(t);

  client
    .intercept({ path: "/api/v2/list/list1/field", method: "GET" })
    .reply(200, { fields: [DROPDOWN, TEXT] });

  let textBody: any;
  client
    .intercept({ path: "/api/v2/task/task123/field/f-text", method: "POST" })
    .reply((opts) => {
      textBody = JSON.parse(String(opts.body));
      return { statusCode: 200, data: {} };
    });

  // The unknown field and the invalid option never reach the API (nothing is intercepted for them).
  const result = await mod.setTaskCustomFields("task123", "list1", {
    Missing: "x",
    "Priority Tier": "Bronze",
    Client: "Acme",
  });

  assert.deepEqual(textBody, { value: "Acme" });
  assert.equal(result.set.length, 1);
  assert.equal(result.failed.length, 2);
  assert.match(result.failed[0].error, /Unknown custom field "Missing"/);
  assert.match(result.failed[1].error, /Unknown option "Bronze"/);
  const lines = mod.formatCustomFieldResult(result);
  assert.match(lines[0], /custom_fields_set: Client \(field_id: f-text\)/);
  assert.match(lines[1], /custom_field_warnings:/);
  await cleanup();
});

test("setTaskCustomFields refuses more than 20 fields", async (t) => {
  const { mod, cleanup } = await setup(t);
  const fields = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, i]));
  await assert.rejects(() => mod.setTaskCustomFields("task123", "list1", fields), /At most 20 custom fields/);
  await cleanup();
});

test("custom field definitions are cached per scope for the refresh interval", async (t) => {
  const { mod, client, cleanup } = await setup(t);
  let requests = 0;
  client
    .intercept({ path: "/api/v2/space/sp1/field", method: "GET" })
    .reply(() => {
      requests++;
      return { statusCode: 200, data: { fields: [TEXT] } };
    });

  const [a, b] = await Promise.all([mod.getCustomFieldDefinitions({ space_id: "sp1" }), mod.getCustomFieldDefinitions({ space_id: "sp1" })]);
  assert.equal(a, b);
  assert.equal(requests, 1);
  assert.throws(() => mod.getCustomFieldDefinitions({}), /exactly one of/);
  assert.throws(() => mod.getCustomFieldDefinitions({ list_id: "a", space_id: "b" }), /exactly one of/);
  await cleanup();
});

test("getCustomFields tool prints fields with options and ids", async (t) => {
  const { client, cleanup } = await setup(t);
  client
    .intercept({ path: "/api/v2/list/list1/field", method: "GET" })
    .reply(200, { fields: [{ ...DROPDOWN, required: true }, LABELS] });

  const { registerWorkspaceTools } = await import("../tools/workspace-tools");
  const tools: Record<string, any> = {};
  registerWorkspaceTools({ tool: (name: string, _d: string, _s: any, _o: any, handler: any) => { tools[name] = handler; } } as any);

  const text = (await tools.getCustomFields({ list_id: "list1" })).content[0].text;
  assert.match(text, /Priority Tier \(field_id: f-drop\) type=drop_down required=true/);
  assert.match(text, /Gold \(option_id: opt-a\)/);
  assert.match(text, /Amazon \(option_id: lab-1\)/);
  assert.match(text, /Channels \(field_id: f-labels\) type=labels required=false/);
  await cleanup();
});
