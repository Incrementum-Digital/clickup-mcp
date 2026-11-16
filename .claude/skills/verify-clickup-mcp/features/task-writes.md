# Tasks: writes

## Sub-features
- `createTask`, `updateTask` (status, priority, assignees, tags, dates, estimates, custom fields; descriptions are append-only with a timestamp).
- `addComment`, `editComment` (edit window `CLICKUP_COMMENT_EDIT_WINDOW_HOURS`), with `![](local/path.png)` uploads in stdio mode.
- `attachFile`, `getAttachment`.
- Admin: `moveTask`, `addTaskToList`, `removeTaskFromList`, `mergeTasks`, `deleteTask`, `deleteComment` (write mode only).

## How to get to it (user POV)
"Create a task for the dashboard bug in the frontend list", "add a comment with this screenshot", "move it to QA".

## Driving it with the CLI
Never by the verify drive. By hand, against a scratch task only: `npx ts-node src/cli.ts addComment task_id=<scratch> comment="smoke"`; `npm run smoke -- <scratch task id> ./image.png` posts a real comment with an image over stdio.

## Gotchas
- Descriptions are never overwritten, only appended; a wrong append stays in the task.
- `deleteTask` is permanent in ClickUp's trash sense; keep admin tools out of read modes (they are).
- Uploads are capped by `MAX_UPLOAD_SIZE_MB`; the hosted mode downloads public URLs through an SSRF-pinned transport, not local paths.
