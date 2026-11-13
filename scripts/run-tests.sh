#!/usr/bin/env bash
# run-tests.sh [package...]: runs the test suite, or the tests of the named
# packages (directory names under packages/, such as tui or harness/claude). With no name it runs every
# package and scripts/.
#
# Light and heavy tests run as separate steps. A heavy test starts a real
# process, builds a real git repository, opens a port, or holds a lot of memory;
# it lives under test/heavy/ of its package (decision 8 of
# docs/backlog/operad-test-slimming.md). The light step leaves those files out
# and runs in OPERAD_TEST_PARALLEL worker processes (bun test --parallel; a whole
# number of 1 or more, default 2: several task checks and an integration check
# run at once on a 10-core Mac, and 4 made the step limits tests time out). The
# heavy step runs the heavy directories of the selected packages in
# OPERAD_TEST_HEAVY_PARALLEL worker processes (default 8), beside the light step
# (OPERAD_TEST_OVERLAP=0 runs it after instead). On the check host (idle, light
# parallel 5) a full run took 714 s on main, 946 s with heavy 4 after light,
# 761 s with 6 after, 619 s with 6 beside, 450 s with 8 beside: the heavy files
# are mostly waiting, so they want more workers than the light step does. packages/tui keeps its own step, one
# file after another, heavy files included: under --parallel (which implies
# --isolate) the opentui native library fails to load ("Cannot access 'default'
# before initialization").
# The heavy step starts beside the light and tui steps; its output is shown
# when they end.
# All steps run; the exit code is non-zero when any failed.
#
# Every run ends its output with the ten slowest tests of the run (file, test,
# seconds; scripts/slowest-tests.ts). That only lists: it never fails the check.
# A heartbeat line prints every OPERAD_TEST_HEARTBEAT_SECS seconds (default
# 60, 0 turns it off) only while a step's report or output file grows, so a
# silent hang still trips a gate's stall limit.
# Every full run (no package name) also appends one line to the times file
# (OPERAD_TEST_TIMES, default ~/.operad-test-times; see scripts/test-times.ts,
# which prints the median, the fastest and the number of runs).
set -uo pipefail
cd "$(dirname "$0")/.."
parallel=${OPERAD_TEST_PARALLEL:-2}
heavy_parallel=${OPERAD_TEST_HEAVY_PARALLEL:-8}
overlap=${OPERAD_TEST_OVERLAP:-1}
if ! [[ "$parallel" =~ ^[1-9][0-9]*$ ]]; then
  echo "run-tests: OPERAD_TEST_PARALLEL must be a whole number of 1 or more, not '$parallel'" >&2
  exit 2
fi
if ! [[ "$heavy_parallel" =~ ^[1-9][0-9]*$ ]]; then
  echo "run-tests: OPERAD_TEST_HEAVY_PARALLEL must be a whole number of 1 or more, not '$heavy_parallel'" >&2
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

# True when a directory holds a test file outside its test/heavy/ directory.
has_light() {
  [ -d "$1" ] && find "$1" -path '*/test/heavy/*' -prune -o -name '*.test.ts' -print -quit | grep -q .
}
# True when a directory holds any test file, its heavy ones included.
has_tests() {
  [ -d "$1" ] && find "$1" -name '*.test.ts' -print -quit | grep -q .
}
# True when a package has at least one test file under its test/heavy/ directory.
has_heavy() {
  [ -d "$1/test/heavy" ] && find "$1/test/heavy" -name '*.test.ts' -print -quit | grep -q .
}

together=()
alone=()
heavy=()
for name in "${names[@]}"; do
  dir="./packages/${name}"
  if [ "$name" = tui ]; then
    # The opentui native library cannot load under --parallel, so the whole tui
    # package keeps its own serial step, heavy files included.
    if has_tests "$dir"; then alone+=("$dir/"); fi
  else
    if has_light "$dir"; then together+=("$dir/"); fi
    if has_heavy "$dir"; then heavy+=("$dir/test/heavy"); fi
  fi
done
for dir in "${extra[@]+"${extra[@]}"}"; do
  if has_light "$dir"; then together+=("$dir"); fi
