import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Buffer } from "buffer";
import { stat, readFile } from "fs/promises";
import { basename, extname, isAbsolute, resolve } from "path";
import { fileURLToPath } from "url";
import { CONFIG } from "../shared/config";
import { assertSafeId } from "../shared/ids";
import { parseDataUri } from "../shared/data-uri";
import { getRequestCredentials } from "../shared/request-context";
import { fetchPublicBytes } from "../shared/ssrf";
import { detectMimeTypeFromBuffer, downloadImages } from "../shared/image-processing";
import {
  assertWithinSizeLimit,
  decodeFilePath,
  HOSTED_LOCAL_PATH_ERROR,
  uploadTaskAttachment,
} from "../shared/attachments";
import { ContentBlock } from "../shared/types";

type ToolResult = { isError?: boolean; content: ContentBlock[] };

function text(message: string, isError = false): ToolResult {
  return isError
    ? { isError: true, content: [{ type: "text", text: message }] }
    : { content: [{ type: "text", text: message }] };
}

function fail(prefix: string, error: unknown): ToolResult {
  console.error(prefix, error);
  return text(`${prefix} ${error instanceof Error ? error.message : String(error)}`, true);
}

const GENERIC_MIME = "application/octet-stream";

const EXTENSION_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  yml: "application/yaml",
  yaml: "application/yaml",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

const MIME_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "application/xml": "xml",
  "text/xml": "xml",
  "text/html": "html",
  "application/zip": "zip",
};

/** Extensions whose content is read as text even when the stored mime type is generic */
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "log", "xml", "yml", "yaml", "html", "htm", "svg",
]);

function extensionOf(name: string): string {
  return extname(name).replace(/^\./, "").toLowerCase();
}

