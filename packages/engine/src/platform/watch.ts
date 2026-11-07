/**
 * Watching a directory for changes another process makes, with a fallback.
 *
 * A store or log writes its files in one directory; watching that directory
 * reports changes another process makes, which a process-local listener set
 * cannot see. A watch is the fast path, not a promise: on macOS a write that
 * lands in a sqlite `-wal` file may produce no directory event at all. Every
 * owner therefore pairs the watch with a check on a timer. The timer comes from
 * an injected clock so a test never waits for real time.
 */

import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { basename } from "node:path";

/**
 * Calls `onChange` when anything in `directory` changes, with the entry name
 * when the platform reports one. Returns a stop function; watching a missing
 * directory does nothing and still returns a stop function.
 */
export function watchDirectory(
  directory: string,
  onChange: (filename: string | null) => void,
): () => void {
  let watcher: FSWatcher;
  try {
    watcher = watch(directory, { persistent: true }, (_event, filename) => {
      onChange(filename === undefined ? null : String(filename));
    });
  } catch {
    return () => undefined;
  }
  watcher.on("error", () => {
    // A watcher that loses its directory stops notifying. Reads still refresh
    // on demand, so this is not a reason to fail the owner.
  });
  return () => {
    watcher.close();
  };
}

/** How often an open subscription re-reads storage by default. */
export const DEFAULT_POLL_MS = 500;

/** The watch, the fallback timer and its period one subscription uses. */
export interface SubscriptionWatch {
  readonly pollMs: number;
  readonly repeat: (ms: number, callback: () => void) => () => void;
  readonly watch: (
    directory: string,
    onChange: (filename: string | null) => void,
  ) => () => void;
}

/** What an owner lets a test replace: the period, the timer and the watch. */
export interface SubscriptionWatchOptions {
  readonly pollMs?: number | undefined;
  readonly repeat?: ((ms: number, callback: () => void) => () => void) | undefined;
  readonly watch?:
    | ((
        directory: string,
        onChange: (filename: string | null) => void,
      ) => () => void)
    | undefined;
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
  options: SubscriptionWatchOptions,
): SubscriptionWatch {
  return {
    pollMs: options.pollMs ?? DEFAULT_POLL_MS,
    repeat: options.repeat ?? repeatEvery,
    watch: options.watch ?? watchDirectory,
  };
}

/**
 * Test-only: the directory watches and fallback timers `waitForChange` holds
 * open. Production code never reads this; a suite asserts it is zero at the
 * end, so a wait that forgets to close its handles fails.
 */
export const openWaitHandles = { watchers: 0, timers: 0 };

/** Test-only: the number of wait handles still open. */
export function openWaitHandleCount(): number {
  return openWaitHandles.watchers + openWaitHandles.timers;
}

/**
 * Waits until `entry` (or an unnamed entry) changes in `directory`, or for one
 * fallback interval of `ms`, whichever comes first. A rename replaces the file
 * itself, so the directory is watched, not the file.
 */
export function waitForChange(
  directory: string,
  entry: string,
  ms: number,
): Promise<void> {
  return new Promise((done) => {
    let watcher: FSWatcher | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (watcher !== undefined) {
        openWaitHandles.watchers -= 1;
        watcher.close();
      }
      if (timer !== undefined) {
        openWaitHandles.timers -= 1;
        clearTimeout(timer);
      }
      done();
    };
    timer = setTimeout(finish, Math.max(1, ms));
    openWaitHandles.timers += 1;
    try {
      watcher = watch(directory, (_event, filename) => {
        if (filename === null || filename === basename(entry)) finish();
      });
      openWaitHandles.watchers += 1;
      watcher.on("error", finish);
    } catch {
      // The timer is the fallback when watching is unavailable.
    }
  });
}
