#!/usr/bin/env bash
# Start the Burp Agent sidecar (dev mode, tsx watch-free: tsx src/index.ts).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIDECAR_DIR="${SCRIPT_DIR}/../sidecar"

if [[ ! -f "${SIDECAR_DIR}/package.json" ]]; then
  echo "error: sidecar directory not found at ${SIDECAR_DIR}" >&2
  exit 1
fi

cd "${SIDECAR_DIR}"
if [[ ! -d node_modules ]]; then
  echo "installing sidecar dependencies..."
  npm ci
fi

exec npm run dev
