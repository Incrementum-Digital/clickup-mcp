import { CallToolResult } from "@modelcontextprotocol/sdk/types";
import { Buffer } from "buffer";
import { ImageMetadataBlock } from "./shared/types";
import { parseDataUri } from "./shared/data-uri";
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, PhrasingContent, Link, Text, Content, Heading, Paragraph, Blockquote, List, ListItem, Code, Table, TableRow, TableCell } from 'mdast';

/**
 * Represents a ClickUp text item which can be plain text or an image
 */
export interface ClickUpTextItem {
  text?: string;
  type?: string;
  task_mention?: {
    task_id?: string;
  };
  image?: {
    id?: string;
    name?: string;
    title?: string;
    type?: string;
    extension?: string;
    thumbnail_large?: string;
    thumbnail_medium?: string;
    thumbnail_small?: string;
    url: string;
    uploaded?: boolean;
  };
  /** User mention payload on `type: "tag"` segments */
  user?: {
    id?: number | string;
    username?: string;
    email?: string;
    [key: string]: any;
  };
  /** Emoji payload on `type: "emoticon"` segments; `code` is the hex code point(s) */
  emoticon?: {
    code?: string;
    [key: string]: any;
  };
  attributes?: any;
  /** Typed segments (bookmark, attachment, embed, ...) carry their own payload key */
  [key: string]: any;
}

/**
 * Represents a ClickUp attachment
 */
export interface ClickUpAttachment {
  thumbnail_large?: string;
  thumbnail_medium?: string;
  thumbnail_small?: string;
  url: string;
  [key: string]: any;
}

/**
 * Extract thumbnail URLs from data-attachment attribute JSON
 * ClickUp API sometimes has broken thumbnail URLs, but data-attachment contains working ones
 */
function extractThumbnailsFromDataAttachment(attributes?: any): {
  thumbnail_large?: string;
  thumbnail_medium?: string;
  thumbnail_small?: string;
} {
  if (!attributes || !attributes['data-attachment']) {
    return {};
  }

  try {
    const attachmentData = JSON.parse(attributes['data-attachment']);
    return {
      thumbnail_large: attachmentData.thumbnail_large,
      thumbnail_medium: attachmentData.thumbnail_medium,
      thumbnail_small: attachmentData.thumbnail_small,
    };
  } catch (error) {
    console.error('Error parsing data-attachment:', error);
    return {};
  }
}

/**
 * Render an image reference as markdown, escaping whatever would break the syntax.
 *
 * Reading and writing use the same markdown here on purpose: it lets an agent feed a
 * comment it just read straight back into editComment without losing the images.
 */
function toMarkdownImage(alt: string, url: string): string {
  const safeAlt = alt.replace(/[\[\]\r\n]/g, " ").trim();
  // Angle brackets let a URL with spaces or parentheses survive the round trip
  const safeUrl = /[\s()]/.test(url) ? `<${url}>` : url;
  return `![${safeAlt}](${safeUrl})`;
}

const HTTP_URL_PATTERN = /^https?:\/\//i;
// Keys that hold a link target, in order of preference
const SEGMENT_URL_KEYS = ['url', 'link', 'href', 'src', 'source'];
// Keys that hold a human-readable name for a segment's payload
const SEGMENT_LABEL_KEYS = ['title', 'name', 'filename'];
const MAX_SEGMENT_SEARCH_DEPTH = 3;
// Root-level keys the payload search does not look into
const SEGMENT_SEARCH_SKIP = new Set(['attributes']);

function asHttpUrl(value: unknown): string | undefined {
  return typeof value === 'string' && HTTP_URL_PATTERN.test(value.trim()) ? value.trim() : undefined;
}

function nestedValues(value: object, skipKeys?: Set<string>): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return Object.entries(value)
    .filter(([key]) => !skipKeys?.has(key))
    .map(([, child]) => child);
}

// Keys whose URLs are incidental (who the segment belongs to, a preview image), not
// the link target. Only skipped when accepting "any URL-shaped string".
const INCIDENTAL_URL_KEY = /avatar|profile|picture|thumbnail|icon/i;

function isIncidentalUrlKey(key: string): boolean {
  return key === 'user' || INCIDENTAL_URL_KEY.test(key);
}

/**
 * Bounded search for an http(s) URL in a segment's payload. The first pass only
 * looks at keys that are meant to hold a link; the second accepts any URL-shaped
 * string, except under the nested `user` object and avatar/profile/thumbnail-like keys.
 */
