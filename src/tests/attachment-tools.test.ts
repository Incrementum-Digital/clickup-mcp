import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runWithCredentials } from "../shared/request-context";
import { installFakeWeb, restoreFakeWeb } from "./fake-web";

afterEach(() => restoreFakeWeb());

/** A real 4x4 PNG */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8DAwMgAA4xkYCADAKQlBAX9tXpZAAAAAElFTkSuQmCC";
const PNG = Buffer.from(PNG_BASE64, "base64");

const CDN_HOST = "https://t123.p.clickup-attachments.com";
const CDN_URL = `${CDN_HOST}/t123/abc-def/Report.pdf`;
const PUBLIC_IP = "http://93.184.216.34";

const creds = { token: "t", teamId: "team1", userKey: "k" };
const hosted = <T>(fn: () => T) => runWithCredentials(creds, fn);

interface Upload {
  filename: string | null;
  contentType: string | null;
  body: string;
}

interface Harness {
  tools: Record<string, any>;
  mockAgent: MockAgent;
  api: ReturnType<MockAgent["get"]>;
  uploads: Upload[];
}

function bodyToString(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("latin1");
  if (body instanceof Uint8Array) return Buffer.from(body).toString("latin1");
  return String(body ?? "");
}

/** Run a test body against registered attachment tools and a net-connect-disabled MockAgent. */
async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  process.env.CLICKUP_API_KEY = "test-key";
  process.env.CLICKUP_TEAM_ID = "team1";
  const { registerAttachmentToolsRead, registerAttachmentToolsWrite } = await import("../tools/attachment-tools");

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  const tools: Record<string, any> = {};
  const serverStub = {
    tool: (name: string, _d: string, _s: any, _o: any, handler: any) => {
      tools[name] = handler;
    },
  } as any;
  registerAttachmentToolsRead(serverStub);
  registerAttachmentToolsWrite(serverStub);

  try {
    await fn({ tools, mockAgent, api: mockAgent.get("https://api.clickup.com"), uploads: [] });
  } finally {
    await mockAgent.close();
  }
}

function interceptUpload(h: Harness, taskId: string, attachmentId = "up-1.bin") {
  h.api
    .intercept({ path: `/api/v2/task/${taskId}/attachment`, method: "POST" })
    .reply((opts) => {
      const body = bodyToString(opts.body);
      const headers = opts.headers as Record<string, string>;
      h.uploads.push({
        filename: body.match(/filename="([^"]*)"/)?.[1] ?? null,
        contentType: body.match(/Content-Type: ([^\r\n]*)/)?.[1] ?? null,
        body,
      });
      const filename = body.match(/filename="([^"]*)"/)?.[1] ?? "x";
      assert.match(String(headers["content-type"] ?? headers["Content-Type"]), /^multipart\/form-data; boundary=/);
      return {
        statusCode: 200,
        data: { id: attachmentId, name: filename, title: filename, url: `${CDN_HOST}/t123/up/${filename}` },
      };
    });
}

function interceptTask(h: Harness, taskId: string, attachments: any[]) {
  h.api.intercept({ path: `/api/v2/task/${taskId}`, method: "GET" }).reply(200, { id: taskId, attachments });
}

const resultText = (r: any) => r.content.map((b: any) => b.text ?? `[${b.type}]`).join("\n");

async function withLimits(limits: { upload?: number; response?: number }, fn: () => Promise<void>) {
  const { CONFIG } = await import("../shared/config");
  const before = { upload: CONFIG.maxUploadSizeMB, response: CONFIG.maxResponseSizeMB };
  if (limits.upload !== undefined) CONFIG.maxUploadSizeMB = limits.upload;
  if (limits.response !== undefined) CONFIG.maxResponseSizeMB = limits.response;
  try {
    await fn();
  } finally {
    CONFIG.maxUploadSizeMB = before.upload;
    CONFIG.maxResponseSizeMB = before.response;
  }
}

// ---------------------------------------------------------------- attachFile

