/**
 * The fallback a subscription uses when no watch event arrives.
 *
 * A directory watch is the fast path, but it is not a promise: on macOS a
 * write that lands in a sqlite `-wal` file may produce no directory event at
 * all. Every open subscription therefore also re-reads storage on a timer, and
 * the poll compares a snapshot so it reports only runs that actually changed.
 */

import { watchDirectory } from "../watch.ts";
import type { LogBackendOptions } from "./types.ts";

/** How often an open subscription re-reads storage by default. */
export const DEFAULT_POLL_MS = 500;

export interface SubscriptionWatch {
  readonly pollMs: number;
  readonly repeat: (ms: number, callback: () => void) => () => void;
  readonly watch: (
    directory: string,
    onChange: (filename: string | null) => void,
  ) => () => void;
}

function repeatEvery(ms: number, callback: () => void): () => void {
  const timer = setInterval(callback, ms);
  // A subscription must not keep the process alive by itself.
  (timer as { unref?: () => void }).unref?.();
  return () => {
    clearInterval(timer);
  };
}

export function resolveSubscriptionWatch(
  options: LogBackendOptions,
): SubscriptionWatch {
  return {
    pollMs: options.pollMs ?? DEFAULT_POLL_MS,
    repeat: options.repeat ?? repeatEvery,
    watch: options.watch ?? watchDirectory,
  };
}
