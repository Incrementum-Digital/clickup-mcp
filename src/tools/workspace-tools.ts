import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONFIG } from "../shared/config";
import { describeRole, formatMember, getWorkspaceMembers } from "../shared/members";
import { getCustomFieldDefinitions, optionName } from "../shared/custom-fields";

export function registerWorkspaceTools(server: McpServer) {
  server.tool(
    "getMembers",
    [
      "Lists the members of the workspace (or, with `list_id`, the members who have access to that list) with their user_id, email and role.",
      "Use it to find a user's ID. createTask and updateTask also accept usernames or emails as assignees and resolve them automatically, so this is mainly useful to browse who is available or to disambiguate similar names.",
    ].join("\n"),
    {
      list_id: z.string().min(1).optional().describe("Optional list ID: only list members who have access to this list"),
    },
    {
      readOnlyHint: true,
    },
    async ({ list_id }) => {
      try {
        let lines: string[];

        if (list_id) {
          const response = await fetch(`https://api.clickup.com/api/v2/list/${encodeURIComponent(list_id)}/member`, {
            headers: { Authorization: CONFIG.authHeader },
          });
          if (!response.ok) {
            throw new Error(`Error fetching list members: ${response.status} ${response.statusText}`);
          }
          const data = await response.json();
          const members: any[] = data.members || [];
          lines = members.map((m) =>
            [
              `- ${formatMember(m)}`,
              m.email ? ` ${m.email}` : "",
              typeof m.role === "number" ? ` role: ${describeRole(m.role)}` : "",
            ].join("")
          );
          lines.unshift(`${members.length} member(s) with access to list ${list_id}:`);
        } else {
          const members = await getWorkspaceMembers();
          lines = members.map((m) =>
            [`- ${formatMember(m)}`, m.email ? ` ${m.email}` : "", ` role: ${describeRole(m.role)}`].join("")
          );
          lines.unshift(`${members.length} member(s) in workspace ${CONFIG.teamId}:`);
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        console.error("Error fetching members:", error);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching members: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
        };
      }
    }
  );

  server.tool(
    "getCustomFields",
    [
      "Lists the custom field definitions available in a list, folder or space: name, field_id, type, whether it is required and, for dropdowns and labels, the valid options.",
      "Pass exactly one of `list_id`, `folder_id` or `space_id`. Use the list_id of the list a task lives in to see every field you can set on its tasks.",
      "createTask and updateTask take `custom_fields` keyed by field name or field_id; dropdown and label values can be given by option name.",
    ].join("\n"),
    {
      list_id: z.string().min(1).optional().describe("The list whose custom fields to show"),
      folder_id: z.string().min(1).optional().describe("The folder whose custom fields to show"),
      space_id: z.string().min(1).optional().describe("The space whose custom fields to show"),
    },
    {
      readOnlyHint: true,
    },
    async ({ list_id, folder_id, space_id }) => {
      try {
        const fields = await getCustomFieldDefinitions({ list_id, folder_id, space_id });
        if (fields.length === 0) {
          return { content: [{ type: "text" as const, text: "No custom fields found." }] };
        }

        const lines: string[] = [`${fields.length} custom field(s):`];
        for (const field of fields) {
          lines.push(`- ${field.name} (field_id: ${field.id}) type=${field.type} required=${Boolean(field.required)}`);
          for (const option of field.type_config?.options ?? []) {
            lines.push(`    - ${optionName(option)} (option_id: ${option.id})`);
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        console.error("Error fetching custom fields:", error);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching custom fields: ${error instanceof Error ? error.message : "Unknown error"}`,
            },
          ],
        };
      }
    }
  );
}