test("attachFile uploads a data URI with an inferred name and the bytes in the multipart body", () =>
  withHarness(async (h) => {
    interceptUpload(h, "task123", "att-1.txt");
    const data = Buffer.from("hello attachment").toString("base64");
    const result = await h.tools.attachFile({ task_id: "task123", source: `data:text/plain;base64,${data}` });

    assert.ok(!result.isError, resultText(result));
    assert.equal(h.uploads.length, 1);
    assert.equal(h.uploads[0].filename, "attachment.txt");
    assert.equal(h.uploads[0].contentType, "text/plain");
    assert.ok(h.uploads[0].body.includes("hello attachment"));
    const out = resultText(result);
    assert.ok(out.includes("(attachment_id: att-1.txt)"), out);
    assert.ok(out.includes("16 bytes"), out);
    assert.ok(out.includes("text/plain"), out);
    assert.ok(out.includes(`${CDN_HOST}/t123/up/attachment.txt`), out);
  }));

test("attachFile honours an explicit filename and sanitises it", () =>
  withHarness(async (h) => {
    interceptUpload(h, "task123");
    const data = Buffer.from("x").toString("base64");
    await h.tools.attachFile({
      task_id: "task123",
      source: `data:application/pdf;base64,${data}`,
      filename: 'sub/dir\\"evil".pdf',
    });
    assert.equal(h.uploads[0].filename, "sub_dir_evil.pdf");
    assert.equal(h.uploads[0].contentType, "application/pdf");
  }));

test("attachFile downloads a URL (stdio) and names the upload after the URL path and response type", () =>
  withHarness(async (h) => {
    h.mockAgent
      .get("https://files.example.com")
      .intercept({ path: "/docs/Q3%20report.csv", method: "GET" })
      .reply(200, "a,b\n1,2\n", { headers: { "content-type": "text/csv; charset=utf-8" } });
    interceptUpload(h, "task123");

    const result = await h.tools.attachFile({ task_id: "task123", source: "https://files.example.com/docs/Q3%20report.csv" });
    assert.ok(!result.isError, resultText(result));
    assert.equal(h.uploads[0].filename, "Q3 report.csv");
    assert.equal(h.uploads[0].contentType, "text/csv");
    assert.ok(h.uploads[0].body.includes("a,b\n1,2\n"));
  }));

test("attachFile falls back to application/octet-stream and an extension from the mime type", () =>
  withHarness(async (h) => {
    h.mockAgent.get("https://files.example.com").intercept({ path: "/blob", method: "GET" }).reply(200, "xyz");
    interceptUpload(h, "task123");
    await h.tools.attachFile({ task_id: "task123", source: "https://files.example.com/blob" });
    assert.equal(h.uploads[0].filename, "blob");
    assert.equal(h.uploads[0].contentType, "application/octet-stream");
  }));

