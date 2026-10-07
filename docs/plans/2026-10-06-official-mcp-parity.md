# Plan: bring this server as close as possible to the official ClickUp MCP

Status: approved 2026-10-06 (superset is fine; every official feature with a public API gets a counterpart, chat excluded). Phase 1 shipped in 7c311b9. Phase 2 built 2026-10-06 (33 tools), pending deploy. Base: commit 1441324 (hosted mode live on Railway).

## Goal

Make this server a drop-in backup for the official ClickUp MCP for an Incrementum user: every
day-to-day operation the official connector offers should have a counterpart here, with the
same or better single-call context, within the 100 requests/minute per-token budget.

## What cannot be mirrored (public API limits)

| Official tool | Why not | Closest we can do |
|---|---|---|
| `clickup_search` (workspace full-text search) | No public text-search endpoint. `GET /team/{id}/task` only filters by structure, people, dates, tags, custom fields. | Structured filters via the API plus server-side text match over the filtered pages (Phase 1). Keep the local fuzzy index for "find by meaning" on recent tasks. |
| `clickup_create_reminder`, `update_reminder`, `search_reminders` | Reminders have no public API. | Not planned. |
| `clickup_get_operators`, `execute_operator`, `get_schema` | Internal "Unified API" catalog, not a ClickUp feature. | Not applicable; our tools are the catalog. |
| `clickup_get_schema` | Same. | Not applicable. |

Everything else maps onto a documented v2 or v3 endpoint.

## Coverage map (official tool, our tool, action)

Legend: **have** = equivalent exists today, **extend** = add parameters to an existing tool,
**new** = new tool, **skip** = not planned.

### Tasks
| Official | Ours | Action |
|---|---|---|
| get_task | getTaskById | have (richer: comments, replies, images, status history, dependencies) |
| create_task | createTask | extend: `custom_fields`, `watchers`, `notify_all`, `markdown_description` already used |
| update_task | updateTask | extend: `custom_fields`, `watchers`, `archived`, `points`; assignees add/remove semantics documented |
| delete_task | - | new `deleteTask` (`DELETE /task/{id}`), write mode only, requires `confirm: true` |
| move_task | - | new `moveTask`: `POST /list/{list_id}/task/{task_id}` then `DELETE /list/{old_list_id}/task/{task_id}` (Tasks in Multiple Lists ClickApp). If the ClickApp is off, report the error from ClickUp verbatim. |
| merge_tasks | - | new `mergeTasks` (`POST /task/{target}/merge`, body `source_task_ids`), `confirm: true` |
| add_task_to_list / remove_task_from_list | - | new `addTaskToList` / `removeTaskFromList` (same endpoints as moveTask) |
| filter_tasks | searchTasks | extend (Phase 1): `assignees`, `due_date_from/to`, `date_updated_from/to`, `date_created_from/to`, `tags`, `include_closed`, `custom_fields`, `order_by`, `parent`; all passed to `GET /team/{id}/task`; `terms` then text-matches within the filtered result |
| search | searchTasks | partial (see "cannot mirror") |
| add_task_dependency / remove_task_dependency | updateTask `waiting_on`/`blocking` | have; fix the known read bug so removals work (dependencies come from `task.dependencies`, not `task.waiting_on`) |
| add_task_link / remove_task_link | updateTask `linked_tasks` | have |
| add_tag_to_task / remove_tag_from_task | updateTask `tags` (replace) | extend: `add_tags` / `remove_tags` on updateTask using `POST/DELETE /task/{id}/tag/{name}` so one tag can change without resending all |
| get_task_time_in_status | getTaskById status history | extend getTaskById with a per-status duration summary from `GET /task/{id}/time_in_status` (one extra call, only when `include_time_in_status: true`) |
| get_bulk_tasks_time_in_status | - | new `getTimeInStatus(task_ids[])` (`GET /task/bulk_time_in_status/task_ids`, max 100 ids) |
| attach_task_file / request_attachment_upload | markdown images in addComment/updateTask | new `attachFile(task_id, source)` for any file type: local path (stdio only), URL (SSRF-guarded in hosted mode) or data URI; reuses `src/shared/attachments.ts` upload |
| download_task_attachment | images inlined by getTaskById | new `getAttachment(task_id, attachment_id)` returning image content or text for text-like files, otherwise the URL and size; SSRF guard applies |

