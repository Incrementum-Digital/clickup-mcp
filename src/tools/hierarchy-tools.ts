import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONFIG } from "../shared/config";
import { assertSafeId } from "../shared/ids";
import { resolveAssignee } from "../shared/members";
import { generateFolderUrl, generateListUrl, generateSpaceUrl, parseDateFilter } from "../shared/utils";

const API = "https://api.clickup.com/api/v2";

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

async function sendJson(url: string, method: "POST" | "PUT", body: unknown, what: string): Promise<any> {
  const response = await fetch(url, {
    method,
    headers: { Authorization: CONFIG.authHeader, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(`Error ${what}: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`);
  }
  return response.json();
}

function formatListLine(list: any): string {
  const parts = [`${list.name} (list_id: ${list.id})`];
  if (list.task_count !== undefined && list.task_count !== null) parts.push(`task_count=${list.task_count}`);
  parts.push(generateListUrl(String(list.id)));
  return parts.join(" ");
}

export function registerHierarchyToolsRead(server: McpServer) {
  server.tool(
    "getFolder",
    [
      "Gets a folder with its space and all of its lists (ids, task counts and URLs).",
      "Use searchSpaces to find folder ids."
    ].join("\n"),
    {
      folder_id: z.string().min(1).describe("The folder ID")
    },
    { readOnlyHint: true },
    async ({ folder_id }) => {
      try {
        const id = assertSafeId(folder_id, "folder_id");
        const response = await fetch(`${API}/folder/${id}`, {
          headers: { Authorization: CONFIG.authHeader },
        });
        if (!response.ok) {
          throw new Error(`Error fetching folder: ${response.status} ${response.statusText}`);
        }
        const folder = await response.json();
        const lists: any[] = Array.isArray(folder.lists) ? folder.lists : [];
        const lines = [
          `Folder: ${folder.name} (folder_id: ${folder.id ?? id})`,
          `folder_url: ${generateFolderUrl(String(folder.id ?? id))}`,
          `hidden: ${folder.hidden ?? false}`,
        ];
        if (folder.space?.id) {
          lines.push(`space: ${folder.space.name ?? "Unknown"} (space_id: ${folder.space.id})`);
          lines.push(`space_url: ${generateSpaceUrl(String(folder.space.id))}`);
        }
        lines.push(`Lists (${lists.length}):`);
        lists.forEach((list) => lines.push(`  - ${formatListLine(list)}`));
        return textResult(lines.join("\n"));
      } catch (error) {
        console.error("Error getting folder:", error);
        return textResult(`Error getting folder: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );
}

export function registerHierarchyToolsWrite(server: McpServer) {
  server.tool(
    "createFolder",
    "Creates a folder in a space. Returns the folder id and URL. Use createList afterwards to add lists to it.",
    {
      space_id: z.string().min(1).describe("The space ID to create the folder in"),
      name: z.string().min(1).describe("Folder name")
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async ({ space_id, name }) => {
      try {
        const id = assertSafeId(space_id, "space_id");
        const folder = await sendJson(`${API}/space/${id}/folder`, "POST", { name }, "creating folder");
        return textResult(
          [
            `Created folder: ${folder.name ?? name} (folder_id: ${folder.id})`,
            `folder_url: ${generateFolderUrl(String(folder.id))}`,
            `space: ${folder.space?.name ?? "Unknown"} (space_id: ${folder.space?.id ?? id})`,
          ].join("\n")
        );
      } catch (error) {
        console.error("Error creating folder:", error);
        return textResult(`Error creating folder: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  server.tool(
    "updateFolder",
    "Renames a folder.",
    {
      folder_id: z.string().min(1).describe("The folder ID"),
      name: z.string().min(1).describe("The new folder name")
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    async ({ folder_id, name }) => {
      try {
        const id = assertSafeId(folder_id, "folder_id");
        const folder = await sendJson(`${API}/folder/${id}`, "PUT", { name }, "updating folder");
        return textResult(
          [
            `Updated folder: ${folder.name ?? name} (folder_id: ${folder.id ?? id})`,
            `folder_url: ${generateFolderUrl(String(folder.id ?? id))}`,
          ].join("\n")
        );
      } catch (error) {
        console.error("Error updating folder:", error);
        return textResult(`Error updating folder: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  server.tool(
    "createList",
    [
      "Creates a list either inside a folder (folder_id) or directly in a space as a folderless list (space_id). Pass exactly one of the two.",
      "Returns the list id, URL and its statuses (use those status names for createTask).",
      "content is the list description in markdown.",
      "assignee accepts a user id, username or email.",
      "due_date is an ISO 8601 date or datetime."
    ].join("\n"),
    {
      name: z.string().min(1).describe("List name"),
      folder_id: z.string().optional().describe("Create the list in this folder"),
      space_id: z.string().optional().describe("Create a folderless list in this space"),
      content: z.string().optional().describe("List description (markdown)"),
      status: z.string().optional().describe("List color status (the list's own status label)"),
      priority: z.number().int().min(1).max(4).optional().describe("Priority: 1 urgent, 2 high, 3 normal, 4 low"),
      assignee: z.string().optional().describe("List owner: user id, username or email"),
      due_date: z.string().optional().describe("Due date, ISO 8601 (2025-01-31 or 2025-01-31T09:00:00Z)")
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async ({ name, folder_id, space_id, content, status, priority, assignee, due_date }) => {
      try {
        if (!!folder_id === !!space_id) {
          throw new Error("Pass exactly one of folder_id or space_id.");
        }
        const url = folder_id
          ? `${API}/folder/${assertSafeId(folder_id, "folder_id")}/list`
          : `${API}/space/${assertSafeId(space_id as string, "space_id")}/list`;

        const body: Record<string, unknown> = { name };
        if (content !== undefined) body.markdown_content = content;
        if (status !== undefined) body.status = status;
        if (priority !== undefined) body.priority = priority;
        if (assignee !== undefined) body.assignee = Number(await resolveAssignee(assignee));
        if (due_date !== undefined) body.due_date = parseDateFilter("due_date", due_date);

        const list = await sendJson(url, "POST", body, "creating list");
        const lines = [
          `Created list: ${list.name ?? name} (list_id: ${list.id})`,
          `list_url: ${generateListUrl(String(list.id))}`,
        ];
        if (list.folder?.id && !list.folder.hidden) {
          lines.push(`folder: ${list.folder.name ?? "Unknown"} (folder_id: ${list.folder.id})`);
        }
        if (list.space?.id) {
          lines.push(`space: ${list.space.name ?? "Unknown"} (space_id: ${list.space.id})`);
        }
        if (Array.isArray(list.statuses) && list.statuses.length > 0) {
          lines.push(`Statuses: ${list.statuses.map((s: any) => s.status).join(", ")}`);
        }
        return textResult(lines.join("\n"));
      } catch (error) {
        console.error("Error creating list:", error);
        return textResult(`Error creating list: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );
}