function findSegmentUrl(
  value: unknown,
  preferredOnly: boolean,
  depth = 0,
  skipKeys?: Set<string>
): string | undefined {
  if (depth > MAX_SEGMENT_SEARCH_DEPTH || value === null || typeof value !== 'object') {
    return undefined;
  }
  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (preferredOnly) {
      for (const key of SEGMENT_URL_KEYS) {
        const found = skipKeys?.has(key) ? undefined : asHttpUrl(record[key]);
        if (found) return found;
      }
    } else {
      for (const [key, child] of Object.entries(record)) {
        if (skipKeys?.has(key) || isIncidentalUrlKey(key)) continue;
        const found = asHttpUrl(child);
        if (found) return found;
      }
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (!Array.isArray(value) && skipKeys?.has(key)) continue;
    if (!preferredOnly && isIncidentalUrlKey(key)) continue;
    const found = findSegmentUrl(child, preferredOnly, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function findSegmentLabel(value: unknown, depth = 0, skipKeys?: Set<string>): string | undefined {
  if (depth > MAX_SEGMENT_SEARCH_DEPTH || value === null || typeof value !== 'object') {
    return undefined;
  }
  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of SEGMENT_LABEL_KEYS) {
      const candidate = record[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  }
  for (const child of nestedValues(value, skipKeys)) {
    const found = findSegmentLabel(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** `data-attachment` holds the attachment object as a JSON string; ignore it if unparseable */
function parseDataAttachment(attributes: any): unknown {
  const raw = attributes?.['data-attachment'];
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Render `[label](url)` inline, escaping what would break the syntax (same rules as images) */
function toMarkdownLink(label: string, url: string): string {
  const safeLabel = label.replace(/[\[\]\r\n]/g, ' ').trim() || url;
  const encodedUrl = url.replace(/</g, '%3C').replace(/>/g, '%3E');
  const safeUrl = /[\s()]/.test(encodedUrl) ? `<${encodedUrl}>` : encodedUrl;
  return `[${safeLabel}](${safeUrl})`;
}

/** Emoji from a hex code point string such as "1f60a" or "1f468-200d-1f4bb" */
function emoticonCodeToChar(code: unknown): string | undefined {
  if (typeof code !== 'string' || !code.trim()) return undefined;
  try {
    const points = code.trim().split(/[-_\s]+/).map((hex) => {
      if (!/^[0-9a-f]{1,6}$/i.test(hex)) throw new Error('not hex');
      return parseInt(hex, 16);
    });
    return String.fromCodePoint(...points);
  } catch {
    return undefined;
  }
}

const SUMMARY_SENSITIVE_KEY = /token|secret|key|password|auth|email/i;
const SUMMARY_DATA_URI = /^\s*data:/i;
const SUMMARY_MAX_FIELDS = 6;
const SUMMARY_MAX_VALUE_LENGTH = 80;
const SUMMARY_MAX_KEY_LENGTH = 40;
const SUMMARY_MAX_LENGTH = 300;

function summaryText(value: string, maxLength: number): string {
  const flat = value.replace(/[\[\]\r\n]/g, ' ').trim();
  return flat.length > maxLength ? flat.slice(0, maxLength) + '\u2026' : flat;
}

/**
 * Bounded stand-in for a segment we cannot render: `[<type> segment: k1=v1, k2=v2 (+N fields omitted)]`.
 * Only top-level and one-level-nested string/number/boolean fields are candidates.
 * Fields named like a credential or an e-mail, and `data:` URIs, are never shown;
 * values are cut to 80 characters, at most 6 fields are shown and the whole summary
 * stays within 300 characters (fields are dropped from the end until it fits).
 * Values are escaped like plain text so a mention-looking value cannot become a tag.
 */
function summarizeSegment(item: ClickUpTextItem): string {
  const typeName =
    (typeof item.type === 'string' && summaryText(item.type, SUMMARY_MAX_KEY_LENGTH)) || 'unknown';
  const fields: string[] = [];
  let omitted = 0;

  const consider = (path: string, keys: string[], value: unknown) => {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      omitted++;
      return;
    }
    const sensitive = keys.some((key) => SUMMARY_SENSITIVE_KEY.test(key));
    if (sensitive || (typeof value === 'string' && SUMMARY_DATA_URI.test(value)) || fields.length >= SUMMARY_MAX_FIELDS) {
      omitted++;
      return;
    }
    fields.push(
      `${summaryText(path, SUMMARY_MAX_KEY_LENGTH)}=${escapeUserMentionText(summaryText(String(value), SUMMARY_MAX_VALUE_LENGTH))}`
    );
  };

  for (const [key, value] of Object.entries(item)) {
    if (key === 'type' || key === 'text') continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [childKey, child] of Object.entries(value)) {
        consider(`${key}.${childKey}`, [key, childKey], child);
      }
    } else if (value !== null && value !== undefined) {
      consider(key, [key], value);
    }
  }

  const build = () =>
    `[${typeName} segment` +
    (fields.length ? `: ${fields.join(', ')}` : '') +
    (omitted ? `${fields.length ? ' ' : ': '}(+${omitted} fields omitted)` : '') +
    ']';
  while (build().length > SUMMARY_MAX_LENGTH && fields.length > 0) {
    fields.pop();
    omitted++;
  }
  return build();
}

/**
 * A mention name that always survives USER_MENTION_PATTERN: no '@', no embedded
 * "(user_id:" that could be read as the id, one line, at most MAX_MENTION_NAME_LENGTH.
 */
function sanitizeMentionName(raw: string): string {
  const name = raw
    .replace(/@/g, '(at)')
    .replace(/\(user_id:/gi, '[user_id:')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MENTION_NAME_LENGTH)
    .trim();
  return name || 'unknown';
}

/**
 * Render the typed segments the plain-text branch would otherwise flatten (user
 * mentions) or mishandle (bookmarks, attachments, embeds: typed, carry a `text` label,
 * and hide their link target in a payload). Returns the text to use in place of the
 * segment's own, or null to leave the segment to the existing branches.
 *
 * `image`, `task_mention` and plain text segments are handled by their own branches.
 */
function renderTypedSegment(item: ClickUpTextItem): string | null {
  const type = item.type;
  if (type === 'image' || type === 'task_mention' || type === 'text') {
    return null;
  }

  if (type === 'tag') {
    // User mention. Carry the id so an agent can address the person, and so the
    // writer can turn "@Name (user_id: N)" back into a real mention.
    const userId = item.user?.id;
    if (userId === undefined || userId === null || userId === '') {
      return null;
    }
    const username = typeof item.user?.username === 'string' ? item.user.username.trim() : '';
    const fromText = typeof item.text === 'string' ? item.text.replace(/^\s*@/, '').trim() : '';
    // No e-mail fallback: it would leak an address into the output
    return `@${sanitizeMentionName(username || fromText)} (user_id: ${userId})`;
  }

  if (type === 'emoticon') {
    if (typeof item.text === 'string' && item.text) {
      return null;
    }
    return emoticonCodeToChar(item.emoticon?.code) ?? null;
  }

  // Any other typed segment, or an untyped one without text: surface its link target
  if (type === undefined && typeof item.text === 'string') {
    return null;
  }

  const label = typeof item.text === 'string' ? item.text.trim() : '';
  const attributeLink = item.attributes?.link;
  if (typeof attributeLink === 'string' && attributeLink) {
    // The text branch wraps this in the link; it only needs a label to wrap
    if (label) {
      return null;
    }
    const name = findSegmentLabel(item, 0, SEGMENT_SEARCH_SKIP) ?? attributeLink;
    return name.replace(/[\[\]\r\n]/g, ' ').trim() || attributeLink;
  }

  const dataAttachment = parseDataAttachment(item.attributes);
  const url =
    findSegmentUrl(item, true, 0, SEGMENT_SEARCH_SKIP) ??
    findSegmentUrl(dataAttachment, true) ??
    findSegmentUrl(item, false, 0, SEGMENT_SEARCH_SKIP) ??
    findSegmentUrl(dataAttachment, false);
  if (!url) {
    // Nothing to link to. Text keeps the segment visible; without any (missing or only
    // whitespace; a bare newline is a line terminator, left to the text branch) render
    // a summary instead of letting it vanish.
    const hasText = typeof item.text === 'string';
    if (!hasText || (item.text!.trim() === '' && !item.text!.includes('\n'))) {
      return summarizeSegment(item);
    }
    return null;
  }

  const resolvedLabel =
    label ||
    findSegmentLabel(item, 0, SEGMENT_SEARCH_SKIP) ||
    findSegmentLabel(dataAttachment) ||
    url;
  return toMarkdownLink(resolvedLabel, url);
}

/** Whether the line this segment sits on is closed by a code-block newline */
function lineEndsInCodeBlock(textItems: ClickUpTextItem[], index: number): boolean {
  for (let j = index + 1; j < textItems.length; j++) {
    const next = textItems[j];
    if (next.text === '\n') {
      return Boolean(next.attributes?.['code-block']);
    }
  }
  return false;
}

/**
 * Process an array of ClickUp text items into a structured content format
 * that includes both text and images in their original sequence
 *
 * @param textItems Array of text items from ClickUp API
 * @returns Promise resolving to an array of content blocks (text and images)
 */
export async function convertClickUpTextItemsToToolCallResult(
  textItems: ClickUpTextItem[]
): Promise<(CallToolResult["content"][number] | ImageMetadataBlock)[]> {
  const contentBlocks: (CallToolResult["content"][number] | ImageMetadataBlock)[] = [];
  let currentTextBlock = "";
  let currentLine = ""; // Track current line separately for block formatting

  // Track current formatting state to avoid unnecessary close/reopen
  let activeBold = false;
  let activeItalic = false;
  let activeStrike = false;
  let activeCode = false;

  // ClickUp emits one '\n' fragment with a code-block attribute per code LINE;
  // consecutive ones belong to the same fenced block when read back as markdown.
  let inCodeBlock = false;
  let currentFenceLang = '';
  const closeCodeFence = () => {
    if (inCodeBlock) {
      currentTextBlock += '```\n';
      inCodeBlock = false;
      currentFenceLang = '';
    }
  };

  for (let i = 0; i < textItems.length; i++) {
    let item = textItems[i];

    // Typed segments (mentions, bookmarks, attachments, embeds...) are rendered to text
    // up front, then flow through the same inline formatting as plain text
    const typedText = renderTypedSegment(item);
    if (typedText !== null) {
      item = { ...item, text: typedText, type: undefined };
    }

    // Handle image items
    if (item.type === "image" && item.image && item.image.url) {
      closeCodeFence();
      const imageFileName = item.image.name || item.image.title || "image";
      const imageUrl = item.image.url;
      const altText = item.text || imageFileName;

      if (imageUrl.startsWith("data:")) {
        const parsedData = parseDataUri(imageUrl);
        currentTextBlock += `\nImage: ${imageFileName} - [inline image data]`;

        if (currentTextBlock.trim()) {
          contentBlocks.push({
            type: "text" as const,
            text: currentTextBlock.trim(),
          });
        }

        currentTextBlock = "";

        if (parsedData) {
          contentBlocks.push({
            type: "image_metadata",
            urls: [],
            alt: altText,
            inlineData: parsedData,
          });
        } else {
          console.error(`Unable to parse inline image data for ${imageFileName}`);
          contentBlocks.push({
            type: "text" as const,
            text: `[Image "${altText}" omitted: unsupported inline data URI]`,
          });
        }
        continue;
      }

      // Reference the image in the same markdown syntax the write tools accept, so a
      // comment read here can be handed back to editComment unchanged and keep its
      // images - an existing ClickUp attachment URL is re-embedded without re-uploading.
      currentTextBlock += `\n${toMarkdownImage(altText, imageUrl)}`;

      // Get working thumbnail URLs from data-attachment if available
      const extractedThumbnails = extractThumbnailsFromDataAttachment(item.attributes);
      
      // Determine best thumbnail URLs (prefer extracted over API thumbnails)
      const thumbnail_large = extractedThumbnails.thumbnail_large || item.image.thumbnail_large;
      const thumbnail_medium = extractedThumbnails.thumbnail_medium || item.image.thumbnail_medium;
      const thumbnail_small = extractedThumbnails.thumbnail_small || item.image.thumbnail_small;

      // Only create image_metadata if we have at least one thumbnail (never use original image)
      if (thumbnail_large || thumbnail_medium || thumbnail_small) {
        // Push accumulated text (including image URL) as a text block
        if (currentTextBlock.trim()) {
          contentBlocks.push({
            type: "text" as const,
            text: currentTextBlock.trim(),
          });
        }

        // Reset current text block after pushing it
        currentTextBlock = "";

        // Create URLs array with largest to smallest preference, filter out undefined
        const urls = [thumbnail_large, thumbnail_medium, thumbnail_small].filter(Boolean) as string[];

        // Add image_metadata block for lazy loading
        contentBlocks.push({
          type: "image_metadata",
          urls: urls,
          alt: altText,
        });
      }
      // If no thumbnails, just treat as a file reference (already added to currentTextBlock)
    }
    // Handle text items
    else if (typeof item.text === "string") {
      // Check if this is a newline with block formatting (header, blockquote, list)
      if (item.text === '\n' && item.attributes) {
        // Code block formatting: append this line to the open fence (or open one).
        // The attribute value carries the language, either directly or nested as
        // {'code-block': lang}; 'plain' means no language.
        if (item.attributes['code-block']) {
          const rawLang = item.attributes['code-block'];
          const lang = typeof rawLang === 'string' ? rawLang : rawLang?.['code-block'] ?? '';
          const fenceLang = lang === 'plain' ? '' : lang;
          if (inCodeBlock && fenceLang !== currentFenceLang) {
            closeCodeFence();
          }
          if (!inCodeBlock) {
            currentTextBlock += '```' + fenceLang + '\n';
            inCodeBlock = true;
            currentFenceLang = fenceLang;
          }
          currentTextBlock += currentLine + '\n';
          currentLine = "";
          continue;
        }

        // Any other line terminator ends a code block
        closeCodeFence();

        // Header formatting
        if (item.attributes.header) {
          const level = item.attributes.header;
          currentLine = '#'.repeat(level) + ' ' + currentLine;
        }
        // Blockquote formatting
        else if (item.attributes.blockquote) {
          currentLine = '> ' + currentLine;
        }
        // List formatting
        else if (item.attributes.list) {
          const listType = item.attributes.list.list;
          const indent = item.attributes.indent || 0;
          // Add indentation (2 spaces per level) for nested lists
          const indentStr = '  '.repeat(indent);

          switch (listType) {
            case 'bullet':
              currentLine = indentStr + '- ' + currentLine;
              break;
            case 'ordered':
              currentLine = indentStr + '1. ' + currentLine;
              break;
            case 'checked':
              currentLine = indentStr + '- [x] ' + currentLine;
              break;
            case 'unchecked':
              currentLine = indentStr + '- [ ] ' + currentLine;
              break;
          }
        }
        // Add formatted line to text block
        currentTextBlock += currentLine + '\n';
        currentLine = ""; // Reset for next line
        continue;
      }

      // Regular text with inline formatting
      let formattedText = item.text;

      // Text that merely looks like a user mention must come back as literal text on a
      // write: escape its '@'. Not needed where the writer never converts (link labels,
      // inline code, code blocks), and never for our own rendered output (typedText).
      if (
        typedText === null &&
        !item.attributes?.link &&
        !item.attributes?.code &&
        !lineEndsInCodeBlock(textItems, i)
      ) {
        formattedText = escapeUserMentionText(formattedText);
      }

      // Determine current and next formatting state
      const hasBold = item.attributes?.bold === true;
      const hasItalic = item.attributes?.italic === true;
      const hasStrike = item.attributes?.strike === true;
      const hasLink = item.attributes?.link;

      // Look ahead to next non-newline block
      let nextHasBold = false;
      let nextHasItalic = false;
      let nextHasStrike = false;
      for (let j = i + 1; j < textItems.length; j++) {
        const nextItem = textItems[j];
        if (nextItem.text !== '\n' || !nextItem.attributes) {
          nextHasBold = nextItem.attributes?.bold === true;
          nextHasItalic = nextItem.attributes?.italic === true;
          nextHasStrike = nextItem.attributes?.strike === true;
          break;
        }
      }

      // Build prefix (open new formatting)
      let prefix = "";
      if (hasBold && !activeBold) prefix += "**";
      if (hasItalic && !activeItalic) prefix += "*";
      if (hasStrike && !activeStrike) prefix += "~~";

      // Build suffix (close formatting that won't continue)
      let suffix = "";
      if (hasStrike && !nextHasStrike) suffix += "~~";
      if (hasItalic && !nextHasItalic) suffix += "*";
      if (hasBold && !nextHasBold) suffix += "**";

      // Close formatting that's active but not in this block
      let closingPrefix = "";
      if (activeStrike && !hasStrike) closingPrefix += "~~";
      if (activeBold && !hasBold) closingPrefix += "**";
      if (activeItalic && !hasItalic) closingPrefix += "*";

      formattedText = closingPrefix + prefix + formattedText + suffix;

      // Update state
      activeBold = hasBold && nextHasBold;
      activeItalic = hasItalic && nextHasItalic;
      activeStrike = hasStrike && nextHasStrike;

      // Link formatting (wraps everything)
      if (hasLink) {
        formattedText = `[${formattedText}](${hasLink})`;
      }

      // Code formatting
      if (item.attributes?.code) {
        formattedText = `\`${formattedText}\``;
      }

      // Add to current line (not text block yet)
      if (item.text === '\n') {
        // Plain newline without formatting
        closeCodeFence();
        currentTextBlock += currentLine + '\n';
        currentLine = "";
      } else {
        currentLine += formattedText;
      }
    }
    // Task mentions render as the task URL so the reference survives the round trip:
    // writing that URL back through addComment/editComment regenerates the mention.
    else if (item.type === "task_mention" && item.task_mention?.task_id) {
      currentLine += `https://app.clickup.com/t/${item.task_mention.task_id}`;
    }
    // Segments with neither usable content nor a link target (an image without a url,
    // an unknown typed segment without text): a bounded summary, in place on the line
    else {
      currentLine += summarizeSegment(item);
    }
  }

  // Add any remaining text
  closeCodeFence();
  if (currentLine) {
    currentTextBlock += currentLine;
  }
  if (currentTextBlock.trim()) {
    contentBlocks.push({
      type: "text" as const,
      text: currentTextBlock.trim(),
    });
  }

  return contentBlocks;
}

/**
 * Splits markdown text at image references and converts them to image blocks
 * @param markdownText The markdown text to process
 * @param attachments Array of attachments from the Clickup API
 * @returns Array of content blocks (text and images)
 */
export function convertMarkdownToToolCallResult(
  markdownText: string,
  attachments: ClickUpAttachment[] | null | undefined
): (CallToolResult["content"][number] | ImageMetadataBlock)[] {
  const contentBlocks: (CallToolResult["content"][number] | ImageMetadataBlock)[] = [];
  let currentTextBlock = "";

  // Create a map of attachment URLs to their full info for easy lookup
  const attachmentMap = new Map<string, ClickUpAttachment>();
  if (attachments && Array.isArray(attachments)) {
    for (const attachment of attachments) {
      attachmentMap.set(attachment.url, attachment);
    }
  }

  // Regular expression to match markdown image syntax: ![alt text](url)
  const imageRegex = /!\[([^\]]*)\]\(([^\)]+)\)/g;
  let lastIndex = 0;
  let match;

  while ((match = imageRegex.exec(markdownText)) !== null) {
    const [fullMatch, altText, imageUrl] = match;

    // Add text before the image reference to the current text block
    currentTextBlock += markdownText.substring(lastIndex, match.index);

    if (imageUrl.startsWith("data:")) {
      const imageFileName = altText || "image";
      const parsedData = parseDataUri(imageUrl);
      currentTextBlock += `\nImage: ${imageFileName} - [inline image data]`;

      if (currentTextBlock.trim()) {
        contentBlocks.push({
          type: "text" as const,
          text: currentTextBlock.trim(),
        });
      }

      currentTextBlock = "";

      if (parsedData) {
        contentBlocks.push({
          type: "image_metadata",
          urls: [],
          alt: altText || imageFileName,
          inlineData: parsedData,
        });
      } else {
        console.error(`Unable to parse inline image data for ${imageFileName}`);
        contentBlocks.push({
          type: "text" as const,
          text: `[Image "${altText || imageFileName}" omitted: unsupported inline data URI]`,
        });
      }

      lastIndex = match.index + fullMatch.length;
      continue;
    }

    // Check if this image URL exists in our attachments
    const attachment = attachmentMap.get(imageUrl);
    if (attachment) {
      // Keep the markdown syntax, so the reference stays usable in a write call
      const imageFileName = altText || "image";
      currentTextBlock += `\n${toMarkdownImage(imageFileName, imageUrl)}`;

      // Only create image_metadata if we have at least one thumbnail (never use original image)
      if (attachment.thumbnail_large || attachment.thumbnail_medium || attachment.thumbnail_small) {
        // Push accumulated text (including image URL) as a text block
        if (currentTextBlock.trim()) {
          contentBlocks.push({
            type: "text" as const,
            text: currentTextBlock.trim(),
          });
        }

        // Reset current text block after pushing it
        currentTextBlock = "";

        // Create URLs array with largest to smallest preference, filter out undefined
        const urls = [attachment.thumbnail_large, attachment.thumbnail_medium, attachment.thumbnail_small].filter(Boolean) as string[];

        // Add image_metadata block for lazy loading
        contentBlocks.push({
          type: "image_metadata",
          urls: urls,
          alt: altText || imageFileName,
        });
      }
      // If no thumbnails, just treat as a file reference (already added to currentTextBlock)
    } else {
      // If the image URL doesn't match any attachment, keep the original markdown in the current text block
      currentTextBlock += fullMatch;
      console.error(
        `Image URL ${imageUrl} not found in attachments`,
        attachmentMap
      );
    }

    lastIndex = match.index + fullMatch.length;
  }

  // Add any remaining text after the last image
  currentTextBlock += markdownText.substring(lastIndex);

  // Process non-image attachments that weren't referenced in markdown
  const referencedUrls = new Set<string>();
  const imageMatches = markdownText.matchAll(/!\[([^\]]*)\]\(([^\)]+)\)/g);
  for (const match of imageMatches) {
    referencedUrls.add(match[2]);
  }

  // Add non-image files inline to the current text block
  if (attachments && Array.isArray(attachments)) {
    for (const attachment of attachments) {
      if (!referencedUrls.has(attachment.url)) {
        // Determine if this is an image based on URL or type
        const isImage = attachment.thumbnail_large || 
          /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(attachment.url);
        
        if (!isImage) {
          // This is a non-image file - add inline to current text block
          const fileName = extractFileNameFromUrl(attachment.url) || "file";
          const fileType = extractFileTypeFromUrl(attachment.url);
          const fileTypeText = fileType ? ` (${fileType.toUpperCase()})` : "";
          
          currentTextBlock += `\nFile: ${fileName}${fileTypeText} - ${attachment.url}`;
        }
      }
    }
  }

  // Add any remaining text (including file references) as final text block
  if (currentTextBlock.trim()) {
    contentBlocks.push({
      type: "text" as const,
      text: currentTextBlock.trim(),
    });
  }

  return contentBlocks;
}


