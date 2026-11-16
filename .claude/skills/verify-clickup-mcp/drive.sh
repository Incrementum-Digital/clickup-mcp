#!/usr/bin/env bash
# Drive the server and save evidence under .verify/evidence/<date>/.
#   drive.sh all            hosted routes + guards (no ClickUp credential needed)
#   drive.sh all --live     also: stdio protocol smoke and read-only tool calls (needs
#                           CLICKUP_API_KEY in .env or the environment; reads only)
#   drive.sh health|metadata|guards|smoke|members|spaces
# Evidence holds status codes, tool names and counts. Never a token, never a task body.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUN="$ROOT/.verify/run"
PORT="$(cat "$RUN/port" 2>/dev/null || echo "${VERIFY_PORT:-38771}")"
BASE="http://127.0.0.1:$PORT"
DAY="$(date +%F)"; STAMP="$(date +%H%M%S)"
EV="$ROOT/.verify/evidence/$DAY"; mkdir -p "$EV"
LIVE=0; what="${1:-all}"; shift || true
for a in "$@"; do [ "$a" = "--live" ] && LIVE=1; done
pass=0; fail=0
record() { # name ok detail
  if [ "$2" = 0 ]; then echo "PASS  $1  $3"; pass=$((pass+1)); else echo "FAIL  $1  $3"; fail=$((fail+1)); fi
  printf '{"journey":"%s","ok":%s,"detail":"%s","at":"%s"}\n' "$1" "$([ "$2" = 0 ] && echo true || echo false)" "$3" "$(date -Is)" >>"$EV/journeys-$STAMP.jsonl"
}
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }
j_health() { c=$(code "$BASE/health"); b=$(curl -s "$BASE/health"); echo "$b" >"$EV/health-$STAMP.json"; [ "$c" = 200 ] && [ "$b" = '{"status":"ok"}' ]; record health $? "http $c"; }
j_metadata() {
  m=$(curl -s "$BASE/.well-known/oauth-authorization-server"); echo "$m" >"$EV/oauth-metadata-$STAMP.json"
  echo "$m" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["issuer"] and d["authorization_endpoint"] and d["token_endpoint"]' 2>/dev/null
  record oauth-metadata $? "issuer+endpoints present"
}
j_guards() {
  c1=$(code -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' "$BASE/mcp")
  c2=$(code -X POST -H 'content-type: application/json' -H 'authorization: Bearer not-a-real-token' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' "$BASE/mcp")
  c3=$(code "$BASE/mcp")
  echo "{\"no_token\":$c1,\"bad_token\":$c2,\"get_no_token\":$c3}" >"$EV/mcp-guards-$STAMP.json"
  [ "$c1" = 401 ] && [ "$c2" = 401 ] && [ "$c3" = 401 ]; record mcp-guards $? "no token $c1, bad token $c2, GET $c3"
}
live_env() { # loads CLICKUP_API_KEY from .env when not already set; prints nothing
  if [ -z "${CLICKUP_API_KEY:-}" ] && [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env"; set +a; fi
  [ -n "${CLICKUP_API_KEY:-}" ]
}
j_smoke() {
  live_env || { record stdio-smoke 1 "skipped: no CLICKUP_API_KEY (set it in .env for --live)"; return; }
  (cd "$ROOT" && npm run smoke >"$RUN/smoke.out" 2>&1); rc=$?
  grep -E '^(PASS|FAIL)' "$RUN/smoke.out" | sed 's/pk_[A-Za-z0-9_]*/pk_***/g' >"$EV/stdio-smoke-$STAMP.txt"
  record stdio-smoke $rc "$(grep -c '^PASS' "$RUN/smoke.out") pass, $(grep -c '^FAIL' "$RUN/smoke.out") fail"
}
j_tool() { # name tool args...
  local name="$1" tool="$2"; shift 2
  live_env || { record "$name" 1 "skipped: no CLICKUP_API_KEY"; return; }
  (cd "$ROOT" && CLICKUP_MCP_MODE=read-minimal npx ts-node src/cli.ts "$tool" "$@" >"$RUN/$name.out" 2>"$RUN/$name.err"); rc=$?
  lines=$(wc -l <"$RUN/$name.out")
  echo "{\"tool\":\"$tool\",\"exit\":$rc,\"output_lines\":$lines}" >"$EV/tool-$name-$STAMP.json"
  [ "$rc" = 0 ] && [ "$lines" -gt 0 ]; record "$name" $? "$tool exit $rc, $lines lines (bodies not kept)"
}
case "$what" in
  health) j_health;; metadata) j_metadata;; guards) j_guards;;
  smoke) j_smoke;; members) j_tool members getMembers;; spaces) j_tool spaces searchSpaces;;
  all) j_health; j_metadata; j_guards
       if [ "$LIVE" = 1 ]; then j_smoke; j_tool members getMembers; j_tool spaces searchSpaces; fi;;
  *) echo "unknown journey $what" >&2; exit 2;;
esac
echo "drive: $pass pass, $fail fail; evidence in $EV"
[ "$fail" = 0 ]
