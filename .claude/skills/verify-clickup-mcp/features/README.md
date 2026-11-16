refreshed: 2026-11-16

# clickup-mcp feature map

What an agent can do through this MCP server, grouped as the tools are in `src/tools/`. Each
file says how a person reaches the feature, which tools and journeys drive it, and what bites.

- [hosted-front-door.md](hosted-front-door.md): the Railway deployment, `/health`, OAuth 2.1 login, `/mcp` (journeys `health`, `metadata`, `guards`)
- [tasks.md](tasks.md): read a task with comments and images, search tasks, time in status (`getTaskById`, `searchTasks`, `getTimeInStatus`)
- [task-writes.md](task-writes.md): create and update tasks, comments, attachments, admin moves (`createTask`, `updateTask`, `addComment`, ...)
- [documents.md](documents.md): search, read, create and update ClickUp Docs (`searchDocuments`, `readDocument`, ...)
- [time-tracking.md](time-tracking.md): entries and timers (`getTimeEntries`, `getRunningTimer`, `createTimeEntry`, `startTimer`, `stopTimer`)
- [workspace.md](workspace.md): members, spaces, folders, lists, custom fields (`getMembers`, `searchSpaces`, `getFolder`, `getListInfo`, ...)

Modes: `CLICKUP_MCP_MODE=read-minimal | read | write` (default write) decides which tools are
registered; the verify drive uses `read-minimal`. Tool names come from `server.tool("<name>", ...)`
in each file under `src/tools/`; `npm run smoke` lists what a client sees.
