#!/usr/bin/env bash
# Start all fixture servers in the background:
#   http (9000, normal)  ws (9001)  provider (9002)  oauth (9003)
# PIDs written to /tmp/burp-agent-fixtures.pid
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_DIR="${SCRIPT_DIR}/../fixtures"
PID_FILE="${BURP_FIXTURES_PID_FILE:-/tmp/burp-agent-fixtures.pid}"

cd "${FIXTURES_DIR}"
if [[ ! -d dist ]]; then
  echo "building fixtures..."
  npm run build
fi

mkdir -p /tmp/burp-agent-fixtures
start_one() {
  local name="$1"; shift
  node dist/index.js "$@" >"/tmp/burp-agent-fixtures/${name}.log" 2>&1 &
  echo $! >> "${PID_FILE}"
}

rm -f "${PID_FILE}"
start_one http  http  --port 9000 --scenario normal
start_one ws    ws    --port 9001
start_one prov  provider --port 9002
start_one oauth oauth --port 9003

echo "fixtures started (pids in ${PID_FILE}):"
echo "  http     127.0.0.1:9000  (scenario normal)  log /tmp/burp-agent-fixtures/http.log"
echo "  ws       127.0.0.1:9001                      log /tmp/burp-agent-fixtures/ws.log"
echo "  provider 127.0.0.1:9002                      log /tmp/burp-agent-fixtures/prov.log"
echo "  oauth    127.0.0.1:9003                      log /tmp/burp-agent-fixtures/oauth.log"
echo "stop: kill \$(cat ${PID_FILE})"
