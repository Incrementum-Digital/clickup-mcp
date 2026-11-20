/**
 * Typed comment segments: link targets and user mentions must survive reading.
 *
 * Fixture provenance: the shapes for `tag` (user mention), `emoticon` and
 * `attributes.link` follow ClickUp's documented comment formatting
 * (https://developer.clickup.com/docs/comment-formatting). The `bookmark`,
 * `attachment`, `frame`/embed and `link_mention` shapes are NOT documented by
 * ClickUp and are assumed here - they exist to prove the generic URL fallback, not
 * as captured payloads. No test in this file talks to ClickUp.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";
import {
  convertClickUpTextItemsToToolCallResult,
  convertMarkdownToClickUpBlocks,
  ClickUpTextItem,
} from "../clickup-text";

async function render(items: ClickUpTextItem[]): Promise<string> {
  const blocks = await convertClickUpTextItemsToToolCallResult(items);
  return blocks
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");
}

const SHEET_URL = "https://docs.google.com/spreadsheets/d/abc";
const ATTACHMENT_URL = "https://t.clickup-attachments.com/x/sheet.xlsx";

test("attributes.link text segments still render as markdown links", async () => {
  const text = await render([
    { text: "see " },
    { text: "the sheet", attributes: { link: SHEET_URL } },
    { text: " now" },
  ]);
  assert.equal(text, `see [the sheet](${SHEET_URL}) now`);
});

test("plain text-only comments render exactly as before", async () => {
  const text = await render([
    { text: "Hello " },
    { text: "world", attributes: { bold: true } },
    { text: "\n" },
    { text: "second line", type: "text" },
    { text: "\n", attributes: { list: { list: "bullet" } } },
  ]);
  assert.equal(text, "Hello **world**\n- second line");
  // Same result as when the segments carry no type at all
  assert.equal(
    await render([{ text: "a" }, { text: "\n" }, { text: "b", attributes: {} }]),
    "a\nb"
  );
});

test("a user mention carries the user id, preferring the username", async () => {
  const text = await render([
    { text: "ping " },
    { type: "tag", text: "@Brian D.", user: { id: 4219961, username: "Brian Dao" } },
    { text: " please" },
  ]);
  assert.equal(text, "ping @Brian Dao (user_id: 4219961) please");
});

test("a user mention without a username falls back to its text, then to unknown", async () => {
  assert.equal(
    await render([{ type: "tag", text: "@Brian Dao", user: { id: 4219961 } }]),
    "@Brian Dao (user_id: 4219961)"
  );
  assert.equal(
    await render([{ type: "tag", user: { id: "77" } }]),
    "@unknown (user_id: 77)"
  );
});

test("a tag without a user id renders its text unchanged", async () => {
  assert.equal(await render([{ type: "tag", text: "@everyone" }]), "@everyone");
  assert.equal(
    await render([{ type: "tag", text: "@everyone", user: {} }]),
    "@everyone"
  );
});

test("emoticons render their text, or the character built from the code", async () => {
  assert.equal(
    await render([{ text: "nice ", attributes: {} }, { type: "emoticon", text: "😊", emoticon: { code: "1f60a" } }]),
    "nice 😊"
  );
  assert.equal(await render([{ type: "emoticon", emoticon: { code: "1f60a" } }]), "😊");
  assert.equal(
    await render([{ type: "emoticon", emoticon: { code: "1f468-200d-1f4bb" } }]),
    "\u{1f468}‍\u{1f4bb}"
  );
});

test("a bookmark segment renders its text as a link to its url", async () => {
  const text = await render([
    { text: "I have added the answers in the " },
    {
      type: "bookmark",
      text: "attached sheet",
      bookmark: { url: SHEET_URL, title: "Hiring feedback" },
    },
    { text: "." },
  ]);
  assert.equal(text, `I have added the answers in the [attached sheet](${SHEET_URL}).`);
});

test("an attachment segment renders its text as a link to the attachment url", async () => {
  const text = await render([
    {
      type: "attachment",
      text: "sheet.xlsx",
      attachment: { id: "a1", title: "sheet.xlsx", url: ATTACHMENT_URL },
    },
  ]);
  assert.equal(text, `[sheet.xlsx](${ATTACHMENT_URL})`);
});

test("a frame segment without text is labelled by the url itself", async () => {
  const text = await render([{ type: "frame", frame: { url: "https://www.youtube.com/watch?v=x" } }]);
  assert.equal(text, "[https://www.youtube.com/watch?v=x](https://www.youtube.com/watch?v=x)");
});

test("a link_mention without text is labelled by its title", async () => {
  const text = await render([
    { type: "link_mention", link_mention: { url: SHEET_URL, title: "Hiring feedback" } },
  ]);
  assert.equal(text, `[Hiring feedback](${SHEET_URL})`);
});

test("an unknown segment type is searched for a url, preferring link-ish keys", async () => {
  const text = await render([
    {
      type: "widget",
      widget: { thumbnail: "https://cdn.example.com/t.png", meta: { href: "https://example.com/real" } },
    },
  ]);
  assert.equal(text, "[https://example.com/real](https://example.com/real)");
});

test("a typed segment with text but no url keeps rendering its text", async () => {
  assert.equal(await render([{ type: "widget", text: "just words", widget: { id: 1 } }]), "just words");
});

test("a typed segment with neither text nor url still falls back to JSON", async () => {
  const segment = { type: "widget", widget: { id: 1 } };
  assert.equal(await render([segment]), JSON.stringify(segment));
});

test("attributes.link on a typed segment is honoured, with a label when text is missing", async () => {
  assert.equal(
    await render([{ type: "widget", text: "open", attributes: { link: SHEET_URL } }]),
    `[open](${SHEET_URL})`
  );
  assert.equal(
    await render([{ type: "widget", widget: { title: "Hiring feedback" }, attributes: { link: SHEET_URL } }]),
    `[Hiring feedback](${SHEET_URL})`
  );
});

test("link labels and urls are escaped so they cannot break the markdown", async () => {
  const text = await render([
    { type: "bookmark", text: "a [b] c", bookmark: { url: "https://example.com/a (1).pdf" } },
  ]);
  assert.equal(text, "[a  b  c](<https://example.com/a (1).pdf>)");
});

test("rendered links keep surrounding inline formatting and block formatting", async () => {
  const text = await render([
    { type: "bookmark", text: "sheet", bookmark: { url: SHEET_URL }, attributes: { bold: true } },
    { text: "\n", attributes: { list: { list: "bullet" } } },
  ]);
  assert.equal(text, `- **[sheet](${SHEET_URL})**`);
});

// ---------------------------------------------------------------------------
// Writer round trip
// ---------------------------------------------------------------------------

test("'@Name (user_id: N)' in markdown is written back as a tag fragment", async () => {
  const read = await render([
    { text: "Hi " },
    { type: "tag", text: "@Brian Dao", user: { id: 4219961, username: "Brian Dao" } },
    { text: ", ok?" },
  ]);
  assert.equal(read, "Hi @Brian Dao (user_id: 4219961), ok?");

  const blocks = convertMarkdownToClickUpBlocks(read);
  assert.deepEqual(blocks, [
    { text: "Hi ", attributes: {} },
    { type: "tag", user: { id: 4219961 } },
    { text: ", ok?", attributes: {} },
  ]);
});

test("a mention inside inline code or a code block stays text", () => {
  const inline = convertMarkdownToClickUpBlocks("Use `@Brian Dao (user_id: 4219961)` literally");
  assert.ok(!inline.some((b) => b.type === "tag"), JSON.stringify(inline));
  assert.ok(inline.some((b) => b.text === "@Brian Dao (user_id: 4219961)" && b.attributes?.code));

  const fenced = convertMarkdownToClickUpBlocks("```\n@Brian Dao (user_id: 4219961)\n```");
  assert.ok(!fenced.some((b) => b.type === "tag"), JSON.stringify(fenced));
  assert.ok(fenced.some((b) => b.text === "@Brian Dao (user_id: 4219961)"));
});

test("mention markdown is only converted for the exact pattern", () => {
  const notDigits = convertMarkdownToClickUpBlocks("@Brian Dao (user_id: abc)");
  assert.ok(!notDigits.some((b) => b.type === "tag"));

  // An address before the mention is not swallowed into its name
  const afterEmail = convertMarkdownToClickUpBlocks("mail me@x.com then @Ann (user_id: 5)");
  const tags = afterEmail.filter((b) => b.type === "tag");
  assert.equal(tags.length, 1);
  assert.deepEqual(tags[0].user, { id: 5 });
  assert.equal(afterEmail.map((b) => b.text ?? "").join(""), "mail me@x.com then ");

  // Inside a link the text is a label, not a mention
  const inLink = convertMarkdownToClickUpBlocks("[@Ann (user_id: 5)](https://example.com)");
  assert.ok(!inLink.some((b) => b.type === "tag"));
});

test("two mentions and formatting in one paragraph", () => {
  const blocks = convertMarkdownToClickUpBlocks("**@Ann (user_id: 5) and @Bo Li (user_id: 6)**");
  const tags = blocks.filter((b) => b.type === "tag").map((b) => b.user!.id);
  assert.deepEqual(tags, [5, 6]);
  assert.ok(blocks.some((b) => b.text === " and " && b.attributes?.bold === true));
});

// ---------------------------------------------------------------------------
// getTaskById: comments and threaded replies
// ---------------------------------------------------------------------------

test("getTaskById keeps link targets and mention ids in comments and replies", async (t) => {
  t.mock.timers.enable();
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";

  const { registerTaskToolsRead } = await import("../tools/task-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const client = mockAgent.get("https://api.clickup.com");

  client.intercept({ path: "/api/v2/team", method: "GET" })
    .reply(200, { teams: [{ id: "team1", members: [] }] });

  client.intercept({ path: /\/api\/v2\/task\/task123\?.*/, method: "GET" })
    .reply(200, {
      id: "task123",
      name: "Test Task",
      markdown_description: "",
      attachments: [],
      creator: { username: "creator", id: "1" },
      assignees: [],
      list: { id: "list1", name: "List" },
      space: { id: "space1", name: "Space" },
      status: { status: "open", type: "open" },
      url: "https://app.clickup.com/t/task123",
      date_created: "0",
      date_updated: "0",
    });

  client.intercept({ path: "/api/v2/task/task123/comment", method: "GET" })
    .reply(200, {
      comments: [
        {
          id: "c1",
          date: "2000",
          comment: [
            { text: "Thanks " },
            { type: "tag", text: "@Brian Dao", user: { id: 4219961, username: "Brian Dao" } },
            { text: ", details in " },
            { text: "the doc", attributes: { link: "https://example.com/doc" } },
            { text: " and the " },
            {
              type: "attachment",
              text: "sheet.xlsx",
              attachment: { id: "a1", title: "sheet.xlsx", url: ATTACHMENT_URL },
            },
            { text: "\n" },
          ],
          user: { id: "u1", username: "alice" },
          reply_count: 1,
        },
      ],
    });

  client.intercept({ path: "/api/v2/comment/c1/reply", method: "GET" })
    .reply(200, {
      comments: [
        {
          id: "r1",
          date: "3000",
          comment: [
            { text: "I have added the answers in the " },
            { type: "bookmark", text: "attached sheet", bookmark: { url: SHEET_URL, title: "Hiring feedback" } },
            { text: ", " },
            { type: "tag", text: "@Alice", user: { id: 99 } },
            { text: "\n" },
          ],
          user: { id: "u2", username: "bob" },
        },
      ],
    });

  client.intercept({ path: "/api/v2/task/task123/time_in_status", method: "GET" })
    .reply(200, { status_history: [], current_status: null });

  client.intercept({ path: /\/api\/v2\/team\/team1\/time_entries.*/, method: "GET" })
    .reply(200, { data: [] });

  const tools: Record<string, any> = {};
  registerTaskToolsRead(
    { tool: (name: string, _d: string, _s: any, _o: any, handler: any) => { tools[name] = handler; } } as any,
    { user: { username: "me", id: "u1" } }
  );

  const result = await tools.getTaskById({ id: "task123" });
  const fullText = result.content
    .filter((block: any) => typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n");

  // Top-level comment
  assert.ok(fullText.includes("@Brian Dao (user_id: 4219961)"), fullText);
  assert.ok(fullText.includes("[the doc](https://example.com/doc)"), fullText);
  assert.ok(fullText.includes(`[sheet.xlsx](${ATTACHMENT_URL})`), fullText);

  // Threaded reply
  const replyIdx = fullText.indexOf("↳ Reply by bob");
  assert.ok(replyIdx !== -1, fullText);
  const replyText = fullText.slice(replyIdx);
  assert.ok(replyText.includes(`[attached sheet](${SHEET_URL})`), replyText);
  assert.ok(replyText.includes("@Alice (user_id: 99)"), replyText);

  // Nothing was dumped as raw JSON
  assert.ok(!fullText.includes('"type":"bookmark"') && !fullText.includes('"type":"attachment"'));

  (mockAgent as any).assertNoPendingInterceptors();
  await mockAgent.close();
  t.mock.timers.reset();
});
