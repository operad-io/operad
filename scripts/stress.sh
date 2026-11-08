#!/usr/bin/env bash
# Reproduce a flaky test on demand: run test files many times, optionally under load.
#   bash scripts/stress.sh [--runs N] [--load K] [-t <name pattern>] <test files...>
# Set STRESS_PIDFILE to a path to have the load helpers' pids written there.
set -uo pipefail
cd "$(dirname "$0")/.."

runs=50
load=0
pattern=""
files=()
usage() { echo "usage: bash scripts/stress.sh [--runs N] [--load K] [-t <name pattern>] <test files...>" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --runs) [ $# -ge 2 ] || usage; runs="$2"; shift 2 ;;
    --load) [ $# -ge 2 ] || usage; load="$2"; shift 2 ;;
    -t) [ $# -ge 2 ] || usage; pattern="$2"; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *) files+=("$1"); shift ;;
  esac
done
[ ${#files[@]} -gt 0 ] || usage
case "$runs" in ''|*[!0-9]*|0) echo "--runs wants a positive number" >&2; exit 2 ;; esac
case "$load" in ''|*[!0-9]*) echo "--load wants a number" >&2; exit 2 ;; esac

cpus=$( (getconf _NPROCESSORS_ONLN || nproc || sysctl -n hw.ncpu) 2>/dev/null | head -n 1)
case "$cpus" in ''|*[!0-9]*) cpus=1 ;; esac
[ "$load" -le "$cpus" ] || load="$cpus"

helpers=()
stop_helpers() {
  if [ ${#helpers[@]} -gt 0 ]; then
    kill "${helpers[@]}" 2>/dev/null
    wait "${helpers[@]}" 2>/dev/null
    helpers=()
  fi
}
trap stop_helpers EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Helper 1 forks a short process in a loop; the others spin.
i=0
while [ "$i" -lt "$load" ]; do
  if [ "$i" -eq 0 ]; then
    ( while :; do /usr/bin/true; done ) </dev/null >/dev/null 2>&1 &
  else
    ( while :; do :; done ) </dev/null >/dev/null 2>&1 &
  fi
  helpers+=("$!")
  i=$((i + 1))
done
if [ -n "${STRESS_PIDFILE:-}" ]; then
  : > "$STRESS_PIDFILE"
  [ ${#helpers[@]} -eq 0 ] || printf '%s\n' "${helpers[@]}" > "$STRESS_PIDFILE"
fi

log=$(mktemp "${TMPDIR:-/tmp}/stress.XXXXXX") || exit 2
args=(test "${files[@]}" --rerun-each "$runs" --timeout 30000)
[ -z "$pattern" ] || args+=(-t "$pattern")
bun "${args[@]}" > "$log" 2>&1 < /dev/null
status=$?
stop_helpers

passes=$(sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' "$log" | tail -n 1)
fails=$(sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' "$log" | tail -n 1)
passes=${passes:-0}
fails=${fails:-0}

echo "runs: $((passes + fails))"
echo "passes: $passes"
echo "failures: $fails"
if [ "$fails" -gt 0 ]; then
  echo "failing tests:"
  sed -n 's/^(fail) \(.*\) \[[0-9.]*m\{0,1\}s\]$/\1/p' "$log" | sort | uniq -c |
    while read -r count name; do echo "  $count x $name"; done
fi
echo "log: $log"
if [ "$fails" -gt 0 ] || [ "$status" -ne 0 ]; then
  [ "$fails" -gt 0 ] || echo "bun exited with status $status and reported no failing test; see the log"
  exit 1
fi