/** Lower-case the type and drop parameters such as `; charset=utf-8`. Empty when not a type. */
function normalizeMime(value: string | null | undefined): string {
  const base = (value ?? "").split(";")[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(base) ? base : "";
}

/**
 * Pick the content type for an upload: a specific declared type wins, then the file
 * extension, then the magic bytes of an image, then the generic binary type.
 */
function resolveMimeType(declared: string | null | undefined, filename: string, bytes: Buffer): string {
  const normalized = normalizeMime(declared);
  if (normalized && normalized !== GENERIC_MIME) return normalized;
  const fromExtension = EXTENSION_MIME[extensionOf(filename)];
  if (fromExtension) return fromExtension;
  const detected = detectMimeTypeFromBuffer(new Uint8Array(bytes.subarray(0, 16)).buffer);
  return detected ?? GENERIC_MIME;
}

/** Strip path separators, control characters and quotes; never return an empty or dot-only name. */
function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[/\\]/g, "_")
    .replace(/[\u0000-\u001f\u007f"]/g, "")
    .trim()
    .slice(0, 200);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "attachment";
}

/** An inferred (not user-supplied) name gets an extension from the mime type when it has none. */
function withInferredExtension(name: string, mimeType: string): string {
  if (extensionOf(name)) return name;
  const ext = MIME_EXTENSION[mimeType];
  return ext ? `${name}.${ext}` : name;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const isHosted = () => getRequestCredentials() !== undefined;

/**
 * Plain download for stdio mode: follows redirects, stops reading once maxBytes is
 * exceeded and gives up after a timeout. (Hosted mode uses fetchPublicBytes instead.)
 */
async function fetchBytesLimited(
  url: string,
  maxBytes: number,
  timeoutMs = 30_000
): Promise<{ bytes: Buffer; contentType: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const tooLarge = () =>
    new Error(`${url} is larger than the allowed ${formatBytes(maxBytes)}`);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Could not download ${url}: ${response.status} ${response.statusText}`);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw tooLarge();
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw tooLarge();
        }
        chunks.push(Buffer.from(value));
      }
    }
    return { bytes: Buffer.concat(chunks), contentType: response.headers.get("content-type") };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Could not download ${url}: timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Download a URL with the right guard for the current mode (SSRF-safe when hosted). */
async function downloadBytes(
  url: string,
  maxBytes: number
): Promise<{ bytes: Buffer; contentType: string | null; url: URL }> {
  if (isHosted()) {
    return fetchPublicBytes(url, { maxBytes });
  }
  const { bytes, contentType } = await fetchBytesLimited(url, maxBytes);
  return { bytes, contentType, url: new URL(url) };
}

interface ResolvedFile {
  bytes: Buffer;
  mimeType: string;
  filename: string;
}

/**
 * Turn the `source` of attachFile into bytes plus a filename and content type.
 *
 * Sources: base64 data URI, http(s) URL, or (stdio mode only) a local path / file: URL.
 * Hosted mode refuses local paths and fetches URLs through the SSRF guard (ssrf.ts).
 */
async function resolveFileSource(source: string, filenameOverride?: string): Promise<ResolvedFile> {
  const src = source.trim();
  const uploadLimit = CONFIG.maxUploadSizeMB * 1024 * 1024;
  const finish = (bytes: Buffer, declaredMime: string | null, inferredName: string, label: string): ResolvedFile => {
    assertWithinSizeLimit(bytes.byteLength, label);
    if (bytes.byteLength === 0) {
      throw new Error(`${label} is empty, there is nothing to upload`);
    }
    const mimeType = resolveMimeType(declaredMime, filenameOverride ?? inferredName, bytes);
    const filename = filenameOverride
      ? sanitizeFilename(filenameOverride)
      : sanitizeFilename(withInferredExtension(inferredName, mimeType));
    return { bytes, mimeType, filename };
  };

  if (src.startsWith("data:")) {
    const dataUri = parseDataUri(src);
    if (!dataUri) {
      throw new Error("The data URI is not valid; expected data:<mime type>;base64,<data>");
    }
    const bytes = Buffer.from(dataUri.base64Data, "base64");
    return finish(bytes, dataUri.mimeType, "attachment", "The inline file");
  }

  if (/^https?:\/\//i.test(src)) {
    let result: { bytes: Buffer; contentType: string | null; url: URL };
    try {
      result = await downloadBytes(src, uploadLimit);
    } catch (error) {
      if (error instanceof Error && /is larger than the allowed/.test(error.message)) {
        throw new Error(
          `${src} exceeds the ${CONFIG.maxUploadSizeMB} MB upload limit (raise MAX_UPLOAD_SIZE_MB to allow it)`
        );
      }
      throw error;
    }
    const urlName = safeDecode(basename(result.url.pathname));
    return finish(result.bytes, result.contentType, urlName || "attachment", src);
  }

  if (isHosted()) {
    throw new Error(HOSTED_LOCAL_PATH_ERROR);
  }

  let filePath: string;
  if (/^file:\/\//i.test(src)) {
    filePath = fileURLToPath(src);
  } else {
    filePath = isAbsolute(src) ? src : resolve(process.cwd(), decodeFilePath(src));
  }
  let info;
  try {
    info = await stat(filePath);
  } catch (error: any) {
    if (error?.code === "ENOENT") throw new Error(`No such file: ${filePath}`);
    throw new Error(`Could not read ${filePath}: ${error?.message || "unknown error"}`);
  }
  if (!info.isFile()) {
    throw new Error(`${filePath} is not a regular file`);
  }
  // Check the size before reading so a huge file is never loaded into memory
  assertWithinSizeLimit(info.size, filePath);
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error: any) {
    throw new Error(`Could not read ${filePath}: ${error?.message || "unknown error"}`);
  }
  return finish(bytes, null, basename(filePath), filePath);
}

interface TaskAttachment {
  id: string;
  title?: string;
  extension?: string;
  mimetype?: string;
  size?: number | string;
  url?: string;
  url_w_query?: string;
  thumbnail_small?: string;
  thumbnail_medium?: string;
  thumbnail_large?: string;
  date?: string | number;
  user?: { id?: number | string; username?: string };
}

function attachmentLabel(a: TaskAttachment): string {
  return `${a.title || "(untitled)"} (attachment_id: ${a.id})`;
}

function listAttachments(attachments: TaskAttachment[]): string {
  return attachments.map((a) => `- ${attachmentLabel(a)}${a.mimetype ? ` [${a.mimetype}]` : ""}`).join("\n");
}

function attachmentMime(a: TaskAttachment): string {
  const declared = normalizeMime(a.mimetype);
  if (declared && declared !== GENERIC_MIME) return declared;
  const ext = (a.extension || extensionOf(a.title || "")).replace(/^\./, "").toLowerCase();
  return EXTENSION_MIME[ext] ?? (declared || GENERIC_MIME);
}

function isTextLike(a: TaskAttachment, mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  if (/^application\/(json|xml|yaml|x-yaml|javascript|x-ndjson)$/.test(mime) || /\+(json|xml)$/.test(mime)) {
    return true;
  }
  const ext = (a.extension || extensionOf(a.title || "")).replace(/^\./, "").toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

/** Image types MCP clients can display; others (bmp, tiff, heic ...) are reported as metadata */
const RENDERABLE_IMAGE = /^image\/(png|jpeg|jpg|gif|webp)$/;

function describeAttachment(taskId: string, a: TaskAttachment, mime: string): string {
  const lines = [`Attachment: ${attachmentLabel(a)}`, `Task: ${taskId}`, `Type: ${mime}`];
  const size = Number(a.size);
  if (a.size !== undefined && a.size !== null && Number.isFinite(size)) lines.push(`Size: ${formatBytes(size)}`);
  const timestamp = Number(a.date);
  if (a.date && Number.isFinite(timestamp)) lines.push(`Uploaded: ${new Date(timestamp).toISOString()}`);
  if (a.user?.username) lines.push(`Uploaded by: ${a.user.username}${a.user.id !== undefined ? ` (user_id: ${a.user.id})` : ""}`);
  if (a.url) lines.push(`URL: ${a.url}`);
  return lines.join("\n");
}

async function fetchTaskAttachments(taskId: string): Promise<TaskAttachment[]> {
  const response = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
    headers: { Authorization: CONFIG.authHeader },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Error fetching task ${taskId}: ${response.status} ${response.statusText} ${body}`.trim());
  }
  const task = await response.json();
  return Array.isArray(task?.attachments) ? task.attachments : [];
}