/**
 * Extract filename from URL
 */
function extractFileNameFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const filename = pathname.split('/').pop();
    return filename && filename !== '' ? filename : null;
  } catch {
    return null;
  }
}

/**
 * Extract file extension from URL
 */
function extractFileTypeFromUrl(url: string): string | null {
  const filename = extractFileNameFromUrl(url);
  if (!filename) return null;

  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return null;

  return filename.substring(lastDot + 1);
}

/**
 * Represents a ClickUp comment block with formatting
 */
export interface ClickUpCommentBlock {
  text?: string;
  type?: string;
  attributes?: {
    bold?: boolean;
    italic?: boolean;
    strike?: boolean;
    code?: boolean;
    link?: string;
    'code-block'?: {
      'code-block': string;
    };
    header?: number; // 1-6 for h1-h6
    blockquote?: {};
    'blockquote-size'?: 'large';
    list?: {
      list: 'bullet' | 'ordered' | 'unchecked' | 'checked';
    };
    indent?: number; // Nesting level for lists (1 = first level nest, 2 = second, etc.)
    'block-id'?: string;
    alt?: string; // Alt text on image fragments
  };
  list?: {
    list: 'bullet' | 'ordered' | 'unchecked' | 'checked';
  };
  /**
   * Present on task mention fragments. ClickUp renders these as live task references
   * showing the current task name, status and assignee.
   */
  task_mention?: {
    task_id: string;
  };
  /** Present on `type: "tag"` fragments: a user mention, rendered by ClickUp with the live name */
  user?: {
    id: number;
  };
  /**
   * Present on image fragments. ClickUp only renders a preview when this holds the
   * complete attachment object from the upload response - a bare URL string produces
   * an empty placeholder tile.
   */
  image?: {
    id?: string;
    name?: string;
    title?: string;
    extension?: string;
    url: string;
    thumbnail_small?: string;
    thumbnail_medium?: string;
    thumbnail_large?: string;
    width?: number;
    height?: number;
  };
}

