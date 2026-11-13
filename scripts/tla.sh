#!/usr/bin/env bash
# Runs TLC on a model under tla/. Usage: scripts/tla.sh <model> [TLC arguments...]
# <model> is a directory of tla/ holding MC.tla and MC.cfg. Not part of any check.
set -euo pipefail

# The pinned TLC release and the sha256 its jar must have.
TLA_URL="https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar"
TLA_SHA256="e1f11b75c4b5bc4478ba0ac5cb6ae28e40a01b0016bc33e0aa97da22dfdbcd7f"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ $# -lt 1 ]; then
  echo "usage: scripts/tla.sh <model> [TLC arguments...]" >&2
  echo "models: $(cd "$root/tla" && ls -d */ 2>/dev/null | tr -d / | tr '\n' ' ')" >&2
  exit 2
fi
model="$1"
shift
dir="$root/tla/$model"
if [ ! -f "$dir/MC.tla" ] || [ ! -f "$dir/MC.cfg" ]; then
  echo "tla.sh: no model '$model' (need $dir/MC.tla and MC.cfg)" >&2
  exit 2
fi

cache="${XDG_CACHE_HOME:-$HOME/.cache}/operad/tla"
jar="$cache/tla2tools-$TLA_SHA256.jar"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

if [ ! -f "$jar" ] || [ "$(sha256_of "$jar")" != "$TLA_SHA256" ]; then
  mkdir -p "$cache"
  tmp="$(mktemp "$cache/download.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT
  echo "tla.sh: fetching $TLA_URL" >&2
  curl -fsSL --retry 3 -o "$tmp" "$TLA_URL"
  got="$(sha256_of "$tmp")"
  if [ "$got" != "$TLA_SHA256" ]; then
    echo "tla.sh: sha256 mismatch for tla2tools.jar: expected $TLA_SHA256, got $got; refusing to run" >&2
    exit 1
  fi
  mv "$tmp" "$jar"
  trap - EXIT
fi

# TLC writes its state files to a scratch directory, not into the repository.
states="$(mktemp -d "${TMPDIR:-/tmp}/operad-tla.XXXXXX")"
trap 'rm -rf "$states"' EXIT
cd "$dir"
java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -metadir "$states" -config MC.cfg -workers auto "$@" MC.tla
