---
name: verify-clickup-mcp
description: Launch, check, drive and clean up the ClickUp MCP server (clickup-mcp) to prove a change works. Hosted mode (what Railway runs) needs no secret; stdio tool calls need a ClickUp token. Use before opening a PR, when a tool's output changed, or when the hosted OAuth front door was touched.
---

# Verify clickup-mcp

Two surfaces. **Hosted** (`node dist/http.js`, Railway service `clickup-mcp` in the MCPs project)
serves MCP over Streamable HTTP at `/mcp` behind an OAuth 2.1 server whose login delegates to
ClickUp; it starts with throwaway configuration and needs no ClickUp credential, so every machine
can prove it. **Stdio** (`node dist/index.js`, what `npx`/MCPB users run) needs a real ClickUp
token at start (it fetches the user and the space index before serving), so its drives run only
with `--live`.

Secrets: there is no Doppler project. Locally a gitignored `.env` (copy `.env.example`) holds
`CLICKUP_API_KEY` (and `CLICKUP_TEAM_ID`); `just` loads it. The Railway service has its own
variables. Never print one; evidence holds status codes, tool names and counts only.

## Launch

```bash
.claude/skills/verify-clickup-mcp/launch.sh        # builds, starts hosted mode on 127.0.0.1:38771
VERIFY_PORT=38881 .claude/skills/verify-clickup-mcp/launch.sh   # a second instance beside it
```

Ready means `GET /health` answers `{"status":"ok"}` (usually 2 to 4 s). The token secret is
generated for the run, kept in the process environment, and never written. The pid and port
go to `.verify/run/`; the server log to `.verify/run/server.log`. Two instances can run side by
side on different ports; the same port twice is refused by `launch.sh`.

## Doctor

```bash
.claude/skills/verify-clickup-mcp/doctor.sh        # or: just doctor
```

Read-only, seven checks: pid alive, `/health`, both OAuth metadata documents, `/mcp` refusing
anonymous POST and GET, and `dist/http.js` newer than `src/http.ts`. Run it first whenever
anything looks off; a failing doctor means the instance is not worth driving.

## Drive

```bash
.claude/skills/verify-clickup-mcp/drive.sh all            # hosted: health, OAuth metadata, /mcp guards
.claude/skills/verify-clickup-mcp/drive.sh all --live     # also stdio smoke + getMembers + searchSpaces
.claude/skills/verify-clickup-mcp/drive.sh smoke          # one journey; names in features/README.md
just cli getTaskById task_id=abc123                       # one tool, by hand, through src/cli.ts
```

The default drive proves the deployed entry point and its guards without any credential.
`--live` runs `npm run smoke` (initialize, `tools/list`, every schema, image-support wording over
real stdio JSON-RPC) and two read-only tools in `CLICKUP_MCP_MODE=read-minimal`. Nothing writes
to ClickUp: no task, comment, document or timer is created by any journey. The smoke script's
write test (`npm run smoke -- <task_id> <image>`) exists but is never called here; use a scratch
task if you run it by hand. ClickUp allows 100 calls a minute per user; the live drive spends
about five.

## Evidence

`.verify/evidence/<YYYY-MM-DD>/`: `journeys-<hhmmss>.jsonl` (one line per journey, pass or
fail with a detail), `health-*.json`, `oauth-metadata-*.json`, `mcp-guards-*.json` (the three
status codes), `stdio-smoke-*.txt` (PASS/FAIL lines only), `tool-*.json` (tool name, exit code,
line count). Response bodies and task contents stay in `.verify/run/` and are deleted by cleanup.
Paste the evidence path and the journey names into the PR under "How it was proved".

## Cleanup

```bash
.claude/skills/verify-clickup-mcp/cleanup.sh
```

Stops the launched process group by pid file, then anything still on the chosen port, removes
`.verify/run/`, keeps `.verify/evidence/`. Never kills by process name.

## Helpers

| Script | Does |
|---|---|
| `launch.sh` | build, start hosted mode with throwaway values, wait for `/health` |
| `doctor.sh` | seven read-only checks, exit 1 on any failure |
| `drive.sh <journey> [--live]` | the journeys above, evidence to `.verify/evidence/<date>/` |
| `cleanup.sh` | stop by pid and port, remove run state, keep evidence |

`just verify` runs the four in order; `just verify --live` adds the stdio journeys.
Unit tests (`just test`, 313 on 2026-11-16) mock ClickUp and need no secret.
