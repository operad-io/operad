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
# part of its result. The lock is the directory ${HOME:-/tmp}/.operad-stress.lock,
# outside any worktree and independent of TMPDIR, so runs from every worktree
# and sandbox of a user share it.
#   --no-lock    skip the lock, for a run that knows it is alone
#   STRESS_LOCK  names another lock path (for the tests)
# Each helper also stops when this script is gone, so a SIGKILL of the script
# (which runs no trap) leaves no helper and no test runner behind. The script
# itself stops when its own parent is gone, so a SIGKILL of the runner that
# started it ends all.
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
if [ "$cpus" -lt 1 ]; then echo "STRESS_CPUS wants a positive number" >&2; exit 2; fi
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

lock=${STRESS_LOCK:-${HOME:-/tmp}/.operad-stress.lock}
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

take_over_lock() { # expected pid (empty while the holder has not written it)
  local current tpid
  if mkdir "$lock.takeover" 2>/dev/null; then
    echo "$$" > "$lock.takeover/pid"
    current=$(cat "$lock/pid" 2>/dev/null)
    if [ "$current" = "$1" ]; then
      rm -rf "$lock"
      if [ -n "$1" ]; then
        echo "stress: the run holding $lock (pid $1) is gone; taking over its lock" >&2
      fi
    fi
    rm -rf "$lock.takeover"
    return 0
  fi
  # Another waiter is taking over. Clear its directory only if its process died.
  tpid=$(cat "$lock.takeover/pid" 2>/dev/null)
  if [ -n "$tpid" ] && ! stress_pid_alive "$tpid"; then rm -rf "$lock.takeover"; fi
  return 1
}

acquire_lock() {
  local told=0 noinfo=0 nodir=0 pid
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
        take_over_lock ""
        noinfo=0
      fi
      nap 0.25
      continue
    fi
    noinfo=0
    if stress_pid_alive "$pid"; then
      if [ "$told" -eq 0 ]; then told=1; lock_holder "$pid"; fi
      nap 0.5
      continue
    fi
    # The holder is gone, or its pid now belongs to something else. Waiters
    # take over through one directory, so none moves a newer lock aside.
    if take_over_lock "$pid"; then
      told=0
    else
      nap 0.15
    fi
  done
}

parent=$$
parent_start=$(ps -p "$parent" -o lstart= 2>/dev/null)
starter_start=$(ps -p "$starter" -o lstart= 2>/dev/null)

# True when the pid is the same live process, not a reused pid or a zombie.
same_process() {
  local stat current
  stat=$(ps -p "$1" -o stat= 2>/dev/null) || return 1
  case "$stat" in *Z*) return 1 ;; esac
  [ -z "$2" ] && return 0
  current=$(ps -p "$1" -o lstart= 2>/dev/null)
  [ "$current" = "$2" ]
}
parent_alive() { same_process "$parent" "$parent_start"; }
starter_alive() { same_process "$starter" "$starter_start"; }
stress_pid_alive() {
  local stat command
  stat=$(ps -p "$1" -o stat= 2>/dev/null) || return 1
  case "$stat" in *Z*) return 1 ;; esac
  command=$(ps -p "$1" -o command= 2>/dev/null)
  case "$command" in *stress.sh*) return 0 ;; *) return 1 ;; esac
}
# Stop with the process that started this script (the TERM trap then runs).
( while parent_alive && starter_alive; do sleep 2; done
  kill -TERM "$parent" 2>/dev/null ) </dev/null >/dev/null 2>&1 &
watcher=$!

[ "$use_lock" -eq 0 ] || acquire_lock

# A helper runs while this script is the same live process, so a reused pid
# or a zombie does not keep it going. Helper 1 forks a short process in a loop;
# the others spin.
i=0
while [ "$i" -lt "$load" ]; do
  if [ "$i" -eq 0 ]; then
    ( while parent_alive; do /usr/bin/true; done ) </dev/null >/dev/null 2>&1 &
  else
    ( while parent_alive; do :; done ) </dev/null >/dev/null 2>&1 &
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
# A SIGKILL of this script runs no trap: stop the test runner from a watcher.
( while parent_alive; do sleep 0.2; done
  kill -TERM "$bunpid" 2>/dev/null
  sleep 0.2
  kill -KILL "$bunpid" 2>/dev/null ) </dev/null >/dev/null 2>&1 &
helpers+=("$!")
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
