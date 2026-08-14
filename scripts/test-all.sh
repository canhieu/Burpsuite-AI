#!/usr/bin/env bash
# Run all tests: fixtures first, then sidecar (if present). Report a summary.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${SCRIPT_DIR}/.."
FIXTURES_DIR="${ROOT_DIR}/fixtures"
SIDECAR_DIR="${ROOT_DIR}/sidecar"

status=0

echo "==> fixtures: npm ci + build + test"
cd "${FIXTURES_DIR}"
npm ci
npm run build
if ! npm test; then
  echo "ERROR: fixtures tests failed" >&2
  status=1
fi

if [[ -f "${SIDECAR_DIR}/package.json" ]]; then
  echo "==> sidecar: npm ci + build + test"
  cd "${SIDECAR_DIR}"
  npm ci
  npm run build
  if ! npm test; then
    echo "ERROR: sidecar tests failed" >&2
    status=1
  fi
else
  echo "==> sidecar not present, skipping"
fi

if [[ "${status}" -eq 0 ]]; then
  echo "SUMMARY: all tests passed"
else
  echo "SUMMARY: one or more test suites failed"
fi
exit "${status}"
