import { test } from "node:test";
import assert from "node:assert/strict";
import {
  convertClickUpTextItemsToToolCallResult,
  convertMarkdownToClickUpBlocks,
} from "../clickup-text";

async function read(items: any[]): Promise<string> {
  const blocks = await convertClickUpTextItemsToToolCallResult(items);
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * No inline marker pair may enclose a line break: the open and close marker of every
 * run must sit on the same line. Checked per marker kind on the text with code spans
 * and link targets masked.
 */
function assertNoMarkerSpansNewline(markdown: string) {
  for (const marker of ["**", "~~", "`", "*"]) {
    const re = new RegExp(`(?<!\\\\)${marker.replace(/[*]/g, "\\*")}`, "g");
    const positions: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(markdown)) !== null) {
      positions.push(m.index);
      if (marker === "**") re.lastIndex = m.index + 2;
    }
    // Markers pair up in order; a pair must not contain a newline between them
    for (let i = 0; i + 1 < positions.length; i += 2) {
      const between = markdown.slice(positions[i], positions[i + 1]);
      assert.ok(
        !between.includes("\n"),
        `marker ${JSON.stringify(marker)} spans a newline in: ${JSON.stringify(markdown)}`
      );
    }
  }
  // Link syntax: no newline inside [label](url)
  for (const link of markdown.matchAll(/\[[^\]]*\]\([^)]*\)/g)) {
    assert.ok(!link[0].includes("\n"), `link spans a newline in: ${JSON.stringify(markdown)}`);
  }
}

const EXPECTED_HEADING_THEN_BULLET = "**What we fixed**\n\n- **The email preview pop-up was too tall.**";

const shape1 = [
  { text: "What we fixed", attributes: { bold: true } },
  { text: "\n", attributes: {} },
  { text: "\n", attributes: {} },
  { text: "The email preview pop-up was too tall.", attributes: { bold: true } },
  { text: "\n", attributes: { list: { list: "bullet" } } },
];
const shape2 = [
  { text: "What we fixed\n\n", attributes: { bold: true } },
  { text: "The email preview pop-up was too tall.", attributes: { bold: true } },
  { text: "\n", attributes: { list: { list: "bullet" } } },
];
const shape3 = [
  { text: "What we fixed", attributes: { bold: true } },
  { text: "\n\n", attributes: { bold: true } },
  { text: "The email preview pop-up was too tall.", attributes: { bold: true } },
  { text: "\n", attributes: { list: { list: "bullet" } } },
];

test("bold heading followed by a bold bullet: shape 1 (separate empty-attribute newlines)", async () => {
  const text = await read(shape1);
  assert.equal(text, EXPECTED_HEADING_THEN_BULLET);
  assertNoMarkerSpansNewline(text);
});

test("bold heading followed by a bold bullet: shape 2 (newlines inside the bold text op)", async () => {
  const text = await read(shape2);
  assert.equal(text, EXPECTED_HEADING_THEN_BULLET);
  assertNoMarkerSpansNewline(text);
});

test("bold heading followed by a bold bullet: shape 3 (one bold two-newline op)", async () => {
  const text = await read(shape3);
  assert.equal(text, EXPECTED_HEADING_THEN_BULLET);
  assertNoMarkerSpansNewline(text);
});

test("multi-line italic closes and reopens on every line", async () => {
  const text = await read([
    { text: "line one\nline two", attributes: { italic: true } },
    { text: "\n" },
  ]);
  assert.equal(text, "*line one*\n*line two*");
  assertNoMarkerSpansNewline(text);
});

test("multi-line link keeps the target on every line", async () => {
  const text = await read([
    { text: "a\nb", attributes: { link: "https://example.com" } },
    { text: "\n" },
  ]);
  assert.equal(text, "[a](https://example.com)\n[b](https://example.com)");
  assertNoMarkerSpansNewline(text);
});

test("multi-line inline code and strike do not span lines", async () => {
  const code = await read([{ text: "x = 1\ny = 2", attributes: { code: true } }, { text: "\n" }]);
  assert.equal(code, "`x = 1`\n`y = 2`");
  assertNoMarkerSpansNewline(code);

  const strike = await read([{ text: "old\nolder", attributes: { strike: true } }, { text: "\n" }]);
  assert.equal(strike, "~~old~~\n~~older~~");
  assertNoMarkerSpansNewline(strike);
});

test("a blank line inside a formatted op never produces empty markers", async () => {
  const text = await read([{ text: "a\n\nb", attributes: { bold: true } }, { text: "\n" }]);
  assert.equal(text, "**a**\n\n**b**");
  assert.ok(!text.includes("****"));
});

test("a bold run before an image is closed, not carried across the image line", async () => {
  const text = await read([
    { text: "Result", attributes: { bold: true } },
    { type: "image", image: { url: "https://t1.p.clickup-attachments.com/a.png", name: "a.png" } },
    { text: "\n" },
  ]);
  assertNoMarkerSpansNewline(text);
  assert.ok(text.includes("**Result**"), text);
  assert.ok(!text.includes("**Result\n"), text);
});

test("a bold run that continues on the same line still stays one run", async () => {
  const text = await read([
    { text: "one ", attributes: { bold: true } },
    { text: "two", attributes: { bold: true } },
    { text: "\n" },
  ]);
  assert.equal(text, "**one two**");
});

test("a newline-bearing typed segment with no link target stays on one line", async () => {
  const text = await read([
    { type: "widget", text: "first\nsecond", attributes: { bold: true } },
    { text: "\n" },
  ]);
  assertNoMarkerSpansNewline(text);
});

test("shape 1 read output survives the writer and reads back identically", async () => {
  // 1. Read
  const readBack = await read(shape1);
  assert.equal(readBack, EXPECTED_HEADING_THEN_BULLET);

  // 2. Write the read-back markdown again
  const written = convertMarkdownToClickUpBlocks(readBack);
  const heading = written.find((b) => b.text === "What we fixed");
  assert.equal(heading?.attributes?.bold, true, "heading text must be bold");
  const bullet = written.find((b) => b.text === "The email preview pop-up was too tall.");
  assert.equal(bullet?.attributes?.bold, true, "bullet text must be bold");
  const bulletIndex = written.indexOf(bullet!);
  const bulletNewline = written[bulletIndex + 1];
  assert.equal(bulletNewline?.text, "\n");
  assert.equal(bulletNewline?.attributes?.list?.list, "bullet", "bullet text ends in a bullet-list newline");

  // 3. Read those fragments back: same markdown (idempotent), and writing again is stable
  const readAgain = await read(written as any);
  assert.equal(readAgain, readBack);
  assert.deepEqual(convertMarkdownToClickUpBlocks(readAgain), written);
});