### Comments
| Official | Ours | Action |
|---|---|---|
| create_task_comment / create_comment | addComment | have |
| get_task_comments / get_threaded_comments | getTaskById | have (inline); add `getComments(task_id, parent_comment_id?)` only if a caller needs comments without the task body (optional, Phase 3) |
| update_comment | editComment | have (own comments, time window) |
| delete_comment | - | new `deleteComment` (`DELETE /comment/{id}`), own comments only, same window as editComment |

### Hierarchy and lists
| Official | Ours | Action |
|---|---|---|
| get_workspace_hierarchy | searchSpaces | have (tree per matched space); add `terms` optional so an empty call returns all spaces with lists and folders |
| get_folder / get_list | getListInfo | extend: new `getFolder(folder_id)`; getListInfo already returns statuses and tags, add custom field definitions |
| create_folder / update_folder | - | new `createFolder(space_id, name)`, `updateFolder(folder_id, name)` |
| create_list / create_list_in_folder / update_list | updateListInfo (append only) | new `createList(space_id or folder_id, name, content?, status?, priority?, assignee?, due_date?)`, extend `updateListInfo` to set `name` and replace `content` (keep append as default) |
| get_custom_fields | - | new `getCustomFields(list_id or folder_id or space_id)` (`GET /list/{id}/field`, `/folder/{id}/field`, `/space/{id}/field`, `/team/{id}/field`), rendering id, name, type and option ids |

### Members
| Official | Ours | Action |
|---|---|---|
| get_workspace_members | - | new `getMembers(list_id?)` from `GET /team` (members with id, username, email, role) or `GET /list/{id}/member` |
| find_member_by_name / resolve_assignees | assignees by id | extend createTask/updateTask/createTimeEntry: accept usernames or emails and resolve against the cached member list (`getAllTeamMembers` already caches the team) with an exact-then-fuzzy match and an explicit error on ambiguity |

### Time tracking
| Official | Ours | Action |
|---|---|---|
| add_time_entry / get_time_entries | createTimeEntry / getTimeEntries | have |
| start_time_tracking / stop_time_tracking / get_current_time_entry | - | new `startTimer(task_id?, description?, billable?)` (`POST /team/{id}/time_entries/start`), `stopTimer()` (`POST .../stop`), `getRunningTimer()` (`GET .../current`) |

### Documents
| Official | Ours | Action |
|---|---|---|
| create_document / create_document_page / update_document_page | createDocumentOrPage / updateDocumentPage | have |
| get_document_pages / list_document_pages | readDocument | have |
| list_document_page_attachments / download_document_page_attachment | - | skip for now (doc attachments are rare for us; revisit if asked) |
| (doc search) | searchSpaces lists docs per space | extend: `searchDocuments(terms, space_id?)` over `GET /v3/workspaces/{id}/docs` with local fuzzy match, and fix the README which already advertises this tool |

### Chat
| Official | Ours | Action |
|---|---|---|
| get_chat_channels / get_chat_channel_messages / get_chat_message_replies / send_chat_message | - | skip (team does not use ClickUp Chat). Previously planned as Phase 3: `getChatChannels`, `getChatMessages(channel_id, limit)`, `sendChatMessage(channel_id, text, reply_to?)` on the public v3 chat endpoints. Verify each endpoint in the reference before briefing; the reference only showed channel listing clearly. |

## Phases

