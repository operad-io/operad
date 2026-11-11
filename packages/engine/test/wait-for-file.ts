import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { waitForChange } from "../src/platform/watch.ts";

/**
 * Resolves when the file exists. The directory watch is the fast path; a look
 * every 100 ms besides, because a watch started a moment late misses the event
 * of a file created just before it was live, and nothing then wakes the wait.
 */
export async function waitForFile(path: string): Promise<void> {
  while (!existsSync(path)) {
    await waitForChange(dirname(path), basename(path), 100);
  }
}