test("attachFile reads a local path in stdio mode (absolute, and relative to the working directory)", () =>
  withHarness(async (h) => {
    const dir = await mkdtemp(join(tmpdir(), "attach-file-"));
    try {
      const file = join(dir, "notes.md");
      await writeFile(file, "# local notes");
      interceptUpload(h, "task123");
      interceptUpload(h, "task123");

      const abs = await h.tools.attachFile({ task_id: "task123", source: file });
      assert.ok(!abs.isError, resultText(abs));
      assert.equal(h.uploads[0].filename, "notes.md");
      assert.equal(h.uploads[0].contentType, "text/markdown");
      assert.ok(h.uploads[0].body.includes("# local notes"));

      const url = await h.tools.attachFile({ task_id: "task123", source: `file://${file}` });
      assert.ok(!url.isError, resultText(url));
      assert.equal(h.uploads[1].filename, "notes.md");

      const missing = await h.tools.attachFile({ task_id: "task123", source: join(dir, "nope.txt") });
      assert.equal(missing.isError, true);
      assert.match(resultText(missing), /No such file/);

      const directory = await h.tools.attachFile({ task_id: "task123", source: dir });
      assert.equal(directory.isError, true);
      assert.match(resultText(directory), /not a regular file/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }));

test("attachFile refuses local paths and file: URLs in hosted mode without touching the filesystem", () =>
  withHarness(async (h) => {
    const dir = await mkdtemp(join(tmpdir(), "attach-file-"));
    try {
      const file = join(dir, "secret.txt");
      await writeFile(file, "secret");
      for (const source of [file, "secret.txt", "../etc/passwd", `file://${file}`]) {
        const result = await hosted(() => h.tools.attachFile({ task_id: "task123", source }));
        assert.equal(result.isError, true, source);
        assert.match(
          resultText(result),
          /local file paths are not available on the hosted server; use a URL or data URI/,
          source
        );
      }
      assert.equal(h.uploads.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }));

test("attachFile in hosted mode accepts data URIs and public URLs", () =>
  withHarness(async (h) => {
    const web = installFakeWeb({ [`${PUBLIC_IP}/pics/cat.png`]: { body: PNG, headers: { "content-type": "image/png" } } });
    interceptUpload(h, "task123");
    interceptUpload(h, "task123");

    const fromUrl = await hosted(() => h.tools.attachFile({ task_id: "task123", source: `${PUBLIC_IP}/pics/cat.png` }));
    assert.ok(!fromUrl.isError, resultText(fromUrl));
    assert.equal(h.uploads[0].filename, "cat.png");
    assert.equal(h.uploads[0].contentType, "image/png");
    assert.equal(web.calls[0].address, "93.184.216.34");

    const fromData = await hosted(() =>
      h.tools.attachFile({ task_id: "task123", source: `data:image/png;base64,${PNG_BASE64}` })
    );
    assert.ok(!fromData.isError, resultText(fromData));
    assert.equal(h.uploads[1].filename, "attachment.png");
  }));

test("attachFile refuses URLs that point at loopback and internal addresses in hosted mode", () =>
  withHarness(async (h) => {
    // net connect is disabled and nothing is stubbed: a request that slipped through would fail differently
    for (const source of [
      "http://127.0.0.1:8080/a.txt",
      "http://localhost/a.txt",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.1.2.3/a.txt",
      "http://[::1]/a.txt",
    ]) {
      const result = await hosted(() => h.tools.attachFile({ task_id: "task123", source }));
      assert.equal(result.isError, true, source);
      assert.match(resultText(result), /private or internal address/, source);
    }
    assert.equal(h.uploads.length, 0);
  }));

test("attachFile refuses a hosted redirect to an internal address", () =>
  withHarness(async (h) => {
    const web = installFakeWeb({ [`${PUBLIC_IP}/evil`]: { status: 302, headers: { location: "http://127.0.0.1:9/secret" } } });
    const result = await hosted(() => h.tools.attachFile({ task_id: "task123", source: `${PUBLIC_IP}/evil` }));
    assert.equal(result.isError, true);
    assert.match(resultText(result), /private or internal address/);
    assert.equal(web.calls.length, 1, "the redirect target is never connected to");
  }));

test("attachFile enforces the upload size limit for data URIs, URLs (both modes) and local files", () =>
  withHarness(async (h) => {
    await withLimits({ upload: 1 }, async () => {
      const big = Buffer.alloc(1024 * 1024 + 16, 7);
      const justRight = Buffer.alloc(1024 * 1024, 7);

      const dataResult = await h.tools.attachFile({
        task_id: "task123",
        source: `data:application/octet-stream;base64,${big.toString("base64")}`,
      });
      assert.equal(dataResult.isError, true);
      assert.match(resultText(dataResult), /exceeds the 1 MB upload limit/);

      h.mockAgent.get("https://files.example.com").intercept({ path: "/big.bin", method: "GET" }).reply(200, big);
      const urlResult = await h.tools.attachFile({ task_id: "task123", source: "https://files.example.com/big.bin" });
      assert.equal(urlResult.isError, true);
      assert.match(resultText(urlResult), /exceeds the 1 MB upload limit/);

      installFakeWeb({ [`${PUBLIC_IP}/big.bin`]: { body: big } });
      const hostedResult = await hosted(() => h.tools.attachFile({ task_id: "task123", source: `${PUBLIC_IP}/big.bin` }));
      assert.equal(hostedResult.isError, true);
      assert.match(resultText(hostedResult), /exceeds the 1 MB upload limit/);

      const dir = await mkdtemp(join(tmpdir(), "attach-file-"));
      try {
        const file = join(dir, "big.bin");
        await writeFile(file, big);
        const fileResult = await h.tools.attachFile({ task_id: "task123", source: file });
        assert.equal(fileResult.isError, true);
        assert.match(resultText(fileResult), /exceeds the 1 MB upload limit/);

        // exactly at the limit is fine
        await writeFile(file, justRight);
        interceptUpload(h, "task123");
        const okResult = await h.tools.attachFile({ task_id: "task123", source: file });
        assert.ok(!okResult.isError, resultText(okResult));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      assert.equal(h.uploads.length, 1, "only the file within the limit is uploaded");
    });
  }));

test("attachFile rejects empty files, malformed data URIs and bad HTTP statuses without uploading", () =>
  withHarness(async (h) => {
    const empty = await h.tools.attachFile({ task_id: "task123", source: "data:text/plain;base64,=" });
    assert.equal(empty.isError, true);

    const malformed = await h.tools.attachFile({ task_id: "task123", source: "data:text/plain,hello" });
    assert.equal(malformed.isError, true);
    assert.match(resultText(malformed), /data URI is not valid/);

    h.mockAgent.get("https://files.example.com").intercept({ path: "/gone", method: "GET" }).reply(404, "no");
    const notFound = await h.tools.attachFile({ task_id: "task123", source: "https://files.example.com/gone" });
    assert.equal(notFound.isError, true);
    assert.match(resultText(notFound), /404/);
    assert.equal(h.uploads.length, 0);
  }));

test("attachFile reports an upload failure from ClickUp", () =>
  withHarness(async (h) => {
    h.api.intercept({ path: "/api/v2/task/task123/attachment", method: "POST" }).reply(401, "unauthorized");
    const result = await h.tools.attachFile({
      task_id: "task123",
      source: `data:text/plain;base64,${Buffer.from("x").toString("base64")}`,
    });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /failed: 401/);
  }));

test("attachFile and getAttachment reject unsafe ids without any request", () =>
  withHarness(async (h) => {
    const data = `data:text/plain;base64,${Buffer.from("x").toString("base64")}`;
    for (const task_id of ["../list/123", "a/b", "task 1?x=y", "  "]) {
      const attach = await h.tools.attachFile({ task_id, source: data });
      assert.equal(attach.isError, true, task_id);
      assert.match(resultText(attach), /Invalid task_id/, task_id);

      const get = await h.tools.getAttachment({ task_id, attachment_id: "a.png" });
      assert.equal(get.isError, true, task_id);
      assert.match(resultText(get), /Invalid task_id/, task_id);
    }
    for (const attachment_id of ["../x", "a/b.png", "a b", "x?y=1", "a%2Fb"]) {
      const get = await h.tools.getAttachment({ task_id: "task123", attachment_id });
      assert.equal(get.isError, true, attachment_id);
      assert.match(resultText(get), /Invalid attachment_id/, attachment_id);
    }
    // net connect is disabled and nothing is stubbed: any request would have surfaced as a different error
    assert.equal(h.uploads.length, 0);
  }));

// ------------------------------------------------------------- getAttachment

const att = (over: Record<string, any>) => ({
  id: "abc-def.png",
  title: "shot.png",
  extension: "png",
  mimetype: "image/png",
  size: 70,
  url: `${CDN_HOST}/t123/abc-def/shot.png`,
  date: "1700000000000",
  user: { id: 42, username: "Ada" },
  ...over,
});

test("getAttachment returns an image content block for PNG attachments", () =>
  withHarness(async (h) => {
    interceptTask(h, "task123", [att({})]);
    h.mockAgent
      .get(CDN_HOST)
      .intercept({ path: "/t123/abc-def/shot.png", method: "GET" })
      .reply(200, PNG, { headers: { "content-type": "image/png" } });

    const result = await h.tools.getAttachment({ task_id: "task123", attachment_id: "abc-def.png" });
    assert.ok(!result.isError, resultText(result));
    assert.equal(result.content[0].type, "text");
    assert.ok(result.content[0].text.includes("shot.png (attachment_id: abc-def.png)"));
    assert.ok(result.content[0].text.includes("user_id: 42"));
    const image = result.content.find((b: any) => b.type === "image");
    assert.ok(image, "expected an image block");
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.data, PNG_BASE64);
  }));

test("getAttachment falls back to a thumbnail when the image exceeds the response budget", () =>
  withHarness(async (h) => {
    await withLimits({ response: 0.0005 }, async () => {
      const original = Buffer.concat([PNG, Buffer.alloc(2000, 0)]);
      interceptTask(h, "task123", [att({ thumbnail_large: `${CDN_HOST}/t123/abc-def/thumb.png` })]);
      const cdn = h.mockAgent.get(CDN_HOST);
      cdn.intercept({ path: "/t123/abc-def/shot.png", method: "GET" }).reply(200, original);
      cdn.intercept({ path: "/t123/abc-def/thumb.png", method: "GET" }).reply(200, PNG);

      const result = await h.tools.getAttachment({ task_id: "task123", attachment_id: "abc-def.png" });
      assert.ok(!result.isError, resultText(result));
      assert.match(result.content[0].text, /exceeds the .* response limit .* large thumbnail is shown/s);
      assert.equal(result.content.find((b: any) => b.type === "image")?.data, PNG_BASE64);
    });
  }));

test("getAttachment skips an oversized image with a text note when no thumbnail fits", () =>
  withHarness(async (h) => {
    await withLimits({ response: 0.0005 }, async () => {
      interceptTask(h, "task123", [att({})]);
      h.mockAgent
        .get(CDN_HOST)
        .intercept({ path: "/t123/abc-def/shot.png", method: "GET" })
        .reply(200, Buffer.concat([PNG, Buffer.alloc(2000, 0)]));

      const result = await h.tools.getAttachment({ task_id: "task123", attachment_id: "abc-def.png" });
      assert.ok(!result.isError, resultText(result));
      assert.ok(!result.content.some((b: any) => b.type === "image"));
      assert.match(resultText(result), /exceeds the .* response limit/);
      assert.ok(resultText(result).includes("shot.png (attachment_id: abc-def.png)"));
    });
  }));

test("getAttachment returns text files as text and truncates to the response budget", () =>
  withHarness(async (h) => {
    // md with a generic stored mime type is detected by its extension
    interceptTask(h, "task123", [
      att({ id: "n1.md", title: "notes.md", extension: "md", mimetype: "application/octet-stream", url: `${CDN_HOST}/t/n1.md`, size: 11 }),
      att({ id: "big.txt", title: "big.txt", extension: "txt", mimetype: "text/plain", url: `${CDN_HOST}/t/big.txt`, size: 5000 }),
    ]);
    interceptTask(h, "task123", [
      att({ id: "big.txt", title: "big.txt", extension: "txt", mimetype: "text/plain", url: `${CDN_HOST}/t/big.txt`, size: 5000 }),
    ]);
    const cdn = h.mockAgent.get(CDN_HOST);
    cdn.intercept({ path: "/t/n1.md", method: "GET" }).reply(200, "# Hello Ü\n");
    cdn.intercept({ path: "/t/big.txt", method: "GET" }).reply(200, "x".repeat(5000));

    const small = await h.tools.getAttachment({ task_id: "task123", attachment_id: "n1.md" });
    assert.ok(!small.isError, resultText(small));
    assert.equal(small.content[1].text, "# Hello Ü\n");
    assert.ok(!resultText(small).includes("Truncated"));

    await withLimits({ response: 0.001 }, async () => {
      const big = await h.tools.getAttachment({ task_id: "task123", attachment_id: "big.txt" });
      assert.ok(!big.isError, resultText(big));
      const body = big.content[1].text;
      assert.equal(body.length, Math.floor(0.001 * 1024 * 1024));
      assert.ok(big.content[2].text.includes("Truncated"), resultText(big));
    });
  }));

test("getAttachment treats csv/json/log by extension as text but binary-looking data as metadata", () =>
  withHarness(async (h) => {
    const log = att({ id: "run.log", title: "run.log", extension: "log", mimetype: "application/octet-stream", url: `${CDN_HOST}/t/run.log` });
    interceptTask(h, "task123", [log]);
    h.mockAgent.get(CDN_HOST).intercept({ path: "/t/run.log", method: "GET" }).reply(200, Buffer.from([0x4c, 0x00, 0x01, 0x02]));
    const result = await h.tools.getAttachment({ task_id: "task123", attachment_id: "run.log" });
    assert.ok(!result.isError, resultText(result));
    assert.match(resultText(result), /looks like binary data/);

    interceptTask(h, "task123", [att({ id: "d.json", title: "d.json", extension: "json", mimetype: "application/json", url: `${CDN_HOST}/t/d.json` })]);
    h.mockAgent.get(CDN_HOST).intercept({ path: "/t/d.json", method: "GET" }).reply(200, '{"a":1}');
    const json = await h.tools.getAttachment({ task_id: "task123", attachment_id: "d.json" });
    assert.equal(json.content[1].text, '{"a":1}');
  }));

test("getAttachment returns metadata only for other types without downloading them", () =>
  withHarness(async (h) => {
    // no CDN interceptor: a download attempt would fail the call
    interceptTask(h, "task123", [
      att({ id: "r.pdf", title: "Report.pdf", extension: "pdf", mimetype: "application/pdf", size: 2 * 1024 * 1024, url: CDN_URL }),
    ]);
    const result = await h.tools.getAttachment({ task_id: "task123", attachment_id: "r.pdf" });
    assert.ok(!result.isError, resultText(result));
    assert.equal(result.content.length, 1);
    const out = result.content[0].text;
    assert.ok(out.includes("Report.pdf (attachment_id: r.pdf)"));
    assert.ok(out.includes("application/pdf"));
    assert.ok(out.includes("2.0 MB"));
    assert.ok(out.includes(CDN_URL));
    assert.match(out, /is not rendered by this tool/);
  }));

test("getAttachment lists the task's attachments when the id is unknown", () =>
  withHarness(async (h) => {
    interceptTask(h, "task123", [
      att({}),
      att({ id: "r.pdf", title: "Report.pdf", mimetype: "application/pdf" }),
    ]);
    const result = await h.tools.getAttachment({ task_id: "task123", attachment_id: "nope.png" });
    assert.equal(result.isError, true);
    const out = resultText(result);
    assert.ok(out.includes("nope.png not found"));
    assert.ok(out.includes("- shot.png (attachment_id: abc-def.png)"));
    assert.ok(out.includes("- Report.pdf (attachment_id: r.pdf)"));

    interceptTask(h, "task123", []);
    const none = await h.tools.getAttachment({ task_id: "task123", attachment_id: "nope.png" });
    assert.equal(none.isError, true);
    assert.match(resultText(none), /has no attachments/);
  }));

test("getAttachment surfaces a task lookup failure", () =>
  withHarness(async (h) => {
    h.api.intercept({ path: "/api/v2/task/task123", method: "GET" }).reply(404, "not found");
    const result = await h.tools.getAttachment({ task_id: "task123", attachment_id: "a.png" });
    assert.equal(result.isError, true);
    assert.match(resultText(result), /Error fetching task task123: 404/);
  }));

test("getAttachment in hosted mode downloads through the SSRF guard", () =>
  withHarness(async (h) => {
    interceptTask(h, "task123", [
      att({ id: "ok.txt", title: "ok.txt", extension: "txt", mimetype: "text/plain", url: `${PUBLIC_IP}/ok.txt` }),
    ]);
    interceptTask(h, "task123", [
      att({ id: "evil.txt", title: "evil.txt", extension: "txt", mimetype: "text/plain", url: "http://127.0.0.1:9/secret.txt" }),
    ]);
    interceptTask(h, "task123", [att({ url: "http://169.254.169.254/latest/meta-data/" })]);
    const web = installFakeWeb({ [`${PUBLIC_IP}/ok.txt`]: { body: "public text" } });

    const ok = await hosted(() => h.tools.getAttachment({ task_id: "task123", attachment_id: "ok.txt" }));
    assert.ok(!ok.isError, resultText(ok));
    assert.equal(ok.content[1].text, "public text");

    const evil = await hosted(() => h.tools.getAttachment({ task_id: "task123", attachment_id: "evil.txt" }));
    assert.equal(evil.isError, true);
    assert.match(resultText(evil), /private or internal address/);

    // an image whose URL is internal is skipped with a note, never fetched
    const image = await hosted(() => h.tools.getAttachment({ task_id: "task123", attachment_id: "abc-def.png" }));
    assert.ok(!image.content.some((b: any) => b.type === "image"));
    assert.deepEqual(web.calls.map((c) => c.url.href), [`${PUBLIC_IP}/ok.txt`], "only the public URL reached the transport");
  }));
