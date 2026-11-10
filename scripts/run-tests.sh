#!/usr/bin/env bash
# run-tests.sh [package...]: runs the test suite, or the tests of the named
# packages (directory names under packages/). With no name it runs every
# package and scripts/.
#
# Test files run in OPERAD_TEST_PARALLEL worker processes (bun test
# --parallel; a whole number of 1 or more, default 2: several task checks and
# an integration check run at once on a 10-core Mac, and 4 made the step limits
# tests time out). packages/tui runs in a separate step, one file after another:
# under --parallel (which implies --isolate) the opentui native library fails
# to load ("Cannot access 'default' before initialization").
# Both steps run; the exit code is non-zero when either failed.
set -uo pipefail
cd "$(dirname "$0")/.."
parallel=${OPERAD_TEST_PARALLEL:-2}
if ! [[ "$parallel" =~ ^[1-9][0-9]*$ ]]; then
  echo "run-tests: OPERAD_TEST_PARALLEL must be a whole number of 1 or more, not '$parallel'" >&2
  exit 2
fi
if [ $# -eq 0 ]; then
  names=()
  for dir in packages/*/; do
    dir=${dir%/}
    names+=("${dir#packages/}")
  done
  extra=("./scripts/")
else
  names=("$@")
  extra=()
fi
together=()
alone=()
for name in "${names[@]}"; do
  if [ "$name" = tui ]; then alone+=("./packages/tui/"); else together+=("./packages/${name}/"); fi
done
together+=("${extra[@]+"${extra[@]}"}")
code=0
if [ ${#together[@]} -gt 0 ]; then
  bun test --timeout 30000 --parallel="$parallel" "${together[@]}" || code=1
fi
if [ ${#alone[@]} -gt 0 ]; then
  bun test --timeout 30000 "${alone[@]}" || code=1
fi
exit "$code"
