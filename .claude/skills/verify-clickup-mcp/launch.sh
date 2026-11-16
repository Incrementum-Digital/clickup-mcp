#!/usr/bin/env bash
# Build and start the HOSTED server (node dist/http.js, what Railway runs) on a private port
# with throwaway values. Nothing here needs a ClickUp credential: the hosted entry point
# only validates its configuration at start, and the MCP endpoint is behind OAuth.
# State goes to .verify/run/; evidence is never written here.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUN="$ROOT/.verify/run"
PORT="${VERIFY_PORT:-38771}"
mkdir -p "$RUN"
if [ -f "$RUN/pid" ] && kill -0 "$(cat "$RUN/pid")" 2>/dev/null; then
  echo "already running (pid $(cat "$RUN/pid")); run cleanup.sh first" >&2
  exit 1
fi
cd "$ROOT"
npm run build >"$RUN/build.log" 2>&1 || { echo "build failed, see $RUN/build.log" >&2; exit 1; }
# A throwaway token secret, in the environment only; never printed, never saved.
secret="$(head -c 48 /dev/urandom | base64 | tr -d '/+=' | head -c 40)"
PORT="$PORT" MCP_PUBLIC_URL="http://127.0.0.1:$PORT" MCP_TOKEN_SECRET="$secret" \
  CLICKUP_CLIENT_ID="${CLICKUP_CLIENT_ID:-verify-dummy}" \
  CLICKUP_CLIENT_SECRET="${CLICKUP_CLIENT_SECRET:-verify-dummy-secret}" \
  CLICKUP_TEAM_ID="${CLICKUP_TEAM_ID:-1}" \
  setsid node dist/http.js >"$RUN/server.log" 2>&1 < /dev/null &
echo $! >"$RUN/pid"
echo "$PORT" >"$RUN/port"
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/health" 2>/dev/null; then
    echo "ready: http://127.0.0.1:$PORT (pid $(cat "$RUN/pid"))"
    exit 0
  fi
  sleep 1
done
echo "not ready after 30 s; see $RUN/server.log" >&2
exit 1
