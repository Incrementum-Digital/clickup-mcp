import { clickupFetch } from "../shared/clickup-fetch";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {z} from "zod";
import {CONFIG} from "../shared/config";
import {
  isTaskId,
  getTaskSearchIndex,
  performMultiTermSearch,
  parseDateFilter,
  TASK_MAX_PAGES,
  TASK_PAGE_SIZE,
  type TaskFilters,
} from "../shared/utils";
import {generateTaskMetadata, type SpaceLookupBudget} from "./task-tools";

const DEFAULT_SEARCH_RESULTS = 50;
const MAX_SEARCH_RESULTS = 200;
/** Distinct spaces looked up one by one (GET /space/{id}) per search when the space list lacks them. */
const MAX_SPACE_LOOKUPS_PER_SEARCH = 10;

const FILTER_NAMES = [
  "list_ids", "space_ids", "folder_ids", "assignees", "assigned_to_me", "tags", "status", "only_todo",
  "due_date_from/to", "created_from/to", "updated_from/to", "done_from/to", "custom_fields", "parent_task_id",
].join(", ");

function textResult(text: string, isError = false) {
  return {content: [{type: "text" as const, text}], ...(isError ? {isError: true} : {})};
}

export function registerSearchTools(server: McpServer, userData: any) {
  // Dynamically construct the searchTasks description
  const searchTasksDescriptionBase = [
    "Searches tasks (sometimes called Tickets or Cards) across the whole workspace. Combine structured filters (assignees, tags, dates, custom fields, lists, spaces, folders, status, closed state) with optional fuzzy text matching on name, content, tags, assignees and ID (multiple search terms, OR logic).",
    "Structured filters are applied by ClickUp itself, so they find tasks regardless of how recently they were updated. Text terms are only matched against the tasks that pass the filters. When any of the structured filters (assignees, tags, folder_ids, dates, custom_fields, parent_task_id, include_closed, include_subtasks, order_by) is used, at most " + TASK_MAX_PAGES + " pages of " + TASK_PAGE_SIZE + " tasks are fetched per call - the response says when that cap was hit, in which case narrow the filters.",
    "Provide search terms and/or at least one filter (list_ids, space_ids, folder_ids, assignees, assigned_to_me, tags, status, only_todo, a date range, custom_fields, parent_task_id). Use assigned_to_me to find the current user's tasks; assignees takes ClickUp user ids (use getMembers, if available, to look them up).",
    "Closed tasks and subtasks are excluded unless include_closed / include_subtasks is set. Without order_by results are ordered by last update.",
  ];

  if (CONFIG.primaryLanguageHint && CONFIG.primaryLanguageHint.toLowerCase() !== 'en') {
    searchTasksDescriptionBase.push(`For optimal results, as your ClickUp tasks may be primarily in '${CONFIG.primaryLanguageHint}', consider providing search terms in English and '${CONFIG.primaryLanguageHint}'.`);
  }

  searchTasksDescriptionBase.push("Always reference tasks by their URLs when discussing search results or suggesting actions.");
  searchTasksDescriptionBase.push("You'll get a rough overview of the tasks that match the search terms, sorted by relevance.");
  searchTasksDescriptionBase.push("Always use getTaskById to get more specific information if a task is relevant, and always share the task URL.");

  server.tool(
    "searchTasks",
    searchTasksDescriptionBase.join("\n"),
    {
      terms: z
        .array(z.string())
        .optional()
        .describe(
          "Array of search terms (OR logic). Can include task IDs. Optional - if not provided, returns most recent tasks."
        ),
      list_ids: z
        .array(z.string())
        .optional()
        .describe("Filter tasks to specific list IDs"),
      space_ids: z
        .array(z.string())
        .optional()
        .describe("Filter tasks to specific space IDs"),
      only_todo: z
        .boolean()
        .optional()
        .describe("Filter for open/todo tasks only (exclude done and closed tasks)"),
      status: z
        .array(z.string())
        .optional()
        .describe("Filter for tasks with specific status names (overrides only_todo if provided)"),
      assigned_to_me: z
        .boolean()
        .optional()
        .describe(`Filter for tasks assigned to the current user (${userData.user.username} (${userData.user.id})). Combined with assignees if both are given.`),
      assignees: z
        .array(z.string())
        .optional()
        .describe("Filter for tasks assigned to any of these ClickUp user ids (numeric ids, not names). Use getMembers, if available, to look up ids."),
      tags: z
        .array(z.string())
        .optional()
        .describe("Filter for tasks that have these tags (tag names)"),
      folder_ids: z
        .array(z.string())
        .optional()
        .describe("Filter tasks to specific folder IDs"),
      include_closed: z
        .boolean()
        .optional()
        .describe("Include tasks in a closed status. Default false, except it defaults to true when status, done_from or done_to is given."),
      include_subtasks: z
        .boolean()
        .optional()
        .describe("Include subtasks in the results (default false)"),
      due_date_from: z.string().optional().describe("Only tasks due after this ISO 8601 date or datetime (e.g. 2025-01-31 or 2025-01-31T09:00:00Z). Date-only and offset-less values are UTC."),
      due_date_to: z.string().optional().describe("Only tasks due before this ISO 8601 date or datetime. A date-only value means the end of that day (UTC)."),
      created_from: z.string().optional().describe("Only tasks created after this ISO 8601 date or datetime"),
      created_to: z.string().optional().describe("Only tasks created before this ISO 8601 date or datetime (date-only = end of that day, UTC)"),
      updated_from: z.string().optional().describe("Only tasks updated after this ISO 8601 date or datetime"),
      updated_to: z.string().optional().describe("Only tasks updated before this ISO 8601 date or datetime (date-only = end of that day, UTC)"),
      done_from: z.string().optional().describe("Only tasks completed after this ISO 8601 date or datetime"),
      done_to: z.string().optional().describe("Only tasks completed before this ISO 8601 date or datetime (date-only = end of that day, UTC)"),
      custom_fields: z
        .array(
          z.object({
            field_id: z.string().describe("Custom field id (UUID)"),
            operator: z.string().describe("One of: =, !=, <, <=, >, >=, IS NULL, IS NOT NULL, RANGE, ANY, ALL, NOT ANY, NOT ALL"),
            value: z.unknown().optional().describe("Value to compare with. Omit for IS NULL / IS NOT NULL. ANY/ALL/NOT ANY/NOT ALL take an array (e.g. of dropdown option ids or label ids), RANGE takes [min, max]."),
          })
        )
        .optional()
        .describe("Filter by custom field values; all conditions must match. Example: [{\"field_id\":\"abc\",\"operator\":\"=\",\"value\":\"high\"}]"),
      parent_task_id: z
        .string()
        .optional()
        .describe("Return only the subtasks of this task id"),
      order_by: z
        .enum(["created", "updated", "due_date", "id"])
        .optional()
        .describe("Field ClickUp orders the results by (default updated). Ignored for ranking when search terms are given - those are sorted by relevance."),
      descending: z
        .boolean()
        .optional()
        .describe("Set true to reverse ClickUp's default sort direction for order_by, false to keep it. Only affects results ordering, not which tasks match."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_SEARCH_RESULTS)
        .optional()
        .describe(`Maximum number of tasks to return (default ${DEFAULT_SEARCH_RESULTS}, max ${MAX_SEARCH_RESULTS})`),
    },
    {
      readOnlyHint: true
    },
    async (args) => {
      const {
        list_ids, space_ids, folder_ids, only_todo, status, assigned_to_me, tags, include_closed, include_subtasks,
        custom_fields, parent_task_id, order_by, descending,
      } = args;
      const searchTerms = (args.terms ?? []).map(t => t.trim()).filter(t => t.length > 0);
      const limit = args.limit ?? DEFAULT_SEARCH_RESULTS;

      // assigned_to_me adds the current user to the explicit assignees
      const assignees = Array.from(new Set([
        ...(args.assignees ?? []),
        ...(assigned_to_me ? [String(userData.user.id)] : []),
      ]));

      // Convert the ISO date filters to Unix ms
      const filters: TaskFilters = {};
      try {
        const dateParams: Array<[keyof TaskFilters, keyof TaskFilters, string | undefined, string | undefined, string]> = [
          ["due_date_gt", "due_date_lt", args.due_date_from, args.due_date_to, "due_date"],
          ["date_created_gt", "date_created_lt", args.created_from, args.created_to, "created"],
          ["date_updated_gt", "date_updated_lt", args.updated_from, args.updated_to, "updated"],
          ["date_done_gt", "date_done_lt", args.done_from, args.done_to, "done"],
        ];
        for (const [gtKey, ltKey, from, to, label] of dateParams) {
          if (from) (filters as any)[gtKey] = parseDateFilter(`${label}_from`, from, false);
          if (to) (filters as any)[ltKey] = parseDateFilter(`${label}_to`, to, true);
        }
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error), true);
      }

      const hasDateFilter = Object.keys(filters).length > 0;
      const statusFilter = (status ?? []).filter(s => s.trim().length > 0);
      // Filters that scope which tasks may match (status/only_todo are checked on every result anyway)
      const hasScopingFilter =
        hasDateFilter ||
        assignees.length > 0 ||
        !!list_ids?.length || !!space_ids?.length || !!folder_ids?.length || !!tags?.length ||
        !!custom_fields?.length || !!parent_task_id;
      const hasStructuralFilter = hasScopingFilter || statusFilter.length > 0 || !!only_todo;

      if (searchTerms.length === 0 && !hasStructuralFilter) {
        return textResult(
          `Provide search terms and/or at least one filter. Available filters: ${FILTER_NAMES}.`,
          true
        );
      }

      // Only the filters that existed before the structured-search extension (list_ids, space_ids,
      // assigned_to_me, status, only_todo) -> keep the original deep fetch (up to 30 pages in
      // parallel) so pure text searches still cover thousands of recently updated tasks.
      const usesNewFilters =
        hasDateFilter ||
        !!args.assignees?.length || !!tags?.length || !!folder_ids?.length ||
        !!custom_fields?.length || !!parent_task_id ||
        include_closed !== undefined || include_subtasks !== undefined ||
        order_by !== undefined || descending !== undefined;

      Object.assign(filters, usesNewFilters
        ? {
          space_ids,
          list_ids,
          folder_ids,
          assignees,
          tags,
          statuses: statusFilter.length ? statusFilter.map(s => s.toLowerCase()) : undefined,
          // Asking for a status or completion date implies closed tasks may be wanted
          include_closed: include_closed ?? (statusFilter.length > 0 || filters.date_done_gt !== undefined || filters.date_done_lt !== undefined),
          include_subtasks,
          custom_fields,
          parent: parent_task_id,
          order_by,
          reverse: descending,
        }
        // Legacy path: status/only_todo are applied client-side, subtasks are always included
        : {space_ids, list_ids, assignees});

      let searchResult;
      try {
        searchResult = await getTaskSearchIndex(filters, usesNewFilters ? "filtered" : "legacy");
      } catch (error) {
        console.error("searchTasks failed to fetch tasks:", error);
        return textResult(`Failed to fetch tasks from ClickUp: ${error instanceof Error ? error.message : String(error)}`, true);
      }

      // Summary lines so the model knows what was applied
      const applied: string[] = [];
      const addApplied = (label: string, value: unknown) => {
        if (Array.isArray(value) ? value.length > 0 : value !== undefined && value !== false) {
          applied.push(`${label}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
        }
      };
      const isoOrNone = (ms?: number) => (ms === undefined ? undefined : new Date(ms).toISOString());
      addApplied("list_ids", list_ids);
      addApplied("space_ids", space_ids);
      addApplied("folder_ids", folder_ids);
      addApplied("assignees (user ids)", assignees);
      addApplied("tags", tags);
      addApplied("status", statusFilter);
      addApplied("only_todo", only_todo);
      addApplied("include_closed", filters.include_closed);
      addApplied("include_subtasks", usesNewFilters ? include_subtasks : true);
      for (const [label, gt, lt] of [
        ["due_date", filters.due_date_gt, filters.due_date_lt],
        ["created", filters.date_created_gt, filters.date_created_lt],
        ["updated", filters.date_updated_gt, filters.date_updated_lt],
        ["done", filters.date_done_gt, filters.date_done_lt],
      ] as const) {
        if (gt !== undefined || lt !== undefined) {
          applied.push(`${label}: ${isoOrNone(gt) ?? "any"} to ${isoOrNone(lt) ?? "any"}`);
        }
      }
      addApplied("custom_fields", custom_fields?.length ? JSON.stringify(custom_fields) : undefined);
      addApplied("parent_task_id", parent_task_id);
      addApplied("order_by", order_by);
      addApplied("descending", descending);

      const summaryLines = [
        `Filters applied: ${applied.length ? applied.join("; ") : "none"}.`,
        `Search terms: ${searchTerms.length ? searchTerms.join(", ") : "none"}.`,
        `Fetched ${searchResult.tasks.length} task(s) from ${searchResult.pagesFetched} page(s) of ClickUp results.`,
      ];
      if (searchResult.pageCapReached) {
        summaryLines.push(
          `Page cap reached: only the first ${TASK_MAX_PAGES * TASK_PAGE_SIZE} matching tasks were fetched, so the results may be incomplete` +
          `${searchTerms.length ? " and the search terms were only matched against those tasks" : ""}. ` +
          `Narrow the search (more filters, a tighter date range, specific list_ids) to see the rest.`
        );
      }
      if (searchResult.warning) {
        summaryLines.push(searchResult.warning);
      }

      // Resolving space names is capped per search so a big result set cannot burn the rate limit
      const spaceLookups: SpaceLookupBudget = {max: MAX_SPACE_LOOKUPS_PER_SEARCH, attempted: new Set()};

      const finish = async (resultTasks: any[], totalMatches: number, emptyMessage: string) => {
        if (resultTasks.length === 0) {
          return textResult([emptyMessage, ...summaryLines].join("\n"));
        }
        const shown = Math.min(resultTasks.length, limit);
        const lines = [...summaryLines];
        lines.push(totalMatches > shown ? `Showing ${shown} of ${totalMatches} matching tasks (limit ${limit}).` : `Showing ${shown} task(s).`);
        return {
          content: [
            {type: "text" as const, text: lines.join("\n")},
            ...await Promise.all(resultTasks.slice(0, limit).map((task: any) => generateTaskMetadata(task, undefined, false, spaceLookups))),
          ],
        };
      };

      const applyStatusFilter = (tasks: any[]) => {
        if (statusFilter.length > 0) {
          const statusLower = statusFilter.map(s => s.toLowerCase());
          return tasks.filter((task: any) => statusLower.includes(task.status.status.toLowerCase()));
        }
        if (only_todo) {
          return tasks.filter((task: any) => task.status.type !== "done" && task.status.type !== "closed");
        }
        return tasks;
      };

      // No search terms: return the filtered tasks in the order ClickUp returned them
      if (searchTerms.length === 0) {
        let resultTasks = applyStatusFilter(searchResult.tasks);
        if (!usesNewFilters) {
          // Legacy behaviour: most recently updated first
          resultTasks = [...resultTasks].sort((a: any, b: any) => parseInt(b.date_updated || "0") - parseInt(a.date_updated || "0"));
        }
        return finish(resultTasks, resultTasks.length, "No tasks found.");
      }

      // Create a results map to track unique tasks with scores
      const uniqueResults = new Map<string, { item: any, score: number }>();

      // Perform multi-term search with aggressive boosting
      const searchResults = await performMultiTermSearch(searchResult.index, searchTerms);
      searchResults.forEach(task => {
        uniqueResults.set(task.id, { item: task, score: 0.1 }); // Give search results a good score
      });

      // Task ID Fallback Logic
      // A directly fetched task is not checked against the structural filters, so only do this
      // when the search is not scoped by them (status/only_todo are re-applied below).
      // Legacy path: closed tasks were never excluded for direct lookups and subtasks were always included
      const includeClosedEffective = usesNewFilters ? !!filters.include_closed : true;
      const includeSubtasksEffective = usesNewFilters ? !!include_subtasks : true;
      const potentialTaskIds = hasScopingFilter ? [] : searchTerms.filter(isTaskId);
      const foundTaskIdsByFuse = new Set(Array.from(uniqueResults.keys()).map(id => id.toLowerCase()));

      const taskIdsToFetchDirectly = potentialTaskIds.filter(id => {
        const lowerId = id.toLowerCase();
        return !foundTaskIdsByFuse.has(lowerId);
      });

      if (taskIdsToFetchDirectly.length > 0) {
        console.error(`Attempting direct fetch for task IDs: ${taskIdsToFetchDirectly.join(', ')}`);
        const directFetchPromises = taskIdsToFetchDirectly.map(async (id) => {
          try {
            const response = await clickupFetch(
              `https://api.clickup.com/api/v2/task/${id}`,
              {headers: {Authorization: CONFIG.authHeader}}
            );
            if (response.ok) {
              const task = await response.json();
              // Honour the closed/subtask exclusions for tasks that bypassed the filtered fetch
              const excludedAsClosed = !includeClosedEffective && task?.status?.type === "closed";
              const excludedAsSubtask = !includeSubtasksEffective && !!task?.parent;
              if (task && typeof task.id === 'string' && !excludedAsClosed && !excludedAsSubtask) {
                const existing = uniqueResults.get(task.id);
                if (!existing || 0 < existing.score) {
                  uniqueResults.set(task.id, {item: task, score: 0});
                }
              }
              return task;
            }
            return null;
          } catch (error) {
            console.error(`Error directly fetching task ${id}:`, error);
            return null;
          }
        });
        await Promise.all(directFetchPromises);
      }

      const rankedTasks = Array.from(uniqueResults.values())
        .sort((a, b) => a.score - b.score)
        .map(entry => entry.item);

      const resultTasks = applyStatusFilter(rankedTasks);
      return finish(resultTasks, resultTasks.length, "No tasks found matching the search criteria.");
    }
  );
}