/** Build the response for a text-like attachment, truncated to the response budget. */
function textContent(header: string, bytes: Buffer): ToolResult | null {
  // NUL bytes mean this is binary data that merely carries a text-like name
  if (bytes.subarray(0, 8192).includes(0)) return null;
  const budget = Math.floor(CONFIG.maxResponseSizeMB * 1024 * 1024);
  const truncated = bytes.byteLength > budget;
  let body = bytes.subarray(0, budget).toString("utf8");
  if (truncated) body = body.replace(/�$/, ""); // a multi-byte character cut in half
  const content: ContentBlock[] = [{ type: "text", text: header }, { type: "text", text: body }];
  if (truncated) {
    content.push({
      type: "text",
      text: `[Truncated: showing the first ${formatBytes(budget)} of ${formatBytes(bytes.byteLength)}. Raise MAX_RESPONSE_SIZE_MB to read more, or open the URL.]`,
    });
  }
  return { content };
}

export function registerAttachmentToolsRead(server: McpServer) {
  server.tool(
    "getAttachment",
    [
      "Fetches the content of a task attachment (a file attached to a task, not an image in a comment).",
      "Images (PNG, JPEG, GIF, WebP) are returned as images, text files (.txt, .md, .csv, .json, .log, XML, YAML, HTML ...) as text truncated to the response size limit. Other file types (PDF, Office, archives, video ...) return metadata only: title, size, type and URL.",
      "Find attachment IDs with getTaskById (attachments are listed there), or pass a wrong ID to get the task's attachment list back.",
    ].join("\n"),
    {
      task_id: z.string().min(1).describe("The ID of the task the attachment belongs to"),
      attachment_id: z.string().min(1).describe("The attachment ID, e.g. 4c1b0f2e-....png as shown by getTaskById"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async ({ task_id, attachment_id }) => {
      try {
        task_id = assertSafeId(task_id, "task_id");
        attachment_id = attachment_id.trim();
        // Attachment IDs contain dots (uuid.ext), so assertSafeId does not fit. The ID is only
        // compared against the task's attachments and never put into a URL.
        if (!/^[A-Za-z0-9._-]+$/.test(attachment_id)) {
          throw new Error(`Invalid attachment_id "${attachment_id}"`);
        }

        const attachments = await fetchTaskAttachments(task_id);
        const attachment = attachments.find((a) => a.id === attachment_id);
        if (!attachment) {
          return text(
            attachments.length === 0
              ? `Attachment ${attachment_id} not found: task ${task_id} has no attachments.`
              : `Attachment ${attachment_id} not found on task ${task_id}. Attachments on this task:\n${listAttachments(attachments)}`,
            true
          );
        }

        const mime = attachmentMime(attachment);
        const header = describeAttachment(task_id, attachment, mime);
        const downloadUrl = attachment.url || attachment.url_w_query;
        const size = Number(attachment.size);
        const knownSize = Number.isFinite(size) && attachment.size !== null && attachment.size !== undefined && attachment.size !== "";

        if (!downloadUrl) {
          return text(`${header}\nThis attachment has no download URL.`);
        }

        if (RENDERABLE_IMAGE.test(mime)) {
          // Try the original first, then ClickUp's thumbnails from large to small, so an
          // oversized image degrades to a smaller preview instead of being dropped.
          const candidates = [
            { url: downloadUrl, label: "original" },
            { url: attachment.thumbnail_large, label: "large thumbnail" },
            { url: attachment.thumbnail_medium, label: "medium thumbnail" },
            { url: attachment.thumbnail_small, label: "small thumbnail" },
          ].filter(
            (c, i, all): c is { url: string; label: string } =>
              typeof c.url === "string" && c.url !== "" && all.findIndex((o) => o.url === c.url) === i
          );
          for (const candidate of candidates) {
            const [block] = await downloadImages(
              [{ type: "image_metadata", urls: [candidate.url], alt: attachment.title || attachment.id }],
              1
            );
            if (block?.type === "image") {
              const note =
                candidate.label === "original"
                  ? ""
                  : `\nNote: the original (${knownSize ? formatBytes(size) : "unknown size"}) exceeds the ${CONFIG.maxResponseSizeMB} MB response limit (MAX_RESPONSE_SIZE_MB), so the ${candidate.label} is shown.`;
              return { content: [{ type: "text", text: header + note }, block] };
            }
          }
          return text(
            `${header}\nThe image exceeds the ${CONFIG.maxResponseSizeMB} MB response limit (MAX_RESPONSE_SIZE_MB) or could not be downloaded, and no smaller version was available. Open the URL to view it.`
          );
        }

        if (isTextLike(attachment, mime)) {
          const cap = CONFIG.maxUploadSizeMB * 1024 * 1024;
          if (knownSize && size > cap) {
            return text(
              `${header}\nThe file is larger than ${CONFIG.maxUploadSizeMB} MB, so its content was not downloaded. Open the URL to read it.`
            );
          }
          const { bytes } = await downloadBytes(downloadUrl, cap);
          const result = textContent(header, bytes);
          if (result) return result;
          return text(`${header}\nThe file looks like binary data, so its content is not rendered.`);
        }

        return text(`${header}\nThe content type ${mime} is not rendered by this tool. Open the URL to view or download it.`);
      } catch (error) {
        return fail("Error fetching attachment:", error);
      }
    }
  );
}

export function registerAttachmentToolsWrite(server: McpServer) {
  server.tool(
    "attachFile",
    [
      "Uploads a file of any type (PDF, spreadsheet, archive, image, text ...) to a task as an attachment. To embed an image in a comment or description, use markdown image syntax there instead.",
      "`source` is one of: an http(s) URL, a base64 data URI (data:<mime>;base64,...), or a local file path (only when the server runs locally; the hosted server accepts URLs and data URIs only). Prefer a path or URL over a data URI, which costs tokens in proportion to the file size.",
      `The filename and content type are inferred from the path, URL or data URI; pass \`filename\` to override the name. Files larger than ${CONFIG.maxUploadSizeMB} MB are refused (MAX_UPLOAD_SIZE_MB).`,
    ].join("\n"),
    {
      task_id: z.string().min(1).describe("The ID of the task to attach the file to"),
      source: z
        .string()
        .min(1)
        .describe("Where to read the file from: an http(s) URL, a base64 data URI, or a local file path (local server only)"),
      filename: z
        .string()
        .optional()
        .describe("Name to give the attachment, including its extension. Defaults to the name found in the path or URL."),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async ({ task_id, source, filename }) => {
      try {
        task_id = assertSafeId(task_id, "task_id");
        const file = await resolveFileSource(source, filename?.trim() || undefined);
        const attachment = await uploadTaskAttachment(task_id, file.filename, file.bytes, file.mimeType);
        const lines = [
          `Attached ${attachment.title || attachment.name || file.filename} (attachment_id: ${attachment.id}) to task ${task_id}`,
          `Size: ${formatBytes(file.bytes.byteLength)}`,
          `Type: ${file.mimeType}`,
          `URL: ${attachment.url}`,
          `Read it back with getAttachment (task_id: ${task_id}, attachment_id: ${attachment.id}).`,
        ];
        return text(lines.join("\n"));
      } catch (error) {
        return fail("Error attaching file:", error);
      }
    }
  );
}
