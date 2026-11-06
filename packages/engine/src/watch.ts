/**
 * A directory watcher for cross-process notifications. A store or log writes
 * its files in one directory; watching that directory reports changes another
 * process makes, which a process-local listener set cannot see.
 */

import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";

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
