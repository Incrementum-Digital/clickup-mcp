import { clickupFetch } from "../shared/clickup-fetch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONFIG } from "../shared/config";
import { getCurrentUser } from "../shared/utils";
import {
  collectMarkdownImageSources,
  convertMarkdownToClickUpBlocks,
  normalizeImageDestinations,
  rewriteMarkdownImageUrls,
} from "../clickup-text";
import {
  ResolvedMarkdownImage,
  UploadedMarkdownImage,
  resolveMarkdownImages,
  toAttachmentMap,
  uploadResolvedImages,
} from "../shared/attachments";
import {
  CommentPageCursor,
  ExistingComment,
  MAX_COMMENT_PAGES,
  fetchCommentPage,
  findTopLevelComment,
} from "../shared/comments";
import { resolveAssigneesDetailed, formatMember } from "../shared/members";
import {
  buildCreateCustomFields,
  checkCreatedCustomFields,
  executeCustomFieldWrites,
  formatCreatedCustomFields,
  formatCustomFieldResult,
  prepareCustomFieldWrites,
  PreparedCustomFieldWrite,
} from "../shared/custom-fields";

/**
 * Shared wording for the image support of every markdown field in this file.
 * Kept in one place so the tools stay consistent about what a client may pass.
 */
/**
 * Shared wording for what markdown ClickUp comments can actually render.
 * Kept in one place so addComment and editComment stay consistent.
 */
const COMMENT_FORMATTING_HINT = [
  "FORMATTING: Headings, **bold**, *italic*, ~~strikethrough~~, `inline code`, code blocks, links, blockquotes, bullet/numbered/nested lists and checkboxes (- [ ] / - [x]) all render natively.",
  "TABLES ARE NOT SUPPORTED by ClickUp comments - a markdown table is automatically converted to a monospace code block, which is readable but plain. Prefer bold labels or lists over tables when writing comments.",
].join("\n");

const IMAGE_SUPPORT_HINT = [
  "IMAGES: Reference images with normal markdown - `![caption](/absolute/path/to/screenshot.png)`.",
  "This server runs locally, so a local file path is read and uploaded automatically - never inline a screenshot as base64 when a path exists, it costs orders of magnitude more tokens.",
  "Also accepted: `data:` URIs, http(s) URLs (downloaded and re-uploaded), and existing ClickUp attachment URLs (embedded as-is).",
  "The caption becomes the attachment filename, which is what ClickUp displays beneath the image - so write a caption that reads well.",
].join("\n");

/**
 * Phase 1 of image handling: parse the markdown and resolve every image source
 * (read files, download URLs, decode data URIs) WITHOUT writing anything.
 *
 * Throws when any reference is unusable, listing every broken source at once.
 * Nothing has been posted to ClickUp when this throws, so the caller's generic
 * error path returns the report and the client can fix the markdown and retry.
 */
async function resolveImagesOrAbort(
  markdown: string | undefined,
  abortNotice: string
): Promise<{ markdown: string; images: ResolvedMarkdownImage[] }> {
  if (!markdown) {
    return { markdown: markdown ?? "", images: [] };
  }

  // Normalise first, then use the same string for collecting and converting - the
  // sources must line up with what the converter later looks up.
  const normalized = normalizeImageDestinations(markdown);

  const sources = collectMarkdownImageSources(normalized);
  if (sources.length === 0) {
    return { markdown: normalized, images: [] };
  }

  const { resolved, failures } = await resolveMarkdownImages(sources);
  if (failures.length > 0) {
    throw new Error(
      [
        `${failures.length} image reference(s) could not be used, so ${abortNotice}:`,
        ...failures.map((failure) => `  - ${failure.src}: ${failure.error}`),
        `Fix or remove these image references and retry.`,
      ].join("\n")
    );
  }

  return { markdown: normalized, images: resolved };
}

/**
 * Phase 2: upload the resolved images to the task.
 *
 * Throws on the first upload failure. Everything uploaded before the failure is
 * listed with its CDN URL so a retry can reference those URLs directly (existing
 * ClickUp URLs are embedded without re-uploading).
 */
async function uploadImagesOrAbort(
  taskId: string,
  images: ResolvedMarkdownImage[],
  abortNotice: string
): Promise<UploadedMarkdownImage[]> {
  if (images.length === 0) {
    return [];
  }

  const { uploaded, failure } = await uploadResolvedImages(taskId, images);
  if (failure) {
    const lines = [
      `Uploading image "${failure.src}" failed, so ${abortNotice}:`,
      `  ${failure.error}`,
    ];
    if (uploaded.length > 0) {
      lines.push(
        `${uploaded.length} image(s) were already uploaded to task ${taskId} before the failure - on retry, reference these URLs directly to avoid duplicate uploads:`,
        ...uploaded.map((u) => `  - ${u.attachment.name}: ${u.attachment.url}`)
      );
    }
    throw new Error(lines.join("\n"));
  }

  return uploaded;
}

/**
 * Echo a markdown field back without repeating inline base64 payloads.
 * Without this a single data-URI screenshot would be mirrored back into the
 * response, costing as many tokens again as it did going in.
 */
function summarizeMarkdownForEcho(markdown: string): string {
  return markdown.replace(
    /(!\[[^\]]*\]\()data:([^;,)]+)[^)]*(\))/g,
    (_match, prefix: string, mimeType: string, suffix: string) =>
      `${prefix}[inline ${mimeType} data]${suffix}`
  );
}

/** Report successfully attached images so the caller can verify and link to them */
function formatAttachedImages(uploaded: UploadedMarkdownImage[]): string[] {
  if (uploaded.length === 0) {
    return [];
  }
  return [
    `images_attached: ${uploaded.length}`,
    ...uploaded.map((u) => `  - ${u.attachment.name} (${u.attachment.url})`),
  ];
}

// Shared schemas for task parameters
const taskNameSchema = z.string().min(1).describe("The name/title of the task");
const taskPrioritySchema = z.enum(["urgent", "high", "normal", "low"]).optional().describe("Optional priority level");
const taskDueDateSchema = z.string().optional().describe("Optional due date as ISO date string (e.g., '2024-10-06T23:59:59+02:00')");
const taskStartDateSchema = z.string().optional().describe("Optional start date as ISO date string (e.g., '2024-10-06T09:00:00+02:00')");
const taskTimeEstimateSchema = z.number().optional().describe("Optional time estimate in hours (will be converted to milliseconds)");
const taskTagsSchema = z.array(z.string()).optional().describe("Optional array of tag names");
const taskCustomFieldsSchema = z.record(z.string(), z.unknown()).optional().describe(
  [
    "Optional custom field values keyed by field NAME (case-insensitive) or field_id, e.g. {\"Client\": \"Acme\", \"Budget\": 1500}. Use getCustomFields with the task's list_id to see the fields and their types (max 20 per call).",
    "Values by type: text/url/email/phone = string; number/currency = number; checkbox = true/false; date = ISO string (\"2025-12-31\" or \"2025-12-31T14:30:00+01:00\") or Unix ms;",
    "drop_down = option name or option_id; labels = array of option names or ids; users = array of user ids, usernames or emails; tasks = array of task ids;",
    "location = {location: {lat, lng}, formatted_address}. On updateTask, null clears a field.",
  ].join(" ")
);
const taskAssigneesDescription = "Optional array of assignees: user IDs, usernames or emails (names are matched case-insensitively and must be unambiguous - use getMembers to look them up)";

