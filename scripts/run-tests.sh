#!/usr/bin/env bash
# run-tests.sh [package...]: runs the test suite, or the tests of the named
# packages (directory names under packages/, such as tui or harness/claude). With no name it runs every
# package and scripts/.
#
# Test files run in OPERAD_TEST_PARALLEL worker processes (bun test
# --parallel; a whole number of 1 or more, default 2: several task checks and
# an integration check run at once on a 10-core Mac, and 4 made the step limits
# tests time out). packages/tui runs in a separate step, one file after another:
# under --parallel (which implies --isolate) the opentui native library fails
# to load ("Cannot access 'default' before initialization").
# Both steps run; the exit code is non-zero when either failed.
#
# Every run ends its output with the ten slowest tests of the run (file, test,
# seconds; scripts/slowest-tests.ts). That only lists: it never fails the check.
# Every full run (no package name) also appends one line to the times file
# (OPERAD_TEST_TIMES, default ~/.operad-test-times; see scripts/test-times.ts,
# which prints the median, the fastest and the number of runs).
set -uo pipefail
cd "$(dirname "$0")/.."
parallel=${OPERAD_TEST_PARALLEL:-2}
if ! [[ "$parallel" =~ ^[1-9][0-9]*$ ]]; then
  echo "run-tests: OPERAD_TEST_PARALLEL must be a whole number of 1 or more, not '$parallel'" >&2
  exit 2
fi
if [ $# -eq 0 ]; then
  names=()
  for manifest in packages/*/package.json packages/*/*/package.json; do
    dir=${manifest%/package.json}
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
reports=$(mktemp -d)
trap 'rm -rf "$reports"' EXIT
code=0
steps=""
tests=0
started=$(date +%s)
# step <name> <test args...>: runs one bun test step, times it, keeps its junit report.
step() {
  local name=$1 began count
  shift
  began=$(date +%s)
  bun test --timeout 30000 --reporter=junit --reporter-outfile="$reports/$name.xml" "$@" || code=1
  steps="$steps $name=$(($(date +%s) - began))"
  count=$(sed -n 's/^<testsuites [^>]*tests="\([0-9]*\)".*/\1/p' "$reports/$name.xml" 2>/dev/null | head -n 1)
  tests=$((tests + ${count:-0}))
}
if [ ${#together[@]} -gt 0 ]; then
  step together --parallel="$parallel" "${together[@]}"
fi
if [ ${#alone[@]} -gt 0 ]; then
  step tui "${alone[@]}"
fi
total=$(($(date +%s) - started))
bun scripts/slowest-tests.ts "$reports"/*.xml || true
if [ $# -eq 0 ]; then
  commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
  result=pass
  [ "$code" -eq 0 ] || result=fail
  times=${OPERAD_TEST_TIMES:-$HOME/.operad-test-times}
  printf 'date=%s commit=%s tests=%s%s total=%s parallel=%s result=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$commit" "$tests" "$steps" "$total" "$parallel" "$result" \
    >>"$times" 2>/dev/null || echo "run-tests: cannot append to $times" >&2
fi
exit "$code"
