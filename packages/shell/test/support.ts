import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { waitForChange } from "@operad-io/engine/platform";

export {
  alive,
  cleanupTempRoots,
  manualClock,
  signalable,
  tempRoot,
  waitForFile,
  waitForGone,
  waitForPid,
  type ManualClock,
} from "@operad-io/engine/testing";

/**
 * How long a wait for a file sleeps between two looks when no directory event
 * comes. A directory watch can miss a file made while it was starting, so the
 * wait never relies on the event alone (see `waitForChange`).
 */
const LOOK_MS = 100;

/** Resolves when the file holds `text`. Event first; a look every `LOOK_MS` besides. */
export async function waitForText(path: string, text: string): Promise<void> {
  for (;;) {
    try {
      if (readFileSync(path, "utf8").includes(text)) return;
    } catch {
      // Not there yet.
    }
    await waitForChange(dirname(path), basename(path), LOOK_MS);
  }
}