export function registerTaskToolsWrite(server: McpServer, userData: any) {
  server.tool(
    "addComment",
    (() => {
      const descriptionBase = [
        "Adds a comment to a specific task, or a threaded reply to an existing comment when `parent_comment_id` is set.",
        "LINKING BEST PRACTICES:",
        "- Always reference related tasks using ClickUp URLs (https://app.clickup.com/t/TASK_ID)",
        "- Task URLs become live task references (chip with task name and status), so write them bare - any custom link text on a task URL is replaced by the live task name",
        "- Include task links when mentioning dependencies, related work, or follow-ups",
        "- Link to relevant lists, spaces, or other ClickUp entities when applicable",
        "PROGRESS UPDATES: Include current status, progress information, and next steps.",
        COMMENT_FORMATTING_HINT,
        IMAGE_SUPPORT_HINT,
        "IMAGE LAYOUT: An image inside a numbered list breaks ClickUp's numbering. Write walkthrough steps as bold lines with a blank line before and after the image instead (`**1. Open the login page**`).",
        "If external links are provided, verify they are publicly accessible and incorporate relevant information.",
        "Check the task's current status - if it's in 'backlog' or similar inactive states, suggest moving it to an active status like 'in progress' when work is being done."
      ];

      if (CONFIG.primaryLanguageHint && CONFIG.primaryLanguageHint.toLowerCase() !== 'en') {
        descriptionBase.splice(1, 0,
          `For optimal results, consider writing comments in '${CONFIG.primaryLanguageHint}' unless the task is already in another language.`);
      }

      return descriptionBase.join("\n");
    })(),
    {
      task_id: z.string().min(6).max(16).describe("The 6-16 character task ID to comment on"),
      comment: z.string().min(1).describe("The comment text to add to the task"),
      parent_comment_id: z.string().min(1).optional().describe(
        "Optional: reply inside an existing comment thread instead of posting a new top-level comment. Pass the comment_id of a TOP-LEVEL comment as returned by getTaskById or addComment - ClickUp threads are one level deep, so a reply cannot have replies of its own."
      ),
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    async ({ task_id, comment, parent_comment_id }) => {
      try {
        // The reply endpoint anchors the reply to the parent comment's task and
        // ignores task_id, while images below are uploaded to task_id - so the
        // parent must verifiably be a top-level comment of THIS task before
        // anything is written. This also rejects reply ids (nested replies are
        // not supported by ClickUp's one-level threads).
        if (parent_comment_id) {
          const parent = await findTopLevelComment(task_id, parent_comment_id);
          if (!parent) {
            throw new Error(
              `Comment ${parent_comment_id} is not a top-level comment of task ${task_id}, so no reply was posted. ` +
              `parent_comment_id must be the comment_id of a top-level comment of this task as returned by getTaskById - ` +
              `a reply's id or a comment of another task cannot be used.`
            );
          }
        }

        // Resolve and upload referenced images first - the fragments need the
        // attachment objects from the upload response, a bare URL renders as an
        // empty tile. Any image problem aborts BEFORE the comment is posted, so
        // the caller can fix the markdown and retry without creating duplicates.
        const abortNotice = "the comment was NOT posted";
        const { markdown, images } = await resolveImagesOrAbort(comment, abortNotice);
        const uploaded = await uploadImagesOrAbort(task_id, images, abortNotice);

        // Convert markdown to ClickUp formatted blocks
        const commentBlocks = convertMarkdownToClickUpBlocks(markdown, toAttachmentMap(uploaded));

        const requestBody = {
          comment: commentBlocks,
          notify_all: true
        };

        // A threaded reply goes to the parent comment's reply endpoint; the body
        // is identical to a top-level comment.
        const url = parent_comment_id
          ? `https://api.clickup.com/api/v2/comment/${parent_comment_id}/reply`
          : `https://api.clickup.com/api/v2/task/${task_id}/comment`;

        const response = await clickupFetch(url, {
          method: 'POST',
          headers: {
            Authorization: CONFIG.authHeader,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(`Error adding comment: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`);
        }

        const commentData = await response.json();

        return {
          content: [
            {
              type: "text" as const,
              text: [
                parent_comment_id ? `Reply added successfully!` : `Comment added successfully!`,
                `comment_id: ${commentData.id || 'N/A'}`,
                ...(parent_comment_id ? [
                  `parent_comment_id: ${parent_comment_id}`,
                  `note: ClickUp threads are one level deep - a reply's comment_id cannot be used as parent_comment_id or with editComment.`,
                ] : []),
                `task_id: ${task_id}`,
                `comment: ${summarizeMarkdownForEcho(comment)}`,
                `date: ${timestampToIso(commentData.date || Date.now())}`,
                `user: ${commentData.user?.username || 'Current user'}`,
                ...formatAttachedImages(uploaded),
              ].join('\n')
            }
          ],
        };

      } catch (error) {
        console.error('Error adding comment:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error adding comment: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "editComment",
    (() => {
      const descriptionBase = [
        "Replaces the full text of an existing task comment - use this to correct a comment you just posted instead of adding a follow-up comment.",
        "The new text REPLACES the old one completely, it is not appended. Anything worth keeping must be repeated in `comment`.",
        `GUARDRAILS: only comments written by the API token's own user can be edited, and only within ${CONFIG.commentEditWindowHours} hours of their creation. Older comments and other people's comments must be answered with a new comment via addComment.`,
        "ClickUp shows no 'edited' marker, so people who already read the comment will not notice the change - for anything that changes meaning after a discussion has started, prefer a follow-up comment.",
        "Editing does not reset the creation date, so the edit window does not get extended by editing.",
        COMMENT_FORMATTING_HINT,
        IMAGE_SUPPORT_HINT,
        "IMAGES ON EDIT: reading a comment (getTaskById) returns its images as markdown, so passing that text back keeps them - an existing ClickUp attachment URL is re-embedded without uploading again. Only an image whose markdown you drop disappears.",
        "Task URLs (https://app.clickup.com/t/TASK_ID) become live task references, and existing references are read back as such URLs - passing the text back keeps them.",
      ];

      if (CONFIG.primaryLanguageHint && CONFIG.primaryLanguageHint.toLowerCase() !== 'en') {
        descriptionBase.splice(1, 0,
          `For optimal results, consider writing comments in '${CONFIG.primaryLanguageHint}' unless the task is already in another language.`);
      }

      return descriptionBase.join("\n");
    })(),
    {
      task_id: z.string().min(6).max(16).describe("The 6-16 character ID of the task the comment belongs to - needed to locate the comment and to upload images"),
      comment_id: z.string().min(1).describe("The ID of the comment to edit, as returned by addComment or getTaskById. Only top-level comments can be edited - replies inside a thread cannot."),
      comment: z.string().min(1).describe("The new comment text, replacing the previous text completely"),
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
    async ({ task_id, comment_id, comment }) => {
      try {
        const [existing, userData] = await Promise.all([
          findTaskComment(task_id, comment_id),
          getCurrentUser(),
        ]);

        assertCommentIsEditable(existing, userData.user.id);

        // Same pipeline as addComment - the undocumented rich `comment` array is
        // accepted by PUT too, so formatting and images survive an edit. Images are
        // resolved and uploaded before the PUT, so a broken reference leaves the
        // existing comment untouched.
        const abortNotice = "the comment was NOT changed";
        const { markdown, images } = await resolveImagesOrAbort(comment, abortNotice);
        const uploaded = await uploadImagesOrAbort(task_id, images, abortNotice);

        const commentBlocks = convertMarkdownToClickUpBlocks(markdown, toAttachmentMap(uploaded));

        // Only `comment` is sent: sending `comment_text` alongside it appends that
        // string to the blocks instead of being ignored.
        const response = await clickupFetch(`https://api.clickup.com/api/v2/comment/${comment_id}`, {
          method: 'PUT',
          headers: {
            Authorization: CONFIG.authHeader,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ comment: commentBlocks })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(`Error editing comment: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Comment edited successfully!`,
                `comment_id: ${comment_id}`,
                `task_id: ${task_id}`,
                `task_url: https://app.clickup.com/t/${task_id}`,
                `created: ${timestampToIso(existing.date)} (unchanged by the edit)`,
                `previous_text: ${existing.comment_text || '(no plain text available)'}`,
                `new_comment: ${summarizeMarkdownForEcho(comment)}`,
                ...formatAttachedImages(uploaded),
              ].join('\n')
            }
          ],
        };

      } catch (error) {
        console.error('Error editing comment:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error editing comment: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "updateTask",
    (() => {
      const descriptionBase = [
        "Updates various aspects of an existing task including dependencies and relationships.",
        "ALWAYS include the task URL (https://app.clickup.com/t/TASK_ID) when updating or referencing tasks.",
        "Use getListInfo first to see valid status options.",
        "DESCRIPTIONS: `append_description` adds a dated section below the existing text; `description` REPLACES the whole text (use it to restructure, shorten or correct a description). Pass only one of them.",
        "Before replacing, read the current description via getTaskById and carry over everything that is still needed - ClickUp keeps a description history, so a bad replacement can be restored in the UI (edits within the same minute merge into one version), but the MCP cannot undo it.",
        "STATUS UPDATES: Use the `addComment` tool for progress reports, work logs, and status updates rather than the task description.",
        IMAGE_SUPPORT_HINT,
        "Task descriptions should contain requirements, specifications, and core task information.",
        "LINKING IN DESCRIPTIONS: Include links to related tasks, lists, or external resources (format: https://app.clickup.com/t/TASK_ID).",
        "IMPORTANT: When updating tasks (especially when booking time or adding progress), ensure the status makes sense for the work being done - tasks in 'backlog' or 'closed' states usually shouldn't have active work.",
        "Suggest appropriate status transitions and always provide the clickable task URL in responses."
      ];

      if (CONFIG.primaryLanguageHint && CONFIG.primaryLanguageHint.toLowerCase() !== 'en') {
        descriptionBase.splice(1, 0,
          `For optimal results, consider writing task names and descriptions in '${CONFIG.primaryLanguageHint}' unless the task is already in another language.`);
      }

      return descriptionBase.join("\n");
    })(),
    {
      task_id: z.string().min(6).max(16).describe("The 6-16 character task ID to update"),
      name: taskNameSchema.optional(),
      description: z.string().optional().describe("Optional markdown that REPLACES the entire task description. Read the current description first (getTaskById) and repeat everything worth keeping - nothing is merged. Cannot be combined with append_description."),
      append_description: z.string().optional().describe("Optional markdown content to APPEND below the existing task description as a dated `**Edit (YYYY-MM-DD):**` section (existing content is preserved). Cannot be combined with description."),
      status: z.string().optional().describe("Optional new status name - use getListInfo to see valid options"),
      priority: taskPrioritySchema,
      due_date: taskDueDateSchema,
      start_date: taskStartDateSchema,
      time_estimate: taskTimeEstimateSchema,
      tags: taskTagsSchema.describe("Optional array of tag names (will REPLACE all existing tags). To change single tags use add_tags / remove_tags instead; cannot be combined with them."),
      add_tags: z.array(z.string()).optional().describe("Optional tag names to add, keeping the existing tags. Cannot be combined with `tags`."),
      remove_tags: z.array(z.string()).optional().describe("Optional tag names to remove, keeping all other tags. Cannot be combined with `tags`."),
      parent_task_id: z.string().optional().describe("Optional parent task ID to change parent/child relationships"),
      assignees: z.array(z.string()).optional().describe(createAssigneeDescription(userData, "ADDED to the current assignees (none are removed)")),
      custom_fields: taskCustomFieldsSchema,
      waiting_on: z.array(z.string()).optional().describe("Optional array of task IDs that this task should wait on (will replace existing waiting_on relationships)"),
      blocking: z.array(z.string()).optional().describe("Optional array of task IDs that this task should block. Note: This creates dependencies FROM those tasks TO this task (those tasks will wait on this one)"),
      linked_tasks: z.array(z.string()).optional().describe("Optional array of task IDs to link as related tasks without blocking (will replace existing linked tasks)")
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    },
    async ({ task_id, name, description, append_description, status, priority, due_date, start_date, time_estimate, tags, add_tags, remove_tags, parent_task_id, assignees, custom_fields, blocking, waiting_on, linked_tasks }) => {
      try {
        if (description !== undefined && append_description !== undefined) {
          return {
            content: [{
              type: "text" as const,
              text: "Error: `description` (replace) and `append_description` (append) are mutually exclusive - pass only one of them. The task was NOT updated."
            }],
          };
        }

        if (tags !== undefined && (add_tags !== undefined || remove_tags !== undefined)) {
          return {
            content: [{
              type: "text" as const,
              text: "Error: `tags` (replace all tags) cannot be combined with `add_tags` / `remove_tags` - use `tags` alone to replace the tag set, or `add_tags` / `remove_tags` to change single tags. The task was NOT updated."
            }],
          };
        }

        const userData = await getCurrentUser();

        // Resolve names/emails to user ids before anything is written, so an unknown
        // or ambiguous assignee aborts the call without a partial update.
        const resolvedAssignees = assignees !== undefined ? await resolveAssigneesDetailed(assignees) : undefined;
        const assigneeIds = resolvedAssignees?.map((a) => a.id);

        // Get task details including current markdown description
        const taskResponse = await clickupFetch(`https://api.clickup.com/api/v2/task/${task_id}?include_markdown_description=true`, {
          headers: { Authorization: CONFIG.authHeader },
        });

        if (!taskResponse.ok) {
          throw new Error(`Error fetching task: ${taskResponse.status} ${taskResponse.statusText}`);
        }

        const taskData = await taskResponse.json();

        // Validate the custom fields BEFORE anything is written: the definitions of
        // the task's list are loaded and every key and value converted now, so an
        // unknown field, an invalid value or a failing definitions request aborts the
        // call without a partial update. Only the per-field writes remain after the PUT.
        const customFieldCount = custom_fields ? Object.keys(custom_fields).length : 0;
        let customFieldWrites: PreparedCustomFieldWrite[] = [];
        if (customFieldCount > 0) {
          const listId = taskData.list?.id;
          if (!listId) {
            throw new Error(`Could not determine the list of task ${task_id}, so its custom fields cannot be checked. The task was NOT updated.`);
          }
          try {
            customFieldWrites = await prepareCustomFieldWrites(String(listId), custom_fields!);
          } catch (error) {
            throw new Error(`${error instanceof Error ? error.message : String(error)}. The task was NOT updated.`);
          }
        }

        // Resolve and upload description images FIRST - an image problem must
        // abort before dependencies, tags or the task itself are touched, so the
        // caller can fix the markdown and retry the whole call cleanly.
        // `description` replaces, `append_description` appends; both go through
        // the same image pipeline. An empty `description` is a valid request to
        // clear the description, so check for undefined rather than truthiness.
        const descriptionInput = description !== undefined ? description : append_description;
        let preparedDescription: string | undefined;
        let uploadedImages: UploadedMarkdownImage[] = [];
        if (descriptionInput !== undefined) {
          const abortNotice = "the task was NOT updated";
          const prepared = await resolveImagesOrAbort(descriptionInput, abortNotice);
          uploadedImages = await uploadImagesOrAbort(task_id, prepared.images, abortNotice);
          // Descriptions render plain markdown, so no image fragments are involved
          // here - the local paths are simply swapped for the CDN URLs.
          preparedDescription = rewriteMarkdownImageUrls(
            prepared.markdown,
            toAttachmentMap(uploadedImages)
          );
        }

        // Handle dependencies separately since they need individual API calls
        let dependencyUpdateResults: string[] = [];
        if (blocking !== undefined || waiting_on !== undefined || linked_tasks !== undefined) {
          const dependencyResults = await updateTaskDependencies(
            task_id,
            taskData,
            { blocking, waiting_on, linked_tasks }
          );
          dependencyUpdateResults = dependencyResults;
        }

        // Handle tags separately since they need individual API calls
        let tagUpdateResults: string[] = [];
        if (tags !== undefined) {
          // Get current tags
          const currentTags = taskData.tags?.map((t: any) => t.name) || [];
          const tagsToAdd = tags.filter(tag => !currentTags.includes(tag));
          const tagsToRemove = currentTags.filter((tag: string) => !tags.includes(tag));

          // Add new tags
          for (const tagName of tagsToAdd) {
            try {
              const addTagResponse = await clickupFetch(
                `https://api.clickup.com/api/v2/task/${task_id}/tag/${encodeURIComponent(tagName)}`,
                {
                  method: 'POST',
                  headers: { Authorization: CONFIG.authHeader }
                }
              );
              if (!addTagResponse.ok) {
                console.error(`Failed to add tag "${tagName}": ${addTagResponse.status}`);
                tagUpdateResults.push(`Failed to add tag: ${tagName}`);
              }
            } catch (error) {
              console.error(`Error adding tag "${tagName}":`, error);
              tagUpdateResults.push(`Error adding tag: ${tagName}`);
            }
          }

          // Remove old tags
          for (const tagName of tagsToRemove) {
            try {
              const removeTagResponse = await clickupFetch(
                `https://api.clickup.com/api/v2/task/${task_id}/tag/${encodeURIComponent(tagName)}`,
                {
                  method: 'DELETE',
                  headers: { Authorization: CONFIG.authHeader }
                }
              );
              if (!removeTagResponse.ok) {
                console.error(`Failed to remove tag "${tagName}": ${removeTagResponse.status}`);
                tagUpdateResults.push(`Failed to remove tag: ${tagName}`);
              }
            } catch (error) {
              console.error(`Error removing tag "${tagName}":`, error);
              tagUpdateResults.push(`Error removing tag: ${tagName}`);
            }
          }
        }

        // Single tag changes: skip what is already (not) on the task, so a repeated
        // call neither re-adds nor fails on removing a tag that is gone.
        const currentTagNames = new Set<string>(
          (taskData.tags || []).map((t: any) => String(t.name).toLowerCase())
        );
        const addedTags: string[] = [];
        for (const tagName of add_tags ?? []) {
          if (currentTagNames.has(tagName.toLowerCase())) {
            continue;
          }
          const warning = await changeTag(task_id, 'add', tagName);
          if (warning) {
            tagUpdateResults.push(warning);
          } else {
            addedTags.push(tagName);
          }
        }
        const removedTags: string[] = [];
        for (const tagName of remove_tags ?? []) {
          if (!currentTagNames.has(tagName.toLowerCase())) {
            continue;
          }
          const warning = await changeTag(task_id, 'remove', tagName);
          if (warning) {
            tagUpdateResults.push(warning);
          } else {
            removedTags.push(tagName);
          }
        }

        // Build the description to write: a full replacement, or the existing
        // text plus a dated append section.
        let finalDescription: string | undefined;
        if (description !== undefined) {
          finalDescription = preparedDescription;
        } else if (preparedDescription !== undefined) {
          const currentDescription = taskData.markdown_description || "";
          const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
          const separator = currentDescription.trim() ? "\n\n---\n" : "";
          finalDescription = currentDescription + separator + `**Edit (${timestamp}):** ${preparedDescription}`;
        }

        // Build update body without tags (they're handled separately)
        const updateBody = buildTaskRequestBody({
          name, status, priority, due_date, start_date, time_estimate, parent_task_id, assignees: assigneeIds
        });

        // Add markdown description if we have content to append
        if (finalDescription !== undefined) {
          updateBody.markdown_description = finalDescription;
        }

        // Handle assignees for updates (different from creates)
        if (assignees !== undefined) {
          updateBody.assignees = { add: assigneeIds, rem: [] }; // Add new assignees, remove none
        }

        // Check if there's anything to update (including tags and dependencies which were handled separately)
        const tagsChanged = tags !== undefined || (add_tags?.length ?? 0) > 0 || (remove_tags?.length ?? 0) > 0;
        if (Object.keys(updateBody).length === 0 && !tagsChanged && customFieldCount === 0 && blocking === undefined && waiting_on === undefined && linked_tasks === undefined) {
          return {
            content: [
              {
                type: "text",
                text: "No updates provided. Please specify at least one field to update.",
              },
            ],
          };
        }

        // Update the task (if there are non-tag updates)
        let updatedTask = taskData;
        if (Object.keys(updateBody).length > 0) {
          const updateResponse = await clickupFetch(`https://api.clickup.com/api/v2/task/${task_id}`, {
            method: 'PUT',
            headers: {
              Authorization: CONFIG.authHeader,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(updateBody)
          });

          if (!updateResponse.ok) {
            const errorData = await updateResponse.json().catch(() => ({}));
            throw new Error(`Error updating task: ${updateResponse.status} ${updateResponse.statusText} - ${JSON.stringify(errorData)}`);
          }

          updatedTask = await updateResponse.json();
        }

        // Custom fields have no field in the task update body: write the validated
        // values one by one now that the task is updated.
        let customFieldLines: string[] = [];
        let customFieldFailures: Array<{ field: string; error: string }> = [];
        if (customFieldWrites.length > 0) {
          const written = await executeCustomFieldWrites(task_id, customFieldWrites);
          customFieldLines = formatCustomFieldResult(written);
          customFieldFailures = written.failed;
        }

        // If only tags, dependencies or custom fields were updated, fetch the task again to get the updated state
        if ((tagsChanged || customFieldCount > 0 || blocking !== undefined || waiting_on !== undefined || linked_tasks !== undefined) && Object.keys(updateBody).length === 0) {
          const refreshResponse = await clickupFetch(`https://api.clickup.com/api/v2/task/${task_id}`, {
            headers: { Authorization: CONFIG.authHeader },
          });
          if (refreshResponse.ok) {
            updatedTask = await refreshResponse.json();
          }
        }

        const responseLines = formatTaskResponse(updatedTask, 'updated', {
          name, description, append_description, status, priority, due_date, start_date, time_estimate, tags, parent_task_id, assignees, blocking, waiting_on, linked_tasks
        }, userData);

        responseLines.push(...formatResolvedAssignees(resolvedAssignees));
        if (addedTags.length > 0) {
          responseLines.push(`tags_added: ${addedTags.join(', ')}`);
        }
        if (removedTags.length > 0) {
          responseLines.push(`tags_removed: ${removedTags.join(', ')}`);
        }
        responseLines.push(...customFieldLines);

        // The update was committed but some custom fields were not written: say so up
        // front instead of letting the headline read as a failure of the whole call
        // (or as a complete success).
        if (customFieldFailures.length > 0) {
          const committed: string[] = Object.keys(updateBody).map((key) =>
            key === 'markdown_description' ? 'description' : key === 'parent' ? 'parent_task_id' : key
          );
          if (tagsChanged) committed.push('tags');
          if (blocking !== undefined || waiting_on !== undefined || linked_tasks !== undefined) committed.push('dependencies/links');
          responseLines[0] = `Task updated PARTIALLY: the task changes were saved, but ${customFieldFailures.length} of ${customFieldWrites.length} custom field(s) were NOT written.`;
          responseLines.push(
            `committed_changes: ${committed.length > 0 ? committed.join(', ') : 'none besides the custom fields that were set'}`,
            `custom_fields_not_written: ${customFieldFailures.map((f) => f.field).join(', ')} (see custom_field_warnings; retry them with updateTask custom_fields only)`
          );
        }

        if (description !== undefined) {
          const previousLength = (taskData.markdown_description || "").length;
          responseLines.push(`description: replaced (previous ${previousLength} chars -> ${finalDescription?.length ?? 0} chars; the old version stays restorable via ClickUp's description history)`);
        } else if (append_description !== undefined) {
          responseLines.push('description: appended as dated edit section');
        }

        // Add dependency update results if any
        if (dependencyUpdateResults.length > 0) {
          responseLines.push('dependency_warnings: ' + dependencyUpdateResults.join('; '));
        }

        // Add tag update results if any
        if (tagUpdateResults.length > 0) {
          responseLines.push('tag_warnings: ' + tagUpdateResults.join('; '));
        }

        responseLines.push(...formatAttachedImages(uploadedImages));

        return {
          content: [
            {
              type: "text" as const,
              text: responseLines.join('\n')
            }
          ],
        };

      } catch (error) {
        console.error('Error updating task:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error updating task: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "createTask",
    (() => {
      const descriptionBase = [
        "Creates a new task in a specific list and assigns it to specified users (defaults to current user).",
        "CRITICAL LINKING REQUIREMENTS:",
        "- ALWAYS search for similar existing tasks first using searchTasks to avoid duplicates",
        "- Include links to related tasks in the description (format: https://app.clickup.com/t/TASK_ID)",
        "- Reference parent/child tasks, dependencies, and related work with clickable links",
        "- The response will include the new task's clickable URL - always share this link",
        "Use getListInfo first to understand the list context and available statuses.",
        "Task descriptions support full markdown formatting including **bold**, *italic*, lists, links, and code blocks.",
        IMAGE_SUPPORT_HINT,
        "BEST PRACTICE: Every task creation should result in sharing the clickable task URL for future reference."
      ];

      if (CONFIG.primaryLanguageHint && CONFIG.primaryLanguageHint.toLowerCase() !== 'en') {
        descriptionBase.splice(1, 0,
          `For optimal results, consider writing task names and descriptions in '${CONFIG.primaryLanguageHint}' unless specified otherwise or unless the context requires another language.`);
      }

      return descriptionBase.join("\n");
    })(),
    {
      list_id: z.string().min(1).describe("The ID of the list where the task will be created. Note: ClickUp API does not support moving tasks between lists after creation - this must be done manually in the ClickUp interface"),
      name: taskNameSchema,
      description: z.string().optional().describe("Optional markdown description for the task - supports full markdown formatting"),
      status: z.string().optional().describe("Optional status name - use getListInfo to see valid options"),
      priority: taskPrioritySchema,
      due_date: taskDueDateSchema,
      start_date: taskStartDateSchema,
      time_estimate: taskTimeEstimateSchema,
      tags: taskTagsSchema,
      parent_task_id: z.string().optional().describe("Optional parent task ID to create this as a subtask"),
      assignees: z.array(z.string()).optional().describe(createAssigneeDescription(userData, "defaults to the current user when omitted")),
      custom_fields: taskCustomFieldsSchema
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    async ({ list_id, name, description, status, priority, due_date, start_date, time_estimate, tags, parent_task_id, assignees, custom_fields }) => {
      try {
        // Resolve description images BEFORE creating the task: a broken reference
        // (missing file, dead URL, non-image) must not leave a half-finished task
        // behind. Uploading has to wait until the task exists, though - ClickUp
        // attachments always belong to a task.
        const { markdown: normalizedDescription, images } = await resolveImagesOrAbort(
          description,
          "the task was NOT created"
        );

        const userData = await getCurrentUser();
        const currentUserId = userData.user.id;

        // Assignee names and custom field values are validated before the task is
        // created, so a typo cannot leave a half-configured task behind.
        const resolvedAssignees = assignees !== undefined ? await resolveAssigneesDetailed(assignees) : undefined;
        const { fields: customFieldValues, names: customFieldNames } = custom_fields
          ? await buildCreateCustomFields(list_id, custom_fields)
          : { fields: [], names: {} as Record<string, string> };

        const requestBody = buildTaskRequestBody({
          name, status, priority, due_date, start_date, time_estimate, tags, assignees: resolvedAssignees?.map((a) => a.id), parent_task_id
        }, currentUserId);

        if (customFieldValues.length > 0) {
          requestBody.custom_fields = customFieldValues;
        }

        // Add markdown description if provided
        if (description) {
          requestBody.markdown_description = description;
        }

        const response = await clickupFetch(`https://api.clickup.com/api/v2/list/${list_id}/task`, {
          method: 'POST',
          headers: {
            Authorization: CONFIG.authHeader,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(`Error creating task: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`);
        }

        const createdTask = await response.json();

        // Tags are omitted from the create body by buildTaskRequestBody because they
        // need the dedicated tag endpoints, so apply them here - the same way
        // updateTask does - otherwise the requested tags are silently dropped.
        const tagCreateResults: string[] = [];
        if (tags !== undefined && tags.length > 0) {
          for (const tagName of tags) {
            try {
              const addTagResponse = await clickupFetch(
                `https://api.clickup.com/api/v2/task/${createdTask.id}/tag/${encodeURIComponent(tagName)}`,
                {
                  method: 'POST',
                  headers: { Authorization: CONFIG.authHeader }
                }
              );
              if (!addTagResponse.ok) {
                console.error(`Failed to add tag "${tagName}": ${addTagResponse.status}`);
                tagCreateResults.push(`Failed to add tag: ${tagName}`);
              }
            } catch (error) {
              console.error(`Error adding tag "${tagName}":`, error);
              tagCreateResults.push(`Error adding tag: ${tagName}`);
            }
          }
        }

        // Images can only be attached once the task exists, so the description is
        // written first with its original sources and then rewritten to the CDN URLs.
        // At this point every source resolved successfully - only the upload API
        // itself can still fail, and then the task already exists, so that is
        // reported as a warning instead of pretending the task was not created.
        const imageWarnings: string[] = [];
        const { uploaded, failure: uploadFailure } = await uploadResolvedImages(createdTask.id, images);
        if (uploadFailure) {
          console.error(`Failed to attach image "${uploadFailure.src}": ${uploadFailure.error}`);
          imageWarnings.push(
            `WARNING: the task was created, but uploading image "${uploadFailure.src}" failed: ${uploadFailure.error}`,
            `The description still references the original image source. Fix the problem and add the image via updateTask.`
          );
        }
        const attachmentMap = toAttachmentMap(uploaded);
        if (description && attachmentMap.size > 0) {
          const rewritten = rewriteMarkdownImageUrls(normalizedDescription, attachmentMap);
          if (rewritten !== description) {
            const descriptionResponse = await clickupFetch(`https://api.clickup.com/api/v2/task/${createdTask.id}`, {
              method: 'PUT',
              headers: {
                Authorization: CONFIG.authHeader,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ markdown_description: rewritten })
            });
            if (!descriptionResponse.ok) {
              // The task itself exists - report the problem instead of failing the call.
              console.error(`Failed to write image URLs into description: ${descriptionResponse.status}`);
              imageWarnings.push(
                `WARNING: description update failed (${descriptionResponse.status} ${descriptionResponse.statusText}) - the images are attached to the task but not embedded in the description`
              );
            }
          }
        }

        const responseLines = formatTaskResponse(createdTask, 'created', {
          list_id, name, description, status, priority, due_date, start_date, time_estimate, tags, parent_task_id, assignees
        }, userData);

        responseLines.push(...formatResolvedAssignees(resolvedAssignees));
        if (customFieldValues.length > 0) {
          // ClickUp silently drops custom fields that do not apply to the task, so
          // report what is actually on the created task, not what was submitted.
          let createdFields = createdTask;
          if (!Array.isArray(createdTask.custom_fields)) {
            try {
              const refreshed = await clickupFetch(`https://api.clickup.com/api/v2/task/${createdTask.id}`, {
                headers: { Authorization: CONFIG.authHeader },
              });
              if (refreshed.ok) {
                createdFields = await refreshed.json();
              }
            } catch (error) {
              console.error('Error re-reading created task for custom fields:', error);
            }
          }
          if (Array.isArray(createdFields.custom_fields)) {
            responseLines.push(...formatCreatedCustomFields(checkCreatedCustomFields(createdFields, customFieldValues, customFieldNames)));
          } else {
            responseLines.push(`custom_fields: sent ${customFieldValues.length}, could not verify that ClickUp saved them - check the task`);
          }
        }

        responseLines.push(...formatAttachedImages(uploaded));
        responseLines.push(...imageWarnings);
        if (tagCreateResults.length > 0) {
          responseLines.push('tag_warnings: ' + tagCreateResults.join('; '));
        }

        return {
          content: [
            {
              type: "text" as const,
              text: responseLines.join('\n')
            }
          ],
        };

      } catch (error) {
        console.error('Error creating task:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error creating task: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );
}

// Write-specific utility functions

function createAssigneeDescription(userData: any, behavior: string): string {
  const user = userData.user;
  return `${taskAssigneesDescription} - ${behavior} (current user: ${user.username} (user_id: ${user.id}))`;
}

/** Name the users that a username/email input resolved to, so a wrong guess is visible. */
function formatResolvedAssignees(resolved: Array<{ id: string; username?: string }> | undefined): string[] {
  if (!resolved || !resolved.some((a) => a.username)) {
    return [];
  }
  return [`assignees_resolved: ${resolved.map((a) => formatMember(a)).join(', ')}`];
}

/** Add or remove a single tag; returns a warning text on failure, null on success. */
async function changeTag(taskId: string, operation: 'add' | 'remove', tagName: string): Promise<string | null> {
  try {
    const response = await clickupFetch(
      `https://api.clickup.com/api/v2/task/${taskId}/tag/${encodeURIComponent(tagName)}`,
      {
        method: operation === 'add' ? 'POST' : 'DELETE',
        headers: { Authorization: CONFIG.authHeader }
      }
    );
    if (!response.ok) {
      console.error(`Failed to ${operation} tag "${tagName}": ${response.status}`);
      return `Failed to ${operation} tag: ${tagName}`;
    }
    return null;
  } catch (error) {
    console.error(`Error changing tag "${tagName}":`, error);
    return `Error trying to ${operation} tag: ${tagName}`;
  }
}

function convertPriorityToNumber(priority: string): number {
  switch (priority) {
    case "urgent": return 1;
    case "high": return 2;
    case "normal": return 3;
    case "low": return 4;
    default: return 3;
  }
}

function convertPriorityToString(priority: number): string {
  const priorityMap = { 1: 'urgent', 2: 'high', 3: 'normal', 4: 'low' };
  return priorityMap[priority as keyof typeof priorityMap] || 'unknown';
}

function formatTimeEstimate(hours: number): string {
  const displayHours = Math.floor(hours);
  const displayMinutes = Math.round((hours - displayHours) * 60);
  return displayHours > 0 ? `${displayHours}h ${displayMinutes}m` : `${displayMinutes}m`;
}

/**
 * Load a single comment of a task.
 *
 * ClickUp has no `GET /comment/{id}`, so the task's comment list is the only way
 * to learn a comment's author and age - both of which editComment has to check
 * before touching anything.
 *
 * The list returns the 25 newest comments per page, so a busy ticket needs paging
 * to reach the wanted comment. Paging stops as soon as a page ends outside the edit
 * window: everything older would be refused anyway, which keeps this to a single
 * request in the normal case.
 *
 * Note the list only contains top-level comments; replies inside a thread live
 * behind `/comment/{parent_id}/reply` and are therefore not editable here.
 */
export async function findTaskComment(taskId: string, commentId: string): Promise<ExistingComment> {
  const oldestEditableDate = Date.now() - CONFIG.commentEditWindowHours * 60 * 60 * 1000;

  let cursor: CommentPageCursor | undefined;
  let checked = 0;
  let pages = 0;
  let sawThreadedReplies = false;

  while (pages < MAX_COMMENT_PAGES) {
    const page = await fetchCommentPage(taskId, cursor);
    pages++;
    if (page.length === 0) {
      break;
    }

    const match = page.find((entry) => String(entry.id) === String(commentId));
    if (match) {
      return match;
    }

    checked += page.length;
    sawThreadedReplies ||= page.some((entry) => (entry.reply_count ?? 0) > 0);

    // Comments come back newest first, so once a page runs past the edit window
    // there is nothing editable further back.
    const oldest = page[page.length - 1];
    if (Number(oldest.date) < oldestEditableDate) {
      break;
    }
    cursor = { start: String(oldest.date), startId: String(oldest.id) };
  }

  const threadedHint = sawThreadedReplies
    ? " This task has threaded replies, and replies inside a thread cannot be edited - answer them with a new comment instead."
    : "";
  throw new Error(
    `Comment ${commentId} was not found on task ${taskId} (${checked} top-level comment(s) checked across ${pages} page(s), newest first).${threadedHint}`
  );
}

/**
 * The whole safety model of editComment.
 *
 * ClickUp cannot tell "written through this MCP" from "written by the token owner
 * in the web UI" - both carry the same user id - so the author check only keeps
 * other people's comments safe, and the time window is what keeps the tool from
 * rewriting history.
 */
export function assertCommentIsEditable(comment: ExistingComment, currentUserId: number | string): void {
  const windowHours = CONFIG.commentEditWindowHours;
  if (!(windowHours > 0)) {
    throw new Error(
      `Editing comments is disabled (CLICKUP_COMMENT_EDIT_WINDOW_HOURS=${windowHours}). Add a new comment instead.`
    );
  }

  if (String(comment.user?.id ?? '') !== String(currentUserId)) {
    throw new Error(
      `Comment ${comment.id} was written by ${comment.user?.username || 'someone else'} (user_id: ${comment.user?.id ?? 'unknown'}), not by the current user (user_id: ${currentUserId}). Only your own comments can be edited - reply with a new comment instead.`
    );
  }

  const ageHours = (Date.now() - Number(comment.date)) / (1000 * 60 * 60);
  if (ageHours > windowHours) {
    throw new Error(
      `Comment ${comment.id} was created ${ageHours.toFixed(1)} hours ago (${timestampToIso(comment.date)}), which is outside the ${windowHours} hour edit window. Add a new comment instead of rewriting an old one.`
    );
  }
}

/**
 * Formats timestamp to ISO string with local timezone (not UTC)
 */
function timestampToIso(timestamp: number | string): string {
  const date = new Date(+timestamp);

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  // Calculate timezone offset
  const offset = date.getTimezoneOffset();
  const offsetHours = Math.floor(Math.abs(offset) / 60);
  const offsetMinutes = Math.abs(offset) % 60;
  const sign = offset <= 0 ? '+' : '-';
  const timezoneOffset = sign + String(offsetHours).padStart(2, '0') + ':' + String(offsetMinutes).padStart(2, '0');

  return `${year}-${month}-${day}T${hours}:${minutes}${timezoneOffset}`;
}

function buildTaskRequestBody(params: {
  name?: string;
  description?: string;
  status?: string;
  priority?: string;
  due_date?: string;
  start_date?: string;
  time_estimate?: number;
  tags?: string[];
  assignees?: string[];
  parent_task_id?: string;
}, currentUserId?: string): any {
  const requestBody: any = {};

  if (params.name !== undefined) {
    requestBody.name = params.name;
  }

  if (params.status !== undefined) {
    requestBody.status = params.status;
  }

  if (params.priority !== undefined) {
    requestBody.priority = convertPriorityToNumber(params.priority);
  }

  if (params.due_date !== undefined) {
    requestBody.due_date = new Date(params.due_date).getTime();
  }

  if (params.start_date !== undefined) {
    requestBody.start_date = new Date(params.start_date).getTime();
  }

  if (params.time_estimate !== undefined) {
    requestBody.time_estimate = Math.round(params.time_estimate * 60 * 60 * 1000);
  }

  // Tags are handled separately via dedicated API endpoints
  // Do not include in the update request body

  if (params.assignees !== undefined) {
    requestBody.assignees = params.assignees;
  } else if (currentUserId) {
    requestBody.assignees = [currentUserId];
  }

  if (params.parent_task_id !== undefined) {
    requestBody.parent = params.parent_task_id;
  }

  return requestBody;
}

// Helper function to manage task dependencies
async function updateTaskDependencies(
  taskId: string,
  taskData: any,
  dependencies: {
    blocking?: string[];
    waiting_on?: string[];
    linked_tasks?: string[];
  }
): Promise<string[]> {
  const errors: string[] = [];
  
  // Get current dependencies. The API never returns `blocking` / `waiting_on` on a
  // task (reading them found nothing, so no dependency could ever be removed);
  // it returns one flat `dependencies` array of `{ task_id, depends_on }` pairs
  // meaning "task_id waits on depends_on". Which side this task sits on decides the
  // direction - the same reading getTaskById uses, and the exact inverse of what the
  // add code below writes (POST /task/{waiting}/dependency { depends_on: {blocker} }).
  // `type` is deliberately not consulted: the API does not use it consistently.
  const ownIds = new Set<string>([taskId, String(taskData.id ?? taskId)]);
  const dependencyPairs: any[] = Array.isArray(taskData.dependencies) ? taskData.dependencies : [];
  const unique = (ids: any[]): string[] => Array.from(new Set(ids.filter(Boolean).map(String)));
  // Tasks waiting on this one are the ones this task is blocking.
  const currentBlocking = unique(
    dependencyPairs.filter((dep) => ownIds.has(String(dep.depends_on))).map((dep) => dep.task_id)
  );
  const currentWaitingOn = unique(
    dependencyPairs.filter((dep) => ownIds.has(String(dep.task_id))).map((dep) => dep.depends_on)
  );
  // `linked_tasks` entries are link records, not tasks: each has `task_id` and
  // `link_id` (the two ends of the link) and no `id` at all. Mapping `.id` here
  // produced `[undefined, ...]`, so every existing link looked like it was no
  // longer requested, and the removal loop then issued
  // `DELETE /task/{id}/link/undefined`, which the API rejects. The result was a
  // `linked_tasks` field documented as "replace" that could never remove
  // anything. Take whichever end of the record is not the task being updated.
  const currentLinked = taskData.linked_tasks
    ?.map((link: any) => (link.task_id === taskData.id ? link.link_id : link.task_id))
    .filter((id: string | undefined): id is string => Boolean(id)) || [];

  // Helper function to make dependency API calls
  async function modifyDependency(
    operation: 'add' | 'remove',
    type: 'blocking' | 'waiting_on' | 'linked',
    fromTaskId: string,
    toTaskId: string,
    dependsOn: string
  ): Promise<void> {
    try {
      let url: string;
      let options: RequestInit;

      if (type === 'linked') {
        // Linked tasks use a different endpoint
        url = `https://api.clickup.com/api/v2/task/${fromTaskId}/link/${toTaskId}`;
        options = {
          method: operation === 'add' ? 'POST' : 'DELETE',
          headers: { Authorization: CONFIG.authHeader }
        };
      } else {
        // Dependencies (blocking/waiting_on)
        if (operation === 'add') {
          url = `https://api.clickup.com/api/v2/task/${fromTaskId}/dependency`;
          options = {
            method: 'POST',
            headers: {
              Authorization: CONFIG.authHeader,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              depends_on: dependsOn,
              dependency_type: 1 // Always use 1 for waiting_on type
            })
          };
        } else {
          // Remove dependency
          url = `https://api.clickup.com/api/v2/task/${fromTaskId}/dependency?depends_on=${dependsOn}`;
          options = {
            method: 'DELETE',
            headers: { Authorization: CONFIG.authHeader }
          };
        }
      }

      const response = await clickupFetch(url, options);
      if (!response.ok) {
        const action = operation === 'add' ? 'add' : 'remove';
        const typeLabel = type === 'linked' ? 'link' : type.replace('_', ' ');
        console.error(`Failed to ${action} ${typeLabel} "${toTaskId}": ${response.status}`);
        errors.push(`Failed to ${action} ${typeLabel}: ${toTaskId}`);
      }
    } catch (error) {
      const action = operation === 'add' ? 'adding' : 'removing';
      const typeLabel = type === 'linked' ? 'link' : type.replace('_', ' ');
      console.error(`Error ${action} ${typeLabel} "${toTaskId}":`, error);
      errors.push(`Error ${action} ${typeLabel}: ${toTaskId}`);
    }
  }

  // Process blocking dependencies (tasks that should depend on this task)
  if (dependencies.blocking !== undefined) {
    const toAdd = dependencies.blocking.filter(id => !currentBlocking.includes(id));
    const toRemove = currentBlocking.filter((id: string) => !dependencies.blocking!.includes(id));

    // To make another task depend on this one, add dependency FROM that task TO this task
    for (const depTaskId of toAdd) {
      await modifyDependency('add', 'blocking', depTaskId, depTaskId, taskId);
    }
    for (const depTaskId of toRemove) {
      await modifyDependency('remove', 'blocking', depTaskId, depTaskId, taskId);
    }
  }

  // Process waiting_on dependencies
  if (dependencies.waiting_on !== undefined) {
    const toAdd = dependencies.waiting_on.filter(id => !currentWaitingOn.includes(id));
    const toRemove = currentWaitingOn.filter((id: string) => !dependencies.waiting_on!.includes(id));

    for (const depTaskId of toAdd) {
      await modifyDependency('add', 'waiting_on', taskId, depTaskId, depTaskId);
    }
    for (const depTaskId of toRemove) {
      await modifyDependency('remove', 'waiting_on', taskId, depTaskId, depTaskId);
    }
  }

  // Process linked tasks
  if (dependencies.linked_tasks !== undefined) {
    const toAdd = dependencies.linked_tasks.filter(id => !currentLinked.includes(id));
    const toRemove = currentLinked.filter((id: string) => !dependencies.linked_tasks!.includes(id));

    for (const linkedTaskId of toAdd) {
      await modifyDependency('add', 'linked', taskId, linkedTaskId, linkedTaskId);
    }
    for (const linkedTaskId of toRemove) {
      await modifyDependency('remove', 'linked', taskId, linkedTaskId, linkedTaskId);
    }
  }

  return errors;
}

function formatTaskResponse(task: any, operation: 'created' | 'updated', params: any, userData: any): string[] {
  const responseLines = [
    `Task ${operation} successfully!`,
    `task_id: ${task.id}`,
    `name: ${task.name}`,
    ...(operation === 'created' ? [`url: ${task.url}`] : []),
    `status: ${task.status?.status || 'Unknown'}`,
    `assignees: ${task.assignees?.map((a: any) => formatMember(a)).join(', ') || 'None'}`,
    ...(operation === 'created' && params.list_id ? [`list_id: ${params.list_id}`] : []),
    ...(operation === 'updated' ? [
      `updated_by: ${formatMember(userData.user)}`,
      `updated_at: ${timestampToIso(Date.now())}`
    ] : [])
  ];

  if (params.priority !== undefined || task.priority) {
    const priority = task.priority ? convertPriorityToString(task.priority.priority) :
                    params.priority ? params.priority : 'unknown';
    responseLines.push(`priority: ${priority}`);
  }

  if (params.due_date !== undefined) {
    responseLines.push(`due_date: ${params.due_date}`);
  }

  if (params.start_date !== undefined) {
    responseLines.push(`start_date: ${params.start_date}`);
  }

  if (params.time_estimate !== undefined) {
    responseLines.push(`time_estimate: ${formatTimeEstimate(params.time_estimate)}`);
  }

  if (params.tags !== undefined && params.tags.length > 0) {
    responseLines.push(`tags: ${params.tags.join(', ')}`);
  }

  if (params.parent_task_id !== undefined) {
    responseLines.push(`parent_task_id: ${params.parent_task_id}`);
  }

  if (params.blocking !== undefined && params.blocking.length > 0) {
    responseLines.push(`blocking: ${params.blocking.join(', ')}`);
  }

  if (params.waiting_on !== undefined && params.waiting_on.length > 0) {
    responseLines.push(`waiting_on: ${params.waiting_on.join(', ')}`);
  }

  if (params.linked_tasks !== undefined && params.linked_tasks.length > 0) {
    responseLines.push(`linked_tasks: ${params.linked_tasks.join(', ')}`);
  }

  return responseLines;
}
