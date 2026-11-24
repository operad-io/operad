#!/usr/bin/env bash
# The gate: every step must pass before a change is done.
set -euo pipefail
cd "$(dirname "$0")/.."
bun install --frozen-lockfile
bunx tsc -b
# A test gets 30s, not bun's 5s: tests that build git repositories and kill
# real processes pass in 1-2s alone but crossed 5s while several task checks ran
# at once. bunfig.toml's [test] timeout is not honoured, so run-tests.sh passes
# the flag. It runs the files in parallel worker processes (see its header).
bash scripts/run-tests.sh
