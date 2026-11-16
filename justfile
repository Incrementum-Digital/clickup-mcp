# clickup-mcp. Secrets come from a gitignored `.env` (copy `.env.example`); there is no
# Doppler project for this repo, and the Railway service holds its own variables.
# `set dotenv-load` gives every recipe what `.env` holds, and nothing is printed.

set dotenv-load

# Run the stdio server with a watcher (needs CLICKUP_API_KEY or a saved OAuth token).
dev:
    npm run dev

# Run the hosted server (what Railway runs: node dist/http.js). Needs MCP_TOKEN_SECRET,
# CLICKUP_CLIENT_ID, CLICKUP_CLIENT_SECRET and MCP_PUBLIC_URL in .env.
serve: build
    node dist/http.js

install:
    npm ci

build:
    npm run build

# Unit tests: no secrets, ClickUp is mocked (src/tests/setup.ts).
test:
    npm test

# Protocol smoke over stdio: initialize, tools/list, schemas. Needs a real token.
smoke: build
    npm run smoke

# Call one tool directly: just cli getMembers; just cli getTaskById task_id=abc123
cli *args:
    npx ts-node src/cli.ts {{args}}

# Read-only check of a running hosted instance (default: the verify skill's private port).
doctor:
    .claude/skills/verify-clickup-mcp/doctor.sh

# Launch, doctor, drive, cleanup, in one go (no ClickUp token needed; add --live for tool calls).
verify *args:
    .claude/skills/verify-clickup-mcp/launch.sh && .claude/skills/verify-clickup-mcp/doctor.sh \
      && .claude/skills/verify-clickup-mcp/drive.sh all {{args}}; rc=$?; \
      .claude/skills/verify-clickup-mcp/cleanup.sh; exit $rc
