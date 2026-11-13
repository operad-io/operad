#!/bin/sh
# Runs the tests: `sh check.sh` runs all of them, `sh check.sh NAME...` only those named.
# `--repeat N` runs each chosen test N times. A failing test prints `FAIL: <name>`.
# When EXAMPLE_FLAKY names a test, that test fails in a run of all tests and passes
# when it is run by name: a test that fails once and passes on rerun.
repeat=1
if [ "$1" = "--repeat" ]; then repeat=$2; shift 2; fi
all=0
if [ "$#" -eq 0 ]; then
  all=1
  set -- $(ls tests | sed 's/\.t$//')
fi
status=0
for name in "$@"; do
  i=0
  while [ "$i" -lt "$repeat" ]; do
    i=$((i + 1))
    if [ "$all" -eq 1 ] && [ "$name" = "${EXAMPLE_FLAKY:-}" ]; then
      echo "FAIL: $name"; status=1; break
    fi
    if ! sh "tests/$name.t"; then echo "FAIL: $name"; status=1; break; fi
  done
done
exit $status