/**
 * Minimal shape needed to embed an already-uploaded attachment as an image fragment
 */
export interface EmbeddableAttachment {
  id?: string;
  name?: string;
  title?: string;
  extension?: string;
  url: string;
  thumbnail_small?: string;
  thumbnail_medium?: string;
  thumbnail_large?: string;
  width?: number;
  height?: number;
  [key: string]: any;
}

/**
 * Build the image fragment ClickUp needs to render an inline image in a comment.
 * `title`/`text` carry the caption; the rest is copied straight from the upload response.
 */
export function buildImageFragment(
  attachment: EmbeddableAttachment,
  caption: string
): ClickUpCommentBlock {
  const label = caption || attachment.name || 'image';
  const fragment: ClickUpCommentBlock = {
    type: 'image',
    text: label,
    image: {
      id: attachment.id,
      name: attachment.name,
      title: label,
      extension: attachment.extension,
      url: attachment.url,
      thumbnail_small: attachment.thumbnail_small,
      thumbnail_medium: attachment.thumbnail_medium,
      thumbnail_large: attachment.thumbnail_large,
      width: attachment.width,
      height: attachment.height,
    },
  };
  if (caption) {
    fragment.attributes = { alt: caption };
  }
  return fragment;
}

/**
 * Matches a plain ClickUp task URL, with or without the team segment:
 * https://app.clickup.com/t/86cb3t6t2 or https://app.clickup.com/t/4500611/86cb3t6t2
 *
 * Deliberately narrow: custom task IDs (PREFIX-123) and URLs carrying a query or
 * fragment (e.g. ?comment=... deep links) do NOT match, because a mention would
 * either not resolve or lose the anchor - those stay ordinary links.
 */
