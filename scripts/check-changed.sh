#!/usr/bin/env bash
# A task's check: install, type-check, then the tests of the packages the change
# touches and of the packages that load them (scripts/changed-packages.ts). A
# change outside packages/ tests everything, like verify.sh. The full
# scripts/verify.sh runs once more at integration, before merge.
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
exec bash scripts/run-tests.sh $selection
