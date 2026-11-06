#!/usr/bin/env bash
# The gate: every step must pass before a change is done.
set -euo pipefail
cd "$(dirname "$0")/.."
bun install --frozen-lockfile
bunx tsc -b
bun test