const CLICKUP_TASK_URL_PATTERN = /^https?:\/\/app\.clickup\.com\/t\/(?:\d+\/)?([a-z0-9]{6,16})\/?$/;

/**
 * Extract the task ID from a ClickUp task URL, or null if it is not one.
 */
export function parseClickUpTaskUrl(url: string): string | null {
  const match = url.match(CLICKUP_TASK_URL_PATTERN);
  return match ? match[1] : null;
}

/**
 * Wrap image destinations that contain spaces in angle brackets.
 *
 * CommonMark rejects a bare destination with spaces, so `![x](/tmp/Screen Shot.png)`
 * is not an image at all - it would silently stay literal text and never be uploaded.
 * Screenshot filenames have spaces constantly ("Screenshot 2026-07-27 at 14.30.png"),
 * so normalising to the `<...>` form is what makes the obvious thing work.
 */
export function normalizeImageDestinations(markdown: string): string {
  return markdown.replace(
    /!\[([^\]]*)\]\(([^)\n]*)\)/g,
    (match, alt: string, inner: string) => {
      const trimmed = inner.trim();
      // Already bracketed, or nothing to fix
      if (trimmed.startsWith('<') || trimmed.includes('>')) {
        return match;
      }

      // Split off an optional markdown title: dest "title" / 'title'
      const titleMatch = trimmed.match(/^(.*?)(\s+(?:"[^"]*"|'[^']*'))$/s);
      const dest = titleMatch ? titleMatch[1] : trimmed;
      const title = titleMatch ? titleMatch[2] : '';

      if (!dest || !/\s/.test(dest)) {
        return match;
      }
      return `![${alt}](<${dest}>${title})`;
    }
  );
}

