#!/usr/bin/env bash
# Stop what launch.sh started, by pid file and then by the port we own. Never by process
# name. Removes .verify/run; keeps .verify/evidence.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUN="$ROOT/.verify/run"
PORT="$(cat "$RUN/port" 2>/dev/null || echo "${VERIFY_PORT:-38771}")"
if [ -f "$RUN/pid" ]; then
  pid="$(cat "$RUN/pid")"
  if kill -0 "$pid" 2>/dev/null; then kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null; fi
  for _ in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -0 "$pid" 2>/dev/null && kill -9 -- -"$pid" 2>/dev/null
fi
# Anything still holding our port (only ours: launch.sh picked it) is finished off too.
for p in $(ss -ltnp 2>/dev/null | awk -v port=":$PORT" '$4 ~ port"$" {print $NF}' | grep -oE 'pid=[0-9]+' | cut -d= -f2); do kill "$p" 2>/dev/null; done
rm -rf "$RUN"
if ss -ltn 2>/dev/null | grep -q ":$PORT "; then echo "port $PORT still open" >&2; exit 1; fi
echo "cleanup: port $PORT closed, evidence kept"
