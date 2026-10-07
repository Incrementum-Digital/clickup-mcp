import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";

test("updateListInfo appends description", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerListToolsWrite } = await import("../tools/list-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client
    .intercept({ path: "/api/v2/list/list123?include_markdown_description=true", method: "GET" })
    .reply(200, { id: "list123", name: "List", markdown_description: "existing" });

  let bodyCaptured: any;
  client
    .intercept({ path: "/api/v2/list/list123", method: "PUT" })
    .reply((opts) => {
      bodyCaptured = JSON.parse(String(opts.body));
      return { statusCode: 200, data: {} };
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

  registerListToolsWrite(serverStub);

  const result = await tools.updateListInfo({ list_id: "list123", append_description: "Extra" });

  assert.ok(bodyCaptured.markdown_content.includes("Extra"));
  assert.ok(bodyCaptured.markdown_content.includes("**Edit ("));
  assert.ok(result.content[0].text.includes("Successfully appended content"));

  await mockAgent.close();
  t.mock.timers.runAll();
  t.mock.timers.reset();
});

async function setupUpdate(t: any) {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";
  const { registerListToolsWrite } = await import("../tools/list-tools");
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");
  const tools: Record<string, any> = {};
  registerListToolsWrite({ tool: (n: string, _d: string, _s: any, _o: any, h: any) => { tools[n] = h; } } as any);
  const cleanup = async () => {
    await mockAgent.close();
    t.mock.timers.runAll();
    t.mock.timers.reset();
  };
  return { client, tools, cleanup };
}

test("updateListInfo content replaces the description without reading it", async (t) => {
  const { client, tools, cleanup } = await setupUpdate(t);
  let body: any;
  client.intercept({ path: "/api/v2/list/list123", method: "PUT" }).reply((opts) => {
    body = JSON.parse(String(opts.body));
    return { statusCode: 200, data: {} };
  });
  const result = await tools.updateListInfo({ list_id: "list123", content: "Brand new" });
  assert.deepEqual(body, { markdown_content: "Brand new" });
  assert.match(result.content[0].text, /replaced the whole description/);
  await cleanup();
});

test("updateListInfo name only renames", async (t) => {
  const { client, tools, cleanup } = await setupUpdate(t);
  let body: any;
  client.intercept({ path: "/api/v2/list/list123", method: "PUT" }).reply((opts) => {
    body = JSON.parse(String(opts.body));
    return { statusCode: 200, data: {} };
  });
  const result = await tools.updateListInfo({ list_id: "list123", name: "Renamed" });
  assert.deepEqual(body, { name: "Renamed" });
  assert.match(result.content[0].text, /renamed to "Renamed"/);
  await cleanup();
});

test("updateListInfo rejects content with append_description, nothing to update and bad ids", async (t) => {
  const { tools, cleanup } = await setupUpdate(t);
  const both = await tools.updateListInfo({ list_id: "list123", content: "a", append_description: "b" });
  assert.equal(both.isError, true);
  assert.match(both.content[0].text, /either append_description or content/);
  const none = await tools.updateListInfo({ list_id: "list123" });
  assert.equal(none.isError, true);
  const bad = await tools.updateListInfo({ list_id: "../x", name: "n" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /Invalid list_id/);
  await cleanup();
});
