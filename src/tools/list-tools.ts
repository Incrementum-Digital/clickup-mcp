import { clickupFetch } from "../shared/clickup-fetch";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CONFIG } from "../shared/config";
import { assertSafeId } from "../shared/ids";
import { generateListUrl, generateSpaceUrl } from "../shared/utils";

export function registerListToolsRead(server: McpServer) {
  server.tool(
    "getListInfo",
    [
      "Gets comprehensive information about a list including description and available statuses.",
      "ALWAYS use the list URL (https://app.clickup.com/v/l/LIST_ID) when referencing lists.",
      "Use this before creating tasks to understand the list context and available statuses for new tasks.",
      "IMPORTANT: The list description often contains valuable project context, requirements, or guidelines - read and consider this information when creating or updating tasks in this list.",
      "Share the clickable list URL when suggesting list-related actions."
    ].join("\n"),
    {
      list_id: z.string().min(1).describe("The list ID to get information for")
    },
    {
      readOnlyHint: true
    },
    async ({ list_id }) => {
      try {
        // Get list details including statuses (try to get markdown content)
        const listResponse = await clickupFetch(`https://api.clickup.com/api/v2/list/${list_id}?include_markdown_description=true`, {
          headers: { Authorization: CONFIG.authHeader },
        });

        if (!listResponse.ok) {
          throw new Error(`Error fetching list details: ${listResponse.status} ${listResponse.statusText}`);
        }

        const listData = await listResponse.json();

        // Fetch space tags in parallel (don't let this fail the main request)
        let spaceTags: any[] = [];
        if (listData.space?.id) {
          try {
            const spaceTagsResponse = await clickupFetch(`https://api.clickup.com/api/v2/space/${listData.space.id}/tag`, {
              headers: { Authorization: CONFIG.authHeader },
            });
            if (spaceTagsResponse.ok) {
              const spaceTagsData = await spaceTagsResponse.json();
              spaceTags = spaceTagsData.tags || [];
            }
          } catch (error) {
            console.error(`Error fetching space tags for space ${listData.space.id}:`, error);
          }
        }

        const responseLines = [
          `List Information:`,
          `list_id: ${list_id}`,
          `list_url: ${generateListUrl(list_id)}`,
          `name: ${listData.name}`,
          `folder: ${listData.folder?.name || 'No folder'}`,
          `space: ${listData.space?.name || 'Unknown'} (${listData.space?.id || 'N/A'})`,
          `space_url: ${generateSpaceUrl(listData.space?.id || '')}`,
          `archived: ${listData.archived || false}`,
          `task_count: ${listData.task_count || 0}`,
        ];

        // Add description if available (check both content and markdown fields)
        const description = listData.markdown_description || listData.markdown_content || listData.content;
        if (description) {
          responseLines.push(`description: ${description}`);
        }

        // Add available statuses
        if (listData.statuses && Array.isArray(listData.statuses)) {
          const statuses = listData.statuses.map((status: any) => ({
            name: status.status,
            color: status.color || 'none',
            type: status.type || 'custom'
          }));

          responseLines.push(`Available statuses (${statuses.length} total):`);

          statuses.forEach((status: any) => {
            responseLines.push(`  - ${status.name} (${status.type})`);
          });

          responseLines.push(`Valid status names for createTask/updateTask: ${statuses.map((s: any) => s.name).join(', ')}`);
        } else {
          responseLines.push('No statuses found for this list.');
        }

        // Add space tags information
        if (spaceTags.length > 0) {
          const tagNames = spaceTags.map((tag: any) => tag.name).filter(Boolean).sort();
          if (tagNames.length > 0) {
            responseLines.push(`Available tags in space (shared across all lists): ${tagNames.join(', ')}`);
          }
        } else if (listData.space?.id) {
          responseLines.push('No tags found in this space.');
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
        console.error('Error getting list info:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error getting list info: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
      }
    }
  );
}

export function registerListToolsWrite(server: McpServer) {
  server.tool(
    "updateListInfo",
    [
      "Renames a list and/or updates its description.",
      "ALWAYS reference the list URL (https://app.clickup.com/v/l/LIST_ID) when updating or discussing lists.",
      "append_description (default, safe): APPENDS markdown to the existing description with a timestamp, preserving existing content.",
      "content: REPLACES the whole description. This is destructive - the previous description is lost. Read it with getListInfo first and include whatever must be kept. Mutually exclusive with append_description.",
      "name: renames the list (can be combined with either description option).",
      "Use the description to add project context, requirements, or guidelines that LLMs should consider when working with tasks in this list."
    ].join("\n"),
    {
      list_id: z.string().min(1).describe("The list ID to update"),
      name: z.string().min(1).optional().describe("New list name"),
      append_description: z.string().min(1).optional().describe("Markdown content to APPEND to existing list description (preserves existing content for safety)"),
      content: z.string().optional().describe("Markdown content that REPLACES the whole list description (destructive; call getListInfo first). Cannot be combined with append_description. Empty string clears the description.")
    },
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    },
    async ({ list_id, name, append_description, content }) => {
      try {
        const id = assertSafeId(list_id, "list_id");
        if (append_description !== undefined && content !== undefined) {
          throw new Error("Pass either append_description or content, not both.");
        }
        if (append_description === undefined && content === undefined && name === undefined) {
          throw new Error("Nothing to update. Pass name, append_description or content.");
        }

        const body: Record<string, unknown> = {};
        const done: string[] = [];
        let listName: string | undefined = name;
        let timestamp = "";

        if (name !== undefined) {
          body.name = name;
          done.push(`renamed to "${name}"`);
        }

        if (append_description !== undefined) {
          // Get current list info including description (try to get markdown content)
          const listResponse = await clickupFetch(`https://api.clickup.com/api/v2/list/${id}?include_markdown_description=true`, {
            headers: { Authorization: CONFIG.authHeader },
          });

          if (!listResponse.ok) {
            throw new Error(`Error fetching list: ${listResponse.status} ${listResponse.statusText}`);
          }

          const listData = await listResponse.json();
          listName = listName ?? listData.name;

          const currentDescription = listData.markdown_description || listData.markdown_content || listData.content || "";
          timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
          const separator = currentDescription.trim() ? "\n\n---\n" : "";
          body.markdown_content = currentDescription + separator + `**Edit (${timestamp}):** ${append_description}`;
          done.push(`appended content with timestamp (${timestamp}) while preserving the existing description`);
        } else if (content !== undefined) {
          body.markdown_content = content;
          done.push("replaced the whole description");
        }

        const updateResponse = await clickupFetch(`https://api.clickup.com/api/v2/list/${id}`, {
          method: 'PUT',
          headers: {
            Authorization: CONFIG.authHeader,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        });

        if (!updateResponse.ok) {
          const errorData = await updateResponse.json().catch(() => ({}));
          throw new Error(`Error updating list: ${updateResponse.status} ${updateResponse.statusText} - ${JSON.stringify(errorData)}`);
        }

        const label = listName ? `"${listName}" ` : "";
        const prefix = append_description !== undefined && name === undefined
          ? `Successfully appended content to list ${label}(list_id: ${id}). The new content has been added with timestamp (${timestamp}) while preserving existing description.`
          : `Successfully updated list ${label}(list_id: ${id}): ${done.join("; ")}.`;

        return {
          content: [
            {
              type: "text",
              text: `${prefix}\nlist_url: ${generateListUrl(id)}`,
            },
          ],
        };

      } catch (error) {
        console.error('Error updating list info:', error);
        return {
          content: [
            {
              type: "text",
              text: `Error updating list info: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