/**
 * Collect every image reference in a markdown document, in document order.
 * Callers use this to know what needs uploading before converting.
 */
export function collectMarkdownImageSources(markdown: string): { src: string; alt: string }[] {
  const images: { src: string; alt: string }[] = [];

  try {
    const tree = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .parse(markdown) as Root;

    const visit = (nodes: any[]): void => {
      for (const node of nodes) {
        if (node.type === 'image' && typeof node.url === 'string') {
          images.push({ src: node.url, alt: typeof node.alt === 'string' ? node.alt : '' });
        } else if (Array.isArray(node.children)) {
          visit(node.children);
        }
      }
    };
    visit(tree.children as any[]);
  } catch (error) {
    console.error('Failed to collect markdown images:', error);
  }

  return images;
}

/**
 * Replace image sources in markdown with their uploaded ClickUp URLs.
 *
 * Used for task descriptions: `markdown_description` renders `![alt](url)` directly,
 * so descriptions need no fragment handling - only the URL has to be swapped.
 * Images without an upload keep their original source untouched.
 */
export function rewriteMarkdownImageUrls(
  markdown: string,
  attachmentsBySrc: Map<string, EmbeddableAttachment>
): string {
  if (attachmentsBySrc.size === 0) {
    return markdown;
  }

  return markdown.replace(
    /!\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)([^)]*)\)/g,
    (match, alt: string, rawSrc: string, trailing: string) => {
      const src = rawSrc.startsWith('<') && rawSrc.endsWith('>') ? rawSrc.slice(1, -1) : rawSrc;
      const attachment = attachmentsBySrc.get(src);
      if (!attachment) {
        return match;
      }
      return `![${alt}](${attachment.url}${trailing})`;
    }
  );
}

/**
 * Convert markdown text to ClickUp comment blocks format using remark
 * Supports: headers, bold, italic, code, links, lists, blockquotes, code blocks, images
 *
 * @param markdown The markdown text to convert
 * @param attachmentsBySrc Uploaded attachments keyed by the markdown `src` they came from.
 *   Images without an entry degrade to a link so their information is not lost.
 * @returns Array of ClickUp comment blocks
 */
export function convertMarkdownToClickUpBlocks(
  markdown: string,
  attachmentsBySrc?: Map<string, EmbeddableAttachment>
): ClickUpCommentBlock[] {
  const blocks: ClickUpCommentBlock[] = [];

  try {
    // Parse the entire markdown document using remark with GFM support (for task lists)
    const tree = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .parse(markdown) as Root;

    // Walk the tree recursively
    walkMdastNodes(tree.children, {}, blocks, 0, attachmentsBySrc, markdown);

  } catch (error) {
    console.error('Failed to parse markdown:', error);
    // Fallback to plain text
    return [{ text: markdown, attributes: {} }];
  }

  return blocks;
}

/**
 * Recursively walk mdast nodes and convert to ClickUp blocks
 * @param nodes Array of mdast nodes to process
 * @param inheritedAttrs Formatting attributes inherited from parent nodes
 * @param blocks Output array to append ClickUp blocks to
 * @param depth Nesting depth for lists (0 = top level, 1 = first nest, etc.)
 */
function walkMdastNodes(
  nodes: Content[],
  inheritedAttrs: ClickUpCommentBlock['attributes'],
  blocks: ClickUpCommentBlock[],
  depth: number = 0,
  attachmentsBySrc?: Map<string, EmbeddableAttachment>,
  source?: string
): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const currentAttrs = { ...inheritedAttrs };

    // ClickUp has no paragraph margins: two paragraphs separated by a single '\n'
    // render as consecutive lines. The UI stores a paragraph break as an extra
    // empty '\n' fragment (what a user gets by pressing Enter twice), so emit one
    // between adjacent flow blocks. Headings, code blocks and blockquotes bring
    // their own spacing - a blank line next to them would double the gap.
    if (i > 0 && needsBlankLineBetween(nodes[i - 1], node)) {
      blocks.push({ text: '\n', attributes: {} });
    }

    switch (node.type) {
      case 'heading':
        // Process heading content with inline formatting
        walkPhrasingContent((node as Heading).children, currentAttrs, blocks, attachmentsBySrc, source);
        // Add newline with header attribute
        blocks.push({ text: '\n', attributes: { header: (node as Heading).depth } });
        break;

      case 'paragraph':
        // Process paragraph content with inline formatting
        walkPhrasingContent((node as Paragraph).children, currentAttrs, blocks, attachmentsBySrc, source);
        // Add newline unless it's the last node
        if (i < nodes.length - 1) {
          blocks.push({ text: '\n', attributes: {} });
        }
        break;

      case 'blockquote':
        // ClickUp limitation: Blockquotes only support paragraph content, not headers or lists
        // For complex blockquote content (headers, lists), only paragraph text is preserved
        const blockquoteChildren = (node as Blockquote).children;
        for (const child of blockquoteChildren) {
          if (child.type === 'paragraph') {
            walkPhrasingContent((child as Paragraph).children, currentAttrs, blocks, attachmentsBySrc, source);
            blocks.push({ text: '\n', attributes: { blockquote: {} } });
          }
          // Note: Other child types (heading, list) are not supported by ClickUp blockquotes
          // and will be silently skipped, preserving only inline paragraph content
        }
        break;

      case 'list':
        const listNode = node as List;
        const listType = listNode.ordered ? 'ordered' : 'bullet';

        for (const item of listNode.children) {
          const listItem = item as ListItem;

          // Check if it's a checkbox item
          const isChecked = listItem.checked === true;
          const isUnchecked = listItem.checked === false;
          const finalListType = isChecked ? 'checked' : isUnchecked ? 'unchecked' : listType;

          // Process list item content
          for (const itemChild of listItem.children) {
            if (itemChild.type === 'paragraph') {
              // Process paragraph content with inline formatting
              walkPhrasingContent((itemChild as Paragraph).children, currentAttrs, blocks, attachmentsBySrc, source);

              // Add newline with list formatting and optional indent
              const listAttrs: ClickUpCommentBlock['attributes'] = {
                list: { list: finalListType }
              };

              // Add indent for nested lists (depth 0 = no indent, depth 1+ = indented)
              if (depth > 0) {
                listAttrs.indent = depth;
              }

              blocks.push({ text: '\n', attributes: listAttrs });
            } else if (itemChild.type === 'list') {
              // Nested list - recursively process with increased depth
              walkMdastNodes([itemChild], currentAttrs, blocks, depth + 1, attachmentsBySrc, source);
            }
          }
        }
        break;

      case 'code':
        // Code block
        const codeNode = node as Code;
        if (codeNode.value) {
          pushCodeBlockLines(blocks, codeNode.value, codeNode.lang || 'plain');
        }
        break;

      case 'thematicBreak':
        // Horizontal rule - just add a line break
        blocks.push({ text: '\n', attributes: {} });
        break;

      case 'table': {
        // ClickUp comments cannot render tables (there is no table fragment in the
        // comment format - unknown attributes are stored but render as plain text).
        // Re-render the table as an aligned pipe table inside a code block so the
        // information survives and stays readable in monospace.
        const tableText = serializeTableAsAlignedPipes(node as Table);
        if (tableText) {
          pushCodeBlockLines(blocks, tableText, 'plain');
        }
        break;
      }

      default:
        // For any other block-level nodes, try to process children
        if ('children' in node && Array.isArray(node.children)) {
          walkMdastNodes(node.children as Content[], currentAttrs, blocks, depth, attachmentsBySrc, source);
        } else if ('value' in node && typeof (node as any).value === 'string') {
          // Last-resort safety net: never drop text content silently
          blocks.push({ text: (node as any).value, attributes: {} });
        }
        break;
    }
  }
}

