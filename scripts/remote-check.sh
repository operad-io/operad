#!/usr/bin/env bash
# remote-check.sh <command>: runs a check command here, or on another machine.
#
# With OPERAD_CHECK_HOST unset or empty, it runs `bash -c <command>` in the
# repository root. With it set (an ssh destination such as user@host), it
# copies HEAD to that host as a git bundle (`HEAD --not origin/main`; none when
# HEAD is already on origin/main) and there, holding the lock
# ~/.operad-check.lock (one check at a time per host), fetches origin and the
# bundle into OPERAD_CHECK_TREE, checks out HEAD's sha detached, and runs the
# command. The output streams back and the exit code is the command's. A step
# that fails before the command (bundle, copy, connect, fetch, checkout) exits
# 1 with one line that names it.
#
# OPERAD_CHECK_TREE  the clone on the host, relative to its home (default Code/operad)
# OPERAD_CHECK_PATH  directories put first on the host's PATH (default
#                    $HOME/.bun-operad/bin:$HOME/.bun/bin)
# OPERAD_CHECK_SSH, OPERAD_CHECK_SCP  the ssh and scp commands (tests replace them)
set -uo pipefail
cd "$(dirname "$0")/.."
if [ $# -ne 1 ]; then
  echo "remote-check: usage: remote-check.sh <command>" >&2
  exit 2
fi
command=$1
host=${OPERAD_CHECK_HOST:-}
if [ -z "$host" ]; then
  exec bash -c "$command"
fi
tree=${OPERAD_CHECK_TREE:-Code/operad}
path_dirs=${OPERAD_CHECK_PATH:-'$HOME/.bun-operad/bin:$HOME/.bun/bin'}
read -r -a ssh_cmd <<<"${OPERAD_CHECK_SSH:-ssh -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=4}"
read -r -a scp_cmd <<<"${OPERAD_CHECK_SCP:-scp -q -o BatchMode=yes}"

fail() {
  echo "remote-check: $1" >&2
  exit 1
}

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
quoted=$(printf '%q ' "$sha" "$bundle" "$tree" "$path_dirs" "$command")
"${ssh_cmd[@]}" "$host" "bash -s -- $quoted" <<'REMOTE'
sha=$1; bundle=$2; tree=$3; path_dirs=$4; command=$5
cleanup() { [ "$bundle" = none ] || rm -f "$HOME/$bundle"; }
trap cleanup EXIT
lock="$HOME/.operad-check.lock"
if command -v flock >/dev/null 2>&1; then
  exec 8>"$lock"
  flock 8
else
  # No flock (macOS): a directory is the lock; it is removed on exit.
  until mkdir "$lock.d" 2>/dev/null; do sleep 1; done
  trap 'cleanup; rmdir "$lock.d"' EXIT
fi
cd "$HOME/$tree" 2>/dev/null || { echo "remote-check: no clone at ~/$tree" >&2; exit 1; }
git fetch -q origin || { echo "remote-check: fetch origin failed on the host" >&2; exit 1; }
if [ "$bundle" != none ]; then
  git fetch -q "$HOME/$bundle" HEAD 2>/dev/null || { echo "remote-check: fetch of the bundle failed" >&2; exit 1; }
fi
git checkout -q --detach --force "$sha" || { echo "remote-check: checkout of $sha failed" >&2; exit 1; }
git clean -q -fdx -e node_modules >/dev/null 2>&1 || true
export PATH="$(eval echo "$path_dirs"):$PATH"
bash -c "$command"
REMOTE
code=$?
if [ "$code" -eq 255 ]; then
  fail "ssh to $host failed"
fi
exit "$code"
