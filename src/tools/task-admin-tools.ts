import { clickupFetch } from "../shared/clickup-fetch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONFIG } from "../shared/config";
import { generateTaskUrl, getCurrentUser } from "../shared/utils";
import { findTaskComment, assertCommentIsEditable } from "./task-write-tools";
import { assertSafeId } from "../shared/ids";

const MULTI_LIST_HINT = "Enable the Tasks in Multiple Lists ClickApp for this Space";

const taskIdSchema = z.string().min(1).describe("The task ID");
const listIdSchema = (what: string) =>
  z.string().min(1).describe(`${what}. Find list IDs with getListInfo (if you have a list URL) or searchSpaces (to browse a space's lists).`);

type ToolResult = { isError?: boolean; content: { type: "text"; text: string }[] };

function text(message: string, isError = false): ToolResult {
  return isError
    ? { isError: true, content: [{ type: "text", text: message }] }
    : { content: [{ type: "text", text: message }] };
}

interface TaskInfo {
  id: string;
  name: string;
  listId: string;
  listName: string;
  statusId: string;
  statusName: string;
}

async function fetchTask(task_id: string): Promise<TaskInfo> {
  task_id = assertSafeId(task_id, "task_id");
  const response = await clickupFetch(`https://api.clickup.com/api/v2/task/${task_id}`, {
    headers: { Authorization: CONFIG.authHeader },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Error fetching task ${task_id}: ${response.status} ${response.statusText} ${body}`.trim());
  }
  const task = await response.json();
  return {
    id: task.id ?? task_id,
    name: task.name ?? "(unnamed)",
    listId: String(task.list?.id ?? ""),
    listName: task.list?.name ?? "Unknown list",
    statusId: String(task.status?.id ?? ""),
    statusName: task.status?.status ?? "",
  };
}

async function callListTask(method: "POST" | "DELETE", list_id: string, task_id: string): Promise<{ ok: boolean; error: string }> {
  list_id = assertSafeId(list_id, "list_id");
  task_id = assertSafeId(task_id, "task_id");
  const response = await clickupFetch(`https://api.clickup.com/api/v2/list/${list_id}/task/${task_id}`, {
    method,
    headers: { Authorization: CONFIG.authHeader },
  });
  if (response.ok) return { ok: true, error: "" };
  const body = await response.text().catch(() => "");
  return { ok: false, error: `${response.status} ${response.statusText} ${body}`.trim() };
}

function fail(prefix: string, error: unknown): ToolResult {
  console.error(prefix, error);
  return text(`${prefix} ${error instanceof Error ? error.message : String(error)}`, true);
}

