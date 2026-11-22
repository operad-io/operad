#!/bin/sh
# Build a static musl radian binary for the Terminal-Bench task containers.
#
# The host glibc (2.43) does not fit the task images (`python:3.13-slim`,
# `ubuntu:24.04`, debian slim); a static-pie musl binary runs in all of them.
# Prints the binary path and its sha256, and refuses a dynamically linked
# result. Cached in ~/.cache/radian-musl so reruns are fast. The radian
# checkout is named by RADIAN_CHECKOUT; there is no default.
set -eu

if [ -z "${RADIAN_CHECKOUT:-}" ]; then
  echo "build-static.sh: no radian checkout; set RADIAN_CHECKOUT" >&2
  exit 1
fi
if [ ! -d "$RADIAN_CHECKOUT" ]; then
  echo "build-static.sh: no radian checkout at $RADIAN_CHECKOUT; set RADIAN_CHECKOUT" >&2
  exit 1
fi

CACHE_DIR="${RADIAN_MUSL_CACHE:-$HOME/.cache/radian-musl}"
BIN="$CACHE_DIR/target/release/radian"

mkdir -p "$CACHE_DIR/registry" "$CACHE_DIR/target"
docker run --rm \
  -e CARGO_HOME=/cargo \
  -v "$CACHE_DIR/registry:/cargo" \
  -v "$CACHE_DIR/target:/target" \
  -e CARGO_TARGET_DIR=/target \
  -v "$RADIAN_CHECKOUT:/src:ro" \
  -w /src \
  rust:1-alpine sh -c \
  "apk add -q musl-dev cmake make perl clang linux-headers >/dev/null && \
   cargo build --locked --release -p radian-tui --bin radian && \
   chown -R $(id -u):$(id -g) /target /cargo"

echo "binary: $BIN"
sha256sum "$BIN" | tee "$BIN.sha256"
file "$BIN"
file "$BIN" | grep -q "static.*linked" || {
  echo "build-static.sh: refusing binary that is not statically linked" >&2
  exit 1
}
