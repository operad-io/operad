#!/usr/bin/env bash
# A task's check: install, type-check, then the tests of the packages the change
# touches and of the packages that load them (scripts/changed-packages.ts). A
# change outside packages/ tests everything, like verify.sh. run-tests.sh runs
# the light tests, the tui step and the heavy tests under test/heavy/ as separate
# steps, so only the selected packages' heavy tests run here; the full
# scripts/verify.sh runs every package's heavy tests once more at integration,
# before merge.
# OPERAD_CHECK_BASE names the commit to compare with (default: the merge base
# of HEAD and origin/main).
set -euo pipefail
cd "$(dirname "$0")/.."
bun install --frozen-lockfile
bunx tsc -b
selection=$(bun scripts/changed-packages.ts "$PWD")
echo "check-changed: testing ${selection}"
case "$selection" in
  none) exit 0 ;;
  all) exec bash scripts/run-tests.sh ;;
esac
# shellcheck disable=SC2086 # the names are separate words
# run-tests.sh runs only these packages' heavy tests; the full run has them all.
exec bash scripts/run-tests.sh $selection