export function registerTaskAdminTools(server: McpServer) {
  server.tool(
    "deleteTask",
    [
      "Deletes a task. THIS IS PERMANENT from the API's point of view: there is no undo through this tool (ClickUp keeps deleted tasks in the Trash for 30 days, where a human can restore them in the ClickUp UI).",
      "Two-step safety: call first with confirm=false (or omitted) to get the task name and list back, show them to the user and ask for explicit confirmation, then call again with confirm=true.",
      "Never set confirm=true without the user having approved this specific task."
    ].join("\n"),
    {
      task_id: taskIdSchema.describe("The ID of the task to delete"),
      confirm: z.boolean().optional().describe("Must be true to actually delete. Only set after the user explicitly confirmed deleting this task.")
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async ({ task_id, confirm }) => {
      try {
        task_id = assertSafeId(task_id, "task_id");
        const task = await fetchTask(task_id);
        const label = `${task.name} (task_id: ${task.id}) in ${task.listName} (list_id: ${task.listId})`;
        if (confirm !== true) {
          return text(
            `Not deleted. Deleting is permanent (ClickUp keeps the Trash for 30 days). Task: ${label}. Ask the user to confirm, then call deleteTask again with confirm=true.`,
            true
          );
        }
        const response = await clickupFetch(`https://api.clickup.com/api/v2/task/${task_id}`, {
          method: "DELETE",
          headers: { Authorization: CONFIG.authHeader },
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`${response.status} ${response.statusText} ${body}`.trim());
        }
        return text(`Deleted task: ${label}. It stays in the ClickUp Trash for 30 days.`);
      } catch (error) {
        return fail("Error deleting task:", error);
      }
    }
  );

  server.tool(
    "moveTask",
    [
      "Moves a task to another list by changing its home list (uses ClickUp's dedicated move endpoint). Does not require the Tasks in Multiple Lists ClickApp and does not affect any other list memberships of the task.",
      "If the destination list has no status with the same name as the task's current status, pass `status` (a destination status name); otherwise the call returns the destination statuses to choose from.",
      "Custom fields are moved along by default (move_custom_fields)."
    ].join("\n"),
    {
      task_id: taskIdSchema.describe("The ID of the task to move"),
      list_id: listIdSchema("The ID of the list to move the task into"),
      status: z.string().optional().describe("Destination status name. Required only when the destination list has no status matching the task's current status."),
      move_custom_fields: z.boolean().optional().describe("Whether to move the task's custom fields to the new list. Default true.")
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async ({ task_id, list_id, status, move_custom_fields }) => {
      try {
        task_id = assertSafeId(task_id, "task_id");
        list_id = assertSafeId(list_id, "list_id");
        const task = await fetchTask(task_id);
        const label = `${task.name} (task_id: ${task.id})`;
        if (task.listId === list_id) {
          return text(`No change: ${label} is already in list ${task.listName} (list_id: ${task.listId}). ${generateTaskUrl(task.id)}`);
        }

        const listResponse = await clickupFetch(`https://api.clickup.com/api/v2/list/${list_id}`, {
          headers: { Authorization: CONFIG.authHeader },
        });
        if (!listResponse.ok) {
          const body = await listResponse.text().catch(() => "");
          throw new Error(`Error fetching list ${list_id}: ${listResponse.status} ${listResponse.statusText} ${body}`.trim());
        }
        const list = await listResponse.json();
        const destStatuses: { id: string; status: string }[] = Array.isArray(list.statuses) ? list.statuses : [];

        const body: Record<string, unknown> = { move_custom_fields: move_custom_fields ?? true };
        let statusUsed: string;
        const sameName = destStatuses.find(s => s.status?.toLowerCase() === task.statusName.toLowerCase());
        if (sameName) {
          statusUsed = `${sameName.status} (unchanged)`;
        } else {
          const wanted = status?.trim().toLowerCase();
          const match = wanted ? destStatuses.find(s => s.status?.toLowerCase() === wanted) : undefined;
          if (!match) {
            const options = destStatuses.map(s => `${s.status} (status_id: ${s.id})`).join(", ");
            return text(
              `Not moved. The destination list ${list.name ?? list_id} (list_id: ${list_id}) has no status matching the task's current status "${task.statusName}"${status ? ` and "${status}" was not found` : ""}. Destination statuses: ${options}. Call moveTask again with \`status\` set to one of them.`,
              true
            );
          }
          body.status_mappings = [{ source_status_id: task.statusId, destination_status_id: match.id }];
          statusUsed = match.status;
        }

        const response = await clickupFetch(
          `https://api.clickup.com/api/v3/workspaces/${CONFIG.teamId}/tasks/${task_id}/home_list/${list_id}`,
          {
            method: "PUT",
            headers: { Authorization: CONFIG.authHeader, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        );
        if (!response.ok) {
          const errBody = await response.text().catch(() => "");
          return text(`Could not move ${label} to list ${list_id}: ${response.status} ${response.statusText} ${errBody}`.trim(), true);
        }
        return text(
          `Moved ${label} from ${task.listName} (list_id: ${task.listId}) to ${list.name ?? "list"} (list_id: ${list_id}). Status: ${statusUsed}. ${generateTaskUrl(task.id)}`
        );
      } catch (error) {
        return fail("Error moving task:", error);
      }
    }
  );

  server.tool(
    "addTaskToList",
    [
      "Adds a task to an additional list while keeping it in its current lists (the task then appears in both).",
      "Requires the Tasks in Multiple Lists ClickApp to be enabled for the Space. Use moveTask to change the home list instead."
    ].join("\n"),
    {
      task_id: taskIdSchema.describe("The ID of the task to add"),
      list_id: listIdSchema("The ID of the list to add the task to")
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async ({ task_id, list_id }) => {
      try {
        task_id = assertSafeId(task_id, "task_id");
        list_id = assertSafeId(list_id, "list_id");
        const added = await callListTask("POST", list_id, task_id);
        if (!added.ok) {
          return text(`Could not add task ${task_id} to list ${list_id}: ${added.error}\n${MULTI_LIST_HINT}`, true);
        }
        return text(`Added task (task_id: ${task_id}) to list_id: ${list_id}. ${generateTaskUrl(task_id)}`);
      } catch (error) {
        return fail("Error adding task to list:", error);
      }
    }
  );

  server.tool(
    "removeTaskFromList",
    [
      "Removes a task from an additional list it was added to. The task's home list cannot be removed this way: use moveTask to relocate it or deleteTask to delete it.",
      "Requires the Tasks in Multiple Lists ClickApp. Set confirm=true only after the user approved the removal."
    ].join("\n"),
    {
      task_id: taskIdSchema.describe("The ID of the task to remove"),
      list_id: listIdSchema("The ID of the list to remove the task from"),
      confirm: z.boolean().optional().describe("Must be true to actually remove. Only set after the user explicitly confirmed.")
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async ({ task_id, list_id, confirm }) => {
      try {
        task_id = assertSafeId(task_id, "task_id");
        list_id = assertSafeId(list_id, "list_id");
        const task = await fetchTask(task_id);
        const label = `${task.name} (task_id: ${task.id})`;
        if (task.listId === String(list_id)) {
          return text(
            `Refused: list_id ${list_id} (${task.listName}) is the home list of ${label}. Use moveTask to move it to another list or deleteTask to delete it.`,
            true
          );
        }
        if (confirm !== true) {
          return text(
            `Not removed. Would remove ${label} from list_id: ${list_id}. Ask the user to confirm, then call removeTaskFromList again with confirm=true.`,
            true
          );
        }
        const removed = await callListTask("DELETE", list_id, task_id);
        if (!removed.ok) {
          return text(`Could not remove ${label} from list ${list_id}: ${removed.error}\n${MULTI_LIST_HINT}`, true);
        }
        return text(`Removed ${label} from list_id: ${list_id}. ${generateTaskUrl(task.id)}`);
      } catch (error) {
        return fail("Error removing task from list:", error);
      }
    }
  );

  server.tool(
    "deleteComment",
    [
      "Deletes one of your own recent task comments. THIS IS PERMANENT: there is no undo.",
      `GUARDRAILS: only comments written by the API token's own user can be deleted, and only within ${CONFIG.commentEditWindowHours} hours of their creation (same window as editComment). Only top-level comments can be deleted, not replies inside a thread.`,
      "Two-step safety: call first with confirm=false (or omitted) to get a preview of the comment, show it to the user and ask for explicit confirmation, then call again with confirm=true.",
      "Never set confirm=true without the user having approved deleting this specific comment."
    ].join("\n"),
    {
      task_id: taskIdSchema.describe("The ID of the task the comment belongs to - needed to locate the comment"),
      comment_id: z.string().min(1).describe("The ID of the comment to delete, as returned by addComment or getTaskById"),
      confirm: z.boolean().optional().describe("Must be true to actually delete. Only set after the user explicitly confirmed deleting this comment.")
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async ({ task_id, comment_id, confirm }) => {
      try {
        task_id = assertSafeId(task_id, "task_id");
        comment_id = assertSafeId(comment_id, "comment_id");
        const [comment, userData] = await Promise.all([
          findTaskComment(task_id, comment_id),
          getCurrentUser(),
        ]);
        assertCommentIsEditable(comment, userData.user.id);

        const fullText = comment.comment_text ?? "";
        const preview = fullText.length > 200 ? `${fullText.slice(0, 200)}...` : fullText;
        const label = `comment_id: ${comment_id} on task_id: ${task_id}`;
        if (confirm !== true) {
          return text(
            `Not deleted. Deleting a comment is permanent. Comment (${label}): "${preview || "(no plain text available)"}". Ask the user to confirm, then call deleteComment again with confirm=true.`,
            true
          );
        }

        const response = await clickupFetch(`https://api.clickup.com/api/v2/comment/${comment_id}`, {
          method: "DELETE",
          headers: { Authorization: CONFIG.authHeader },
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`${response.status} ${response.statusText} ${body}`.trim());
        }
        return text(`Deleted comment (${label}): "${preview || "(no plain text available)"}". ${generateTaskUrl(task_id)}`);
      } catch (error) {
        return fail("Error deleting comment:", error);
      }
    }
  );

  server.tool(
    "mergeTasks",
    [
      "Merges one or more source tasks INTO a target task. ClickUp combines their content into the target and closes/merges the source tasks, so this is hard to undo.",
      "Two-step safety: call first with confirm=false (or omitted) to get what will be merged into what, show it to the user and ask for explicit confirmation, then call again with confirm=true.",
      "Never set confirm=true without the user having approved this specific merge."
    ].join("\n"),
    {
      target_task_id: taskIdSchema.describe("The ID of the task that remains and receives the merged content"),
      source_task_ids: z.array(z.string().min(1)).min(1).max(20).describe("The IDs of the tasks to merge into the target (1 to 20). These are closed/merged by ClickUp."),
      confirm: z.boolean().optional().describe("Must be true to actually merge. Only set after the user explicitly confirmed this merge.")
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    async ({ target_task_id, source_task_ids, confirm }) => {
      try {
        target_task_id = assertSafeId(target_task_id, "target_task_id");
        const sourceIds = Array.from(new Set(source_task_ids.map(id => assertSafeId(id, "source_task_id"))));
        if (sourceIds.includes(target_task_id)) {
          return text(`Refused: target_task_id ${target_task_id} is also listed in source_task_ids. A task cannot be merged into itself.`, true);
        }
        const [target, ...sources] = await Promise.all([target_task_id, ...sourceIds].map(fetchTask));
        const targetLabel = `${target.name} (task_id: ${target.id}) in ${target.listName} (list_id: ${target.listId})`;
        const sourceLines = sources.map(t => `  - ${t.name} (task_id: ${t.id}) in ${t.listName} (list_id: ${t.listId})`);
        if (confirm !== true) {
          return text(
            [
              `Not merged. Would merge ${sources.length} task(s) INTO the target ${targetLabel}:`,
              ...sourceLines,
              "ClickUp closes/merges the source tasks, so this is hard to undo. Ask the user to confirm, then call mergeTasks again with confirm=true.",
            ].join("\n"),
            true
          );
        }

        const response = await clickupFetch(`https://api.clickup.com/api/v2/task/${target_task_id}/merge`, {
          method: "POST",
          headers: { Authorization: CONFIG.authHeader, "Content-Type": "application/json" },
          body: JSON.stringify({ source_task_ids: sourceIds }),
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(`${response.status} ${response.statusText} ${body}`.trim());
        }
        return text(
          [
            `Merged ${sources.length} task(s) into ${targetLabel}:`,
            ...sourceLines,
            `Target: ${generateTaskUrl(target.id)}`,
          ].join("\n")
        );
      } catch (error) {
        return fail("Error merging tasks:", error);
      }
    }
  );
}
