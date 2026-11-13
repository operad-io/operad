#!/usr/bin/env bash
# remote-check.sh <command>: runs a check command here, or on another machine.
# remote-check.sh -- <word>...: the same, for a command given as separate
# words (argv): no shell reads the words as code, here or on the host, so a
# word may hold any quote, backquote or `$`.
#
# With OPERAD_CHECK_HOST unset or empty, it runs `bash -c <command>` in the
# repository root. With it set (an ssh destination such as user@host), it
# copies HEAD to that host as a git bundle (`HEAD --not origin/main`; none when
# HEAD is already on origin/main) and there, holding one of OPERAD_CHECK_SLOTS
# slots (~/.operad-check-<i>.lock), fetches origin and the bundle into that
# slot's tree, checks out HEAD's sha detached, and runs the command. Slot 1's
# tree is OPERAD_CHECK_TREE; every other slot, and the integration slot, has a
# git worktree of it (<tree>-slot<i>, <tree>-integration) made on first use. The output streams back and the exit code is the command's. A step
# that fails before the command (bundle, copy, connect, fetch, checkout) exits
# 1 with one line that names it.
#
# OPERAD_CHECK_SLOTS  how many checks run at once on the host (whole number, default 1)
# OPERAD_CHECK_LANE   "integration" takes the integration slot
#                    (~/.operad-check-integration.lock) instead of a task slot
# OPERAD_CHECK_TREE  the clone on the host, relative to its home (default Code/operad)
# OPERAD_CHECK_PATH  directories put first on the host's PATH (default
#                    $HOME/.bun-operad/bin:$HOME/.bun/bin)
# OPERAD_CHECK_SSH, OPERAD_CHECK_SCP  the ssh and scp commands (tests replace them)
set -uo pipefail
cd "$(dirname "$0")/.."
argv=()
if [ "${1-}" = -- ]; then
  shift
  [ $# -ge 1 ] || { echo "remote-check: usage: remote-check.sh -- <word>..." >&2; exit 2; }
  argv=("$@")
  command=$(printf '%q ' "$@")
elif [ $# -ne 1 ]; then
  echo "remote-check: usage: remote-check.sh <command> | remote-check.sh -- <word>..." >&2
  exit 2
else
  command=$1
fi
fail() {
  echo "remote-check: $1" >&2
  exit 1
}

slots=${OPERAD_CHECK_SLOTS-1}
if ! [[ "$slots" =~ ^[1-9][0-9]*$ ]]; then
  fail "OPERAD_CHECK_SLOTS must be a whole number of 1 or more, not '$slots'"
fi
lane=
if [ -n "${OPERAD_CHECK_LANE+set}" ]; then
  [ "$OPERAD_CHECK_LANE" = integration ] || fail "OPERAD_CHECK_LANE must be 'integration' or unset, not '$OPERAD_CHECK_LANE'"
  lane=integration
fi

host=${OPERAD_CHECK_HOST:-}
if [ -z "$host" ]; then
  if [ ${#argv[@]} -gt 0 ]; then exec "${argv[@]}"; fi
  exec bash -c "$command"
fi
tree=${OPERAD_CHECK_TREE:-Code/operad}
path_dirs=${OPERAD_CHECK_PATH:-'$HOME/.bun-operad/bin:$HOME/.bun/bin'}
read -r -a ssh_cmd <<<"${OPERAD_CHECK_SSH:-ssh -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=4}"
read -r -a scp_cmd <<<"${OPERAD_CHECK_SCP:-scp -q -o BatchMode=yes}"

sha=$(git rev-parse HEAD) || fail "cannot read HEAD"
git fetch -q origin || fail "fetch origin failed"
bundle=none
if ! git merge-base --is-ancestor HEAD origin/main; then
  dir=$(mktemp -d)
  trap 'rm -rf "$dir"' EXIT
  git bundle create -q "$dir/check.bundle" HEAD --not origin/main 2>/dev/null || fail "bundle failed"
  bundle="operad-check-$sha-$$.bundle"
  "${scp_cmd[@]}" "$dir/check.bundle" "$host:$bundle" || fail "copy to $host failed"
fi

echo "remote-check: checking $sha on $host"
quoted=$(printf '%q ' "$sha" "$bundle" "$tree" "$path_dirs" "$command" "$slots" "$lane")
"${ssh_cmd[@]}" "$host" "bash -s -- $quoted" <<'REMOTE'
sha=$1; bundle=$2; tree=$3; path_dirs=$4; command=$5; slots=$6; lane=$7
watch=
child=
session=${TMPDIR:-/tmp}/operad-check-session-$$
: >"$session"
cleanup() {
  [ -z "$watch" ] || kill -KILL "$watch" 2>/dev/null || true
  rm -f "$session"
  [ "$bundle" = none ] || rm -f "$HOME/$bundle"
}
trap cleanup EXIT
# A local stop closes the connection, and sshd ends this session's parent. The
# watcher then ends the command's group (or this whole group while the check is
# still waiting for a slot), so nothing is left running on the host. It ignores
# a HUP, which the host may also send, until it has done that.
parent=$PPID
(
  trap '' HUP TERM INT
  while kill -0 "$parent" 2>/dev/null; do sleep 1; done
  running=$(cat "$session" 2>/dev/null)
  if [ -n "$running" ]; then
    kill -TERM -"$running" 2>/dev/null || kill -TERM "$running" 2>/dev/null || true
    sleep 1
    kill -KILL -"$running" 2>/dev/null || true
  else
    kill -TERM -$$ 2>/dev/null || kill -TERM $$ 2>/dev/null || true
    sleep 1
    kill -KILL -$$ 2>/dev/null || true
  fi
) &
watch=$!
shutdown() {
  trap '' HUP TERM INT
  if [ -n "$child" ]; then
    kill -TERM -"$child" 2>/dev/null || kill -TERM "$child" 2>/dev/null || true
    sleep 1
    kill -KILL -"$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  exit 143
}
trap shutdown HUP TERM INT
export OPERAD_CHECK_SLOTS=$slots
if [ -n "$lane" ]; then export OPERAD_CHECK_LANE=$lane; else unset OPERAD_CHECK_LANE; fi
# Names the slots this check may take: the integration slot, or task slots 1..N.
if [ "$lane" = integration ]; then names=integration; else names=$(seq 1 "$slots"); fi
use_flock=
command -v flock >/dev/null 2>&1 && use_flock=1
slot=
while [ -z "$slot" ]; do
  for name in $names; do
    lock="$HOME/.operad-check-$name.lock"
    if [ -n "$use_flock" ]; then
      exec 8>"$lock"
      if flock -n 8; then slot=$name; break; fi
      exec 8>&-
    elif mkdir "$lock.d" 2>/dev/null; then
      # No flock (macOS): a directory is the lock; it is removed on exit.
      slot=$name
      trap 'cleanup; rmdir "$lock.d"' EXIT
      break
    fi
  done
  [ -n "$slot" ] || sleep 1
done
case "$slot" in
  1) slot_tree=$tree ;;
  integration) slot_tree=$tree-integration ;;
  *) slot_tree=$tree-slot$slot ;;
esac
if [ "$slot_tree" != "$tree" ] && [ ! -e "$HOME/$slot_tree" ]; then
  # First use of this slot: a worktree of the base clone, with its own files.
  (cd "$HOME/$tree" 2>/dev/null && git worktree prune && git worktree add -q --detach "$HOME/$slot_tree" HEAD) >/dev/null 2>&1 \
    || { echo "remote-check: cannot make the tree ~/$slot_tree for slot $slot" >&2; exit 1; }
fi
tree=$slot_tree
cd "$HOME/$tree" 2>/dev/null || { echo "remote-check: no clone at ~/$tree" >&2; exit 1; }
# Worktrees share refs/remotes/origin/*, so concurrent fetches can collide; retry.
fetched=
for _ in 1 2 3 4 5 6; do
  if git fetch -q origin 2>/dev/null; then fetched=1; break; fi
  sleep 1
done
[ -n "$fetched" ] || { echo "remote-check: fetch origin failed on the host" >&2; exit 1; }
if [ "$bundle" != none ]; then
  git fetch -q "$HOME/$bundle" HEAD 2>/dev/null || { echo "remote-check: fetch of the bundle failed" >&2; exit 1; }
fi
git checkout -q --detach --force "$sha" || { echo "remote-check: checkout of $sha failed" >&2; exit 1; }
# Only the root node_modules survives: a package directory that a previous
# commit had and this one does not would otherwise stay behind holding just its
# node_modules, and tests that list packages/ would find it.
git clean -q -ffdx -e /node_modules >/dev/null 2>&1 || true
export PATH="$(eval echo "$path_dirs"):$PATH"
# The session watcher above ends this command's group if the local check stops.
set -m
bash -c "$command" &
child=$!
set +m
printf '%s\n' "$child" >"$session"
wait "$child"
status=$?
trap - HUP TERM INT
exit "$status"
REMOTE
code=$?
if [ "$code" -eq 255 ]; then
  fail "ssh to $host failed"
fi
exit "$code"