### Phase 1: the backup becomes usable for daily work (highest value, lowest risk)
1. `searchTasks` structured filters (assignees, due/created/updated ranges, tags, include_closed, custom_fields, order_by, parent) mapped to `GET /team/{id}/task`, with `terms` applied as text match over the filtered pages. Page cap stays at 5 pages per call to protect the rate budget.
2. `getMembers` and username/email resolution for assignees across createTask, updateTask, createTimeEntry.
3. `getCustomFields` plus `custom_fields` on createTask and updateTask (`POST /task/{id}/field/{field_id}` per field; value shapes per type: dropdown by option id or option name resolved from getCustomFields, labels array, date ms, users add/rem, number, text, checkbox, url, email, phone, currency).
4. `deleteTask` and `moveTask` (with `addTaskToList` / `removeTaskFromList`), `confirm: true` required on delete.
5. `startTimer`, `stopTimer`, `getRunningTimer`.
6. `add_tags` / `remove_tags` on updateTask.
7. Fix dependency removal in updateTask (read from `task.dependencies`).

### Phase 2: structure and files
1. `createFolder`, `updateFolder`, `createList`, `updateListInfo` name/content.
2. `getFolder`; `searchSpaces` returns the whole hierarchy when called without terms.
3. `attachFile`, `getAttachment` (SSRF guard and size limits in hosted mode).
4. `deleteComment`, `mergeTasks`, `getTimeInStatus`, `include_time_in_status` on getTaskById.
5. `searchDocuments` and the README correction.

### Phase 3: optional leftovers
1. Chat tools: dropped on 2026-10-06, the team does not use ClickUp Chat.
2. `getComments` standalone, if a caller needs it.
3. Doc page attachments, if asked.

## Cross-cutting rules for every tool

- Mode gating: destructive and write tools register only in `write` mode; read tools in `read` and `write`; `read-minimal` stays getTaskById + searchTasks.
- Output: always include ids next to names (`Name (list_id: 123)`), per CLAUDE.md.
- Rate budget: no tool may issue more than ~20 requests per call; batch endpoints (bulk time in status, filtered team tasks with `list_ids[]`) are preferred over per-item loops; caches stay promise-based with the 60 s auto-clear and per-user scoping.
- Hosted mode: every URL fetch goes through `fetchPublicBytes`; local paths are refused when a request context is active.
- Confirmation: `deleteTask`, `mergeTasks` and `removeTaskFromList` require `confirm: true` and refuse otherwise with a message explaining what would happen.
- Each tool: zod schema with descriptions, a test with undici MockAgent, an entry in `manifest.json` tools, README mode table and CHANGELOG line.

## Sequencing and workers

- Phase 1 items 1 to 3 touch `searchTasks`, assignee handling and custom fields: `sonnet-worker-deep`, one brief each, in parallel (disjoint files: search-tools.ts; a new members module plus the assignee call sites; a new custom-fields module plus createTask/updateTask).
- Phase 1 items 4 to 7: `sonnet-worker` (pattern work following existing tools), one brief for the task write tools, one for timers.
- Phase 2: `sonnet-worker` per group.
- Review: Phase 1 as one cross-family panel pass (data-mutating tools), Phase 2 one `/codex:review` pass.
- Deploy: Railway auto-deploys from `main`; each phase ships after the suite passes and a live `tools/list` shows the new tools.

## Acceptance for "as close as possible"

- Every official tool except search, reminders, chat and the operator catalog has a mapped counterpart in this table marked have, extend or new, and all extend/new items in Phases 1 and 2 are implemented.
- `npm test` passes; `npm run smoke` lists the new tools over stdio; the hosted `tools/list` shows them for an authorized user.
- The README comparison table is updated to state exactly which three capabilities remain official-only.

## Risks

- Tasks in Multiple Lists ClickApp may be off for a space, making `moveTask` fail; the tool must surface ClickUp's error and suggest enabling the ClickApp.
- Custom field value shapes vary by type; the implementation must read the field definition first and fail clearly on an unsupported type rather than sending a guess.
- Assignee name resolution can be ambiguous (two people with the same first name); fail with the candidate list rather than picking one.
- Rate budget: a wide `searchTasks` with `include_closed` across the whole workspace can page deep; keep the 5-page cap and tell the model to narrow by list or date.
