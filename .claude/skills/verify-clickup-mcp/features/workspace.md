# Workspace: members, spaces, lists, fields

## Sub-features
- `getMembers` (team members, cached per `GLOBAL_REFRESH_INTERVAL`), `getCustomFields`.
- `searchSpaces` (space index built at server start), `getFolder`, `getListInfo`; `createFolder`, `updateFolder`, `createList`, `updateListInfo` in write mode.

## How to get to it (user POV)
"Who is on the team", "which lists are in the Marketing space", "what custom fields does this list have".

## Driving it with the CLI
`drive.sh all --live` runs `getMembers` and `searchSpaces` in `read-minimal` mode and records exit code and line count. By hand: `just cli getListInfo list_id=<id>`.

## Gotchas
- The space index is fetched once at start; a space created after start is not searchable until restart.
- Stdio start fails hard with a bad token (`401 Unauthorized` on user and spaces) and the smoke hangs: fix the token, do not retry blindly.
- `CLICKUP_TEAM_ID` is auto-detected only when the token sees exactly one workspace.
