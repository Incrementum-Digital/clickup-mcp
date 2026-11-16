#!/usr/bin/env bash
# Read-only: is the hosted instance worth driving? Process up, port ours, /health ok,
# OAuth metadata served, /mcp refusing anonymous calls. Exit 1 on any failure.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUN="$ROOT/.verify/run"
PORT="$(cat "$RUN/port" 2>/dev/null || echo "${VERIFY_PORT:-38771}")"
BASE="http://127.0.0.1:$PORT"
ok=0; fail=0
check() { if eval "$2"; then echo "ok    $1"; ok=$((ok+1)); else echo "FAIL  $1"; fail=$((fail+1)); fi; }
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }
check "process from .verify/run/pid is alive" '[ -f "$RUN/pid" ] && kill -0 "$(cat "$RUN/pid")" 2>/dev/null'
check "GET /health is 200 {\"status\":\"ok\"}" '[ "$(curl -s --max-time 10 "$BASE/health")" = "{\"status\":\"ok\"}" ]'
check "OAuth authorization-server metadata is 200" '[ "$(code "$BASE/.well-known/oauth-authorization-server")" = 200 ]'
check "OAuth protected-resource metadata is 200" '[ "$(code "$BASE/.well-known/oauth-protected-resource")" = 200 ]'
check "POST /mcp without a token is 401" '[ "$(code -X POST -H "content-type: application/json" -d "{}" "$BASE/mcp")" = 401 ]'
check "GET /mcp without a token is 401" '[ "$(code "$BASE/mcp")" = 401 ]'
check "dist/http.js is newer than src/http.ts" '[ "$ROOT/dist/http.js" -nt "$ROOT/src/http.ts" ]'
echo "doctor: $ok ok, $fail fail"
[ "$fail" = 0 ]
