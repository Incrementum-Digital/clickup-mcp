# Tasks: read and search

## Sub-features
- `getTaskById` (`task_id`, a ClickUp id like `abc123`, `CU-abc123` or a task URL): description, custom fields, status history, up to 250 top-level comments with replies, inline images within a size budget.
- `searchTasks`: structured filters (assignees, lists, statuses, tags, due/created/updated/done ranges, custom field `field_id`/`operator`/`value`) plus fuzzy search over recent tasks.
- `getTimeInStatus`: how long a task sat in each status.

## How to get to it (user POV)
"Look at CU-abc123", "what do I need to do today", "which tasks mention the CSV import". The assistant calls the tools; the person sees the task text, comments and images in the chat.

## Driving it with the CLI
With a token in `.env`: `just cli getTaskById task_id=<scratch task id>` or `just cli searchTasks assignees='["me"]'`. The verify drive does not call these by default (a task id is workspace-specific); `--live` proves the tool layer with `getMembers` and `searchSpaces` instead.

## Gotchas
- 100 API calls per minute per user; results are cached as promises for `GLOBAL_REFRESH_INTERVAL`.
- Images count against `MAX_IMAGES` and `MAX_RESPONSE_SIZE_MB`; a big task answers with fewer images, not an error.
- Multi-line values through `npm run cli` lose newlines (double shell split); call `npx ts-node src/cli.ts` directly.