/**
 * Block types that render without their own vertical margin in ClickUp comments.
 * Two of them in a row need an explicit empty line to read as separate blocks.
 */
const FLOW_BLOCK_TYPES = new Set<string>(['paragraph', 'list']);

function needsBlankLineBetween(prev: Content, next: Content): boolean {
  return FLOW_BLOCK_TYPES.has(prev.type) && FLOW_BLOCK_TYPES.has(next.type);
}

/**
 * Emit a (possibly multi-line) code block the way ClickUp's Quill-based format
 * expects it: block attributes apply per line, so EVERY line needs its own '\n'
 * fragment carrying the code-block attribute. A single text fragment with embedded
 * newlines renders only its last line as code - the rest degrades to plain text.
 */
function pushCodeBlockLines(blocks: ClickUpCommentBlock[], code: string, lang: string): void {
  for (const line of code.split('\n')) {
    if (line) {
      blocks.push({ text: line, attributes: {} });
    }
    blocks.push({
      text: '\n',
      attributes: { 'code-block': { 'code-block': lang } }
    });
  }
}

/**
 * Serialize phrasing content back to compact markdown for use inside a code block.
 * Inline formatting markers are kept so nothing is lost, even though a code block
 * renders them literally.
 */
function serializePhrasingToMarkdown(nodes: PhrasingContent[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += node.value;
        break;
      case 'strong':
        out += `**${serializePhrasingToMarkdown(node.children)}**`;
        break;
      case 'emphasis':
        out += `*${serializePhrasingToMarkdown(node.children)}*`;
        break;
      case 'delete':
        out += `~~${serializePhrasingToMarkdown(node.children)}~~`;
        break;
      case 'inlineCode':
        out += `\`${node.value}\``;
        break;
      case 'link':
        out += `[${serializePhrasingToMarkdown(node.children)}](${node.url})`;
        break;
      case 'image':
        out += node.alt || node.url;
        break;
      case 'break':
        out += ' ';
        break;
      default:
        if ('value' in node && typeof (node as any).value === 'string') {
          out += (node as any).value;
        } else if ('children' in node && Array.isArray((node as any).children)) {
          out += serializePhrasingToMarkdown((node as any).children);
        }
        break;
    }
  }
  return out;
}

/**
 * Render an mdast table as a column-aligned pipe table string.
 */
function serializeTableAsAlignedPipes(table: Table): string {
  const rows: string[][] = table.children.map((row) =>
    (row as TableRow).children.map((cell) =>
      serializePhrasingToMarkdown((cell as TableCell).children).replace(/\|/g, '\\|').trim()
    )
  );
  if (rows.length === 0) {
    return '';
  }

  const colCount = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let col = 0; col < colCount; col++) {
    widths[col] = Math.max(3, ...rows.map((r) => (r[col] ?? '').length));
  }

  const renderRow = (cells: string[]): string =>
    '| ' + widths.map((w, col) => (cells[col] ?? '').padEnd(w)).join(' | ') + ' |';

  const lines = [renderRow(rows[0])];
  lines.push('| ' + widths.map((w) => '-'.repeat(w)).join(' | ') + ' |');
  for (const row of rows.slice(1)) {
    lines.push(renderRow(row));
  }
  return lines.join('\n');
}

/**
 * Matches the read rendering of a user mention: "@Brian Dao (user_id: 4219961)".
 * The name may not contain '@', and the '@' may not follow a word character, so
 * an e-mail address in front of a mention is not swallowed into its name.
 * The name is at most MAX_MENTION_NAME_LENGTH characters.
 */
