#!/usr/bin/env bash
# Publish the packages `bun publish` would publish. With no flag it only packs
# each package as a dry run. With --publish it packs and publishes each in
# dependency order, skipping a version that is already on the registry. It
# never changes a version.
#
#   bash scripts/publish.sh [--publish] [--otp <one-time password>]
set -euo pipefail
cd "$(dirname "$0")/.."

usage() {
  echo "usage: publish.sh [--publish] [--otp <one-time password>]" >&2
  exit 2
}

publish=false
otp=()
while [ $# -gt 0 ]; do
  case "$1" in
    --publish) publish=true ;;
    --otp)
      [ $# -ge 2 ] || usage
      otp=(--otp "$2")
      shift
      ;;
    --otp=*) otp=("$1") ;;
    -h | --help)
      sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) usage ;;
  esac
  shift
done

# Dependency order: a package comes after every @operad-io package it needs.
packages=(
  engine
  mcp
  harness/process
  access-match
  shell
  chat
  review-grading
  pool
  dev
  harness/radian
  harness/pi
  harness/claude
  harness/codex
  bot
  tui
  cli
)

manifest_field() {
  bun -e 'const p = JSON.parse(await Bun.file(process.argv[1]).text()); process.stdout.write(String(p[process.argv[2]]));' "$1" "$2"
}

tarballs=$(mktemp -d)
trap 'rm -rf "$tarballs"' EXIT

for package in "${packages[@]}"; do
  directory="packages/${package}"
  manifest="${directory}/package.json"
  name=$(manifest_field "$manifest" name)
  version=$(manifest_field "$manifest" version)
  if [ "$publish" = false ]; then
    echo "publish: dry run ${name}@${version}"
    (cd "$directory" && bun pm pack --dry-run)
    continue
  fi
  if bun pm view "${name}@${version}" version >/dev/null 2>&1; then
    echo "publish: ${name}@${version} is already on the registry; skipped"
    continue
  fi
  echo "publish: packing ${name}@${version}"
  file=$(cd "$directory" && bun pm pack --destination "$tarballs" --quiet | tail -n 1)
  echo "publish: publishing ${name}@${version}"
  bun publish "$file" --access public "${otp[@]+"${otp[@]}"}"
done