done
heartbeat=${OPERAD_TEST_HEARTBEAT_SECS:-60}
if ! [[ "$heartbeat" =~ ^[0-9]+$ ]]; then
  echo "run-tests: OPERAD_TEST_HEARTBEAT_SECS must be a whole number of seconds, not '$heartbeat'" >&2
  exit 2
fi
reports=$(mktemp -d)
heartbeat_pid=
started=$(date +%s)
# The heartbeat runs in a process group of its own, so stopping it also stops
# the sleep it waits in. It prints only when the report or output of a step
# grew, so a worker spinning without writing anything is still a stall.
report_bytes() {
  local total=0 file size
  for file in "$reports"/*; do
    [ -f "$file" ] || continue
    size=$(wc -c <"$file" 2>/dev/null | tr -d ' ')
    total=$((total + ${size:-0}))
  done
  echo "$total"
}
stop_heartbeat() {
  if [ -n "$heartbeat_pid" ]; then
    kill -TERM -"$heartbeat_pid" 2>/dev/null || kill -TERM "$heartbeat_pid" 2>/dev/null || true
    wait "$heartbeat_pid" 2>/dev/null || true
    heartbeat_pid=
  fi
}
cleanup() {
  stop_heartbeat
  rm -rf "$reports"
}
trap cleanup EXIT
if [ "$heartbeat" != 0 ]; then
  set -m
  (
    seen=$(report_bytes)
    while :; do
      sleep "$heartbeat"
      now=$(report_bytes)
      [ "$now" -gt "$seen" ] || continue
      printf 'run-tests: still running (%ss, %s bytes of output)\n' \
        "$(($(date +%s) - started))" "$now"
      seen=$now
    done
  ) &
  heartbeat_pid=$!
  set +m
fi
code=0
steps=""
tests=0
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
if [ ${#heavy[@]} -gt 0 ] && [ "$overlap" = 1 ]; then
  (
    began=$(date +%s)
    bun test --timeout 30000 --reporter=junit --reporter-outfile="$reports/heavy.xml" --parallel="$heavy_parallel" "${heavy[@]}" >"$reports/heavy.out" 2>&1
    echo $? >"$reports/heavy.code"
    echo $(($(date +%s) - began)) >"$reports/heavy.secs"
  ) &
  heavy_pid=$!
fi
if [ ${#together[@]} -gt 0 ]; then
  step together --parallel="$parallel" --path-ignore-patterns='**/test/heavy/**' "${together[@]}"
fi
if [ ${#alone[@]} -gt 0 ]; then
  step tui "${alone[@]}"
fi
if [ ${#heavy[@]} -gt 0 ] && [ "$overlap" != 1 ]; then
  step heavy --parallel="$heavy_parallel" "${heavy[@]}"
fi
if [ ${#heavy[@]} -gt 0 ] && [ "$overlap" = 1 ]; then
  wait "$heavy_pid"
  cat "$reports/heavy.out"
  [ "$(cat "$reports/heavy.code")" -eq 0 ] || code=1
  steps="$steps heavy=$(cat "$reports/heavy.secs")"
  count=$(sed -n 's/^<testsuites [^>]*tests="\([0-9]*\)".*/\1/p' "$reports/heavy.xml" 2>/dev/null | head -n 1)
  tests=$((tests + ${count:-0}))
fi
total=$(($(date +%s) - started))
bun scripts/slowest-tests.ts "$reports"/*.xml || true
if [ $# -eq 0 ]; then
  commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
  result=pass
  [ "$code" -eq 0 ] || result=fail
  times=${OPERAD_TEST_TIMES:-$HOME/.operad-test-times}
  parallel_fields="parallel=$parallel"
  [ ${#heavy[@]} -eq 0 ] || parallel_fields="$parallel_fields heavyParallel=$heavy_parallel"
  printf 'date=%s commit=%s tests=%s%s total=%s %s result=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$commit" "$tests" "$steps" "$total" "$parallel_fields" "$result" \
    >>"$times" 2>/dev/null || echo "run-tests: cannot append to $times" >&2
fi
exit "$code"