const MAX_MENTION_NAME_LENGTH = 100;
const USER_MENTION_SOURCE = String.raw`(?<![\w.])@([^@\r\n]{1,${MAX_MENTION_NAME_LENGTH}}?) \(user_id: (\d+)\)`;
const USER_MENTION_PATTERN = new RegExp(USER_MENTION_SOURCE, 'g');
/** Same, with any run of backslashes in front of the '@' captured (group 1) */
const ESCAPABLE_USER_MENTION_PATTERN = new RegExp(String.raw`(\\*)(${USER_MENTION_SOURCE})`, 'g');
/** A mention whose '@' was escaped in the markdown source: `\@Name (user_id: N)` */
const ESCAPED_USER_MENTION_IN_SOURCE = /\\@[^@\r\n]{1,100}? \(user_id: (\d+)\)/g;
const MARKDOWN_ESCAPABLE = /[!-\/:-@\[-`{-~]/;

/**
 * Make text that merely looks like a mention literal: put `\@` in front of the '@' so
 * the writer (which honours the escape) never turns it into a live tag. Backslashes
 * already in front of the '@' are doubled so they cannot swallow the new escape.
 */
function escapeUserMentionText(text: string): string {
  return text.replace(
    ESCAPABLE_USER_MENTION_PATTERN,
    (_all, backslashes: string, mention: string) => `${backslashes}${backslashes}\\${mention}`
  );
}

/**
 * Indexes (into `value`) of the '@' signs that the markdown source escaped (`\@`).
 * remark strips the backslash from a text node's value, so the value alone cannot
 * tell `\@Alice (user_id: 7)` (literal text) from `@Alice (user_id: 7)` (a mention).
 *
 * Simple case (the node's source slice differs from its value only by backslash
 * escapes): walk both strings in lockstep, which maps every value index to its source
 * character exactly. Complex case (entities, line prefixes such as `> ` or list
 * indentation, anything the lockstep walk cannot explain): search the node's source
 * slice for `\@<name> (user_id: N)` occurrences and treat the pattern matches with the
 * same ids, in order, as escaped. This errs towards literal text, never a stray tag.
 * Without position information nothing is treated as escaped (the previous behaviour).
 */
function findEscapedMentionSigns(node: Text, source: string | undefined): Set<number> {
  const escaped = new Set<number>();
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (source === undefined || typeof start !== 'number' || typeof end !== 'number') {
    return escaped;
  }
  const raw = source.slice(start, end);
  const value = node.value;
  if (raw === value || !raw.includes('\\')) {
    return escaped;
  }

  // Simple case: lockstep walk
  let j = 0;
  let aligned = true;
  for (let i = 0; i < value.length; i++) {
    if (raw[j] === '\\' && j + 1 < raw.length && raw[j + 1] === value[i] && MARKDOWN_ESCAPABLE.test(value[i])) {
      if (value[i] === '@') escaped.add(i);
      j += 2;
    } else if (raw[j] === value[i]) {
      j += 1;
    } else {
      aligned = false;
      break;
    }
  }
  if (aligned && j === raw.length) {
    return escaped;
  }

  // Complex case: match by id, in order
  escaped.clear();
  const escapedIds = Array.from(raw.matchAll(ESCAPED_USER_MENTION_IN_SOURCE), (m) => m[1]);
  for (const match of value.matchAll(USER_MENTION_PATTERN)) {
    const at = escapedIds.indexOf(match[2]);
    if (at !== -1) {
      escapedIds.splice(at, 1);
      escaped.add(match.index!);
    }
  }
  return escaped;
}

/**
 * Push a text run, replacing every "@Name (user_id: N)" with a `tag` fragment.
 * ClickUp renders the live user name, so the written name is dropped.
 * Matches whose '@' is in `escapedSigns` stay literal text.
 */
function pushTextWithUserMentions(
  blocks: ClickUpCommentBlock[],
  value: string,
  attributes: ClickUpCommentBlock['attributes'],
  escapedSigns: ReadonlySet<number> = new Set()
): void {
  let lastIndex = 0;
  for (const match of value.matchAll(USER_MENTION_PATTERN)) {
    const userId = Number(match[2]);
    if (!Number.isSafeInteger(userId) || escapedSigns.has(match.index!)) {
      continue;
    }
    if (match.index! > lastIndex) {
      blocks.push({ text: value.slice(lastIndex, match.index), attributes });
    }
    blocks.push({ type: 'tag', user: { id: userId } });
    lastIndex = match.index! + match[0].length;
  }
  if (lastIndex < value.length) {
    blocks.push({ text: value.slice(lastIndex), attributes });
  }
}

/**
 * Recursively walk phrasing content (inline nodes) and build ClickUp blocks
 * Accumulates formatting attributes from parent nodes
 */
function walkPhrasingContent(
  nodes: PhrasingContent[],
  inheritedAttrs: ClickUpCommentBlock['attributes'],
  blocks: ClickUpCommentBlock[],
  attachmentsBySrc?: Map<string, EmbeddableAttachment>,
  source?: string
): void {
  for (const node of nodes) {
    const currentAttrs = { ...inheritedAttrs };

    switch (node.type) {
      case 'image': {
        // An image node has neither `value` nor `children`, so without this case it
        // would fall through to `default` and vanish silently.
        const attachment = attachmentsBySrc?.get(node.url);
        const caption = node.alt || '';
        if (attachment) {
          blocks.push(buildImageFragment(attachment, caption));
        } else {
          // Nothing was uploaded for this source - degrade to a link rather than
          // dropping the reference, so the information survives.
          const label = caption || node.url;
          const isEmbeddable = /^https?:\/\//i.test(node.url);
          blocks.push({
            text: label,
            attributes: isEmbeddable ? { ...currentAttrs, link: node.url } : currentAttrs,
          });
        }
        break;
      }

      case 'text':
        // Plain text node
        if (node.value) {
          const attrs = Object.keys(currentAttrs).length > 0 ? currentAttrs : {};
          // "@Name (user_id: N)" is how reads render a user mention: turn it back
          // into one, unless its '@' was escaped (`\@`). Not inside a link, where the
          // text is a label.
          if (currentAttrs.link) {
            blocks.push({ text: node.value, attributes: attrs });
          } else {
            pushTextWithUserMentions(blocks, node.value, attrs, findEscapedMentionSigns(node, source));
          }
        }
        break;

      case 'strong':
        // Bold text - recurse with bold attribute
        currentAttrs.bold = true;
        walkPhrasingContent(node.children, currentAttrs, blocks, attachmentsBySrc, source);
        break;

      case 'emphasis':
        // Italic text - recurse with italic attribute
        currentAttrs.italic = true;
        walkPhrasingContent(node.children, currentAttrs, blocks, attachmentsBySrc, source);
        break;

      case 'delete':
        // GFM strikethrough (~~text~~) - ClickUp renders this via the strike attribute
        currentAttrs.strike = true;
        walkPhrasingContent(node.children, currentAttrs, blocks, attachmentsBySrc, source);
        break;

      case 'inlineCode':
        // Inline code
        if (node.value) {
          currentAttrs.code = true;
          blocks.push({
            text: node.value,
            attributes: currentAttrs
          });
        }
        break;

      case 'link': {
        // A link to a ClickUp task becomes a real task mention, matching what the
        // ClickUp UI does when a task URL is pasted. The mention renders the live
        // task name, so any custom link text is intentionally replaced by it.
        const mentionedTaskId = parseClickUpTaskUrl(node.url);
        if (mentionedTaskId) {
          blocks.push({ type: 'task_mention', task_mention: { task_id: mentionedTaskId } });
          break;
        }
        // Ordinary link - recurse with link attribute
        currentAttrs.link = node.url;
        walkPhrasingContent(node.children, currentAttrs, blocks, attachmentsBySrc, source);
        break;
      }

      case 'break':
        // Line break - add as plain text
        blocks.push({ text: '\n', attributes: {} });
        break;

      default:
        // For any other node types, try to extract text if available
        if ('value' in node && typeof node.value === 'string') {
          blocks.push({
            text: node.value,
            attributes: Object.keys(currentAttrs).length > 0 ? currentAttrs : {}
          });
        } else if ('children' in node && Array.isArray(node.children)) {
          // Recurse into children for other container nodes
          walkPhrasingContent(node.children as PhrasingContent[], currentAttrs, blocks, attachmentsBySrc, source);
        }
        break;
    }
  }
}
