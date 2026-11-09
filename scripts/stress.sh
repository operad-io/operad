#!/usr/bin/env bash
# Reproduce a flaky test on demand: run test files many times, optionally under load.
#   bash scripts/stress.sh [--runs N] [--load K] [-t <name pattern>] <test files...>
# Set STRESS_PIDFILE to a path to have the load helpers' pids written there.
# Set STRESS_CPUS to override the detected CPU count that caps --load.
# One stress run per machine: the script takes a lock before it starts its load
# helpers and test runs, and holds it until it ends (normally, by a failure or
# by a signal). A second run waits for it, printing once to stderr which run
# holds it (pid, command line, working directory, how long), and starts no
# helper while it waits. A lock whose holder is no longer alive is taken over,
# saying so once. A stress run may therefore wait for another; the wait is not
# part of its result. The lock is the directory ${TMPDIR:-/tmp}/operad-stress.lock,
# outside any worktree, so runs from every worktree share it.
#   --no-lock    skip the lock, for a run that knows it is alone
#   STRESS_LOCK  names another lock path (for the tests)
# Each helper also stops when this script is gone, so a SIGKILL of the script
# (which runs no trap) leaves no helper behind. The script itself stops when
# its own parent is gone, so a SIGKILL of the runner that started it ends all.
set -uo pipefail
starter=$PPID
cmdline="$0 $*"
cd "$(dirname "$0")/.."

runs=50
load=0
pattern=""
use_lock=1
files=()
usage() { echo "usage: bash scripts/stress.sh [--runs N] [--load K] [--no-lock] [-t <name pattern>] <test files...>" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --runs) [ $# -ge 2 ] || usage; runs="$2"; shift 2 ;;
    --load) [ $# -ge 2 ] || usage; load="$2"; shift 2 ;;
    --no-lock) use_lock=0; shift ;;
    -t) [ $# -ge 2 ] || usage; pattern="$2"; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *) files+=("$1"); shift ;;
  esac
done
[ ${#files[@]} -gt 0 ] || usage
case "$runs" in ''|*[!0-9]*|0) echo "--runs wants a positive number" >&2; exit 2 ;; esac
case "$load" in ''|*[!0-9]*) echo "--load wants a number" >&2; exit 2 ;; esac

bun scripts/check-install.ts || exit 2

cpus=${STRESS_CPUS:-$( (getconf _NPROCESSORS_ONLN || nproc || sysctl -n hw.ncpu) 2>/dev/null | head -n 1)}
case "$cpus" in ''|*[!0-9]*) cpus=1 ;; esac
[ "$load" -le "$cpus" ] || load="$cpus"

helpers=()
watcher=""
stop_helpers() {
  local all=(${helpers[@]+"${helpers[@]}"})
  [ -z "$watcher" ] || all+=("$watcher")
  if [ ${#all[@]} -gt 0 ]; then
    kill "${all[@]}" 2>/dev/null
    wait "${all[@]}" 2>/dev/null
    helpers=()
    watcher=""
  fi
}

lock=${STRESS_LOCK:-${TMPDIR:-/tmp}/operad-stress.lock}
lock_held=0
release_lock() {
  [ "$lock_held" -eq 1 ] || return 0
  lock_held=0
  # No pid file yet means this run was stopped between mkdir and writing it.
  local pid
  pid=$(cat "$lock/pid" 2>/dev/null)
  if [ -z "$pid" ] || [ "$pid" = "$$" ]; then rm -rf "$lock"; fi
}
finish() { stop_helpers; release_lock; }
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Sleeps in the background so that a trap runs at once.
nap() { sleep "$1" & wait $! 2>/dev/null; }

lock_holder() {
  local since now secs
  since=$(cat "$lock/since" 2>/dev/null)
  now=$(date +%s)
  case "$since" in ''|*[!0-9]*) secs=0 ;; *) secs=$((now - since)) ;; esac
  echo "stress: waiting for the stress run holding $lock: pid $1, command '$(cat "$lock/cmd" 2>/dev/null)', in $(cat "$lock/cwd" 2>/dev/null), held for $((secs / 60))m $((secs % 60))s" >&2
}

acquire_lock() {
  local told=0 noinfo=0 nodir=0 pid moved stale
  mkdir -p "$(dirname "$lock")" 2>/dev/null
  while :; do
    if mkdir "$lock" 2>/dev/null; then
      lock_held=1
      printf '%s\n' "$cmdline" > "$lock/cmd"
      pwd > "$lock/cwd"
      date +%s > "$lock/since"
      echo "$$" > "$lock/pid" # last: a pid file means the rest is there
      return 0
    fi
    if [ ! -d "$lock" ]; then
      nodir=$((nodir + 1))
      [ "$nodir" -le 20 ] || { echo "stress: cannot create the lock $lock" >&2; exit 2; }
      nap 0.1
      continue
    fi
    pid=$(cat "$lock/pid" 2>/dev/null)
    if [ -z "$pid" ]; then
      # Another run is between mkdir and its pid file; if it never finishes, it died.
      noinfo=$((noinfo + 1))
      if [ "$noinfo" -gt 20 ]; then
        stale="$lock.stale.$$"; rm -rf "$stale"
        mv "$lock" "$stale" 2>/dev/null && rm -rf "$stale"
      fi
      nap 0.25
      continue
    fi
    noinfo=0
    if ps -p "$pid" >/dev/null 2>&1; then
      if [ "$told" -eq 0 ]; then told=1; lock_holder "$pid"; fi
      nap 0.5
      continue
    fi
    # The holder is gone. Move the lock aside (one waiter wins), and put it back
    # if it turns out to be a newer holder's.
    stale="$lock.stale.$$"; rm -rf "$stale"
    if mv "$lock" "$stale" 2>/dev/null; then
      moved=$(cat "$stale/pid" 2>/dev/null)
      if [ "$moved" = "$pid" ]; then
        rm -rf "$stale"
        echo "stress: the run holding $lock (pid $pid) is gone; taking over its lock" >&2
      else
        mv "$stale" "$lock" 2>/dev/null || rm -rf "$stale"
      fi
    fi
  done
}

parent=$$
# Stop with the process that started this script (the TERM trap then runs).
( while kill -0 "$parent" 2>/dev/null && kill -0 "$starter" 2>/dev/null; do sleep 0.5; done
  kill -TERM "$parent" 2>/dev/null ) </dev/null >/dev/null 2>&1 &
watcher=$!

[ "$use_lock" -eq 0 ] || acquire_lock

# A helper runs while this script's pid exists; kill -0 is a builtin.
# Helper 1 forks a short process in a loop; the others spin.
i=0
while [ "$i" -lt "$load" ]; do
  if [ "$i" -eq 0 ]; then
    ( while kill -0 "$parent" 2>/dev/null; do /usr/bin/true; done ) </dev/null >/dev/null 2>&1 &
  else
    ( while kill -0 "$parent" 2>/dev/null; do :; done ) </dev/null >/dev/null 2>&1 &
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
# In the background, so that a trap runs while it works.
bun "${args[@]}" > "$log" 2>&1 < /dev/null &
bunpid=$!
helpers+=("$bunpid")
wait "$bunpid"
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
