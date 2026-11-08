/**
 * Check places: at most `checks` checks run at once in one operad home, across
 * every repository, plan and process. Each place is a lock file made by the
 * platform's `withLockFile`, so a holder that dies gives its place back the way
 * every platform lock does: the next taker sees the dead pid and takes over.
 */

import { join } from "node:path";
import type { StepContext } from "@operad-io/engine";
import { withLockFile, waitForChange } from "@operad-io/engine/platform";

/** How many checks may run at once when the home's dev settings say nothing. */
export const DEFAULT_CHECK_PLACES = 2;

/** How often a waiting check looks again when no release was announced. */
const RECHECK_MS = 500;

/** Where the places of one operad home live. */
export function checkPlacesDirectory(home: string): string {
  return join(home, "dev", "check-places");
}

/** Reads `checks` from the plugin's settings; unset means the default. */
export function checkPlacesOf(
  settings: Readonly<Record<string, unknown>>,
): number {
  const value = settings.checks;
  if (value === undefined) return DEFAULT_CHECK_PLACES;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("dev settings: checks must be a positive integer");
  }
  return value;
}

/** Where a check takes its place and what it says while it waits. */
export interface CheckPlaces {
  readonly home: string;
  /** How many checks may run at once. */
  readonly checks: number;
  /** Writes a line to the step's log. */
  readonly log: (line: string) => Promise<unknown> | unknown;
  readonly signal?: AbortSignal | undefined;
  /** How a waiting check waits before it looks again; tests inject this. */
  readonly wait?: ((ms: number) => Promise<void>) | undefined;
}

/** Thrown when the step is cancelled while it waits for a place. */
export class CheckPlaceCancelled extends Error {
  constructor() {
    super("cancelled while waiting for a check place");
    this.name = "CheckPlaceCancelled";
  }
}

class PlaceBusy extends Error {}

/**
 * Runs `work` holding one place. A check waiting for a place says so once per
 * change in how many are in use, and nothing times it out while it waits: the
 * check's own timeout starts when `work` does.
 */
export async function withCheckPlace<T>(
  places: CheckPlaces,
  work: () => Promise<T> | T,
): Promise<T> {
  const directory = checkPlacesDirectory(places.home);
  const slots = Array.from({ length: places.checks }, (_, index) =>
    join(directory, `place-${index + 1}.lock`),
  );
  const wait =
    places.wait ??
    ((ms: number) => waitForChange(directory, "place-1.lock", ms));
  let said: number | undefined;
  for (;;) {
    if (places.signal?.aborted === true) throw new CheckPlaceCancelled();
    let busy = 0;
    for (const slot of slots) {
      try {
        // A live holder makes the lock wait; waiting here means "taken".
        return await withLockFile(slot, work, {
          label: "check place",
          onLog: () => {},
          wait: () => Promise.reject(new PlaceBusy()),
        });
      } catch (error) {
        if (!(error instanceof PlaceBusy)) throw error;
        busy += 1;
      }
    }
    if (said !== busy) {
      said = busy;
      await places.log(`waiting for a check place: ${busy} in use`);
    }
    await wait(RECHECK_MS);
  }
}

/** The places a step's checks take: the home's limit, the step's own log. */
export function checkPlaces(ctx: StepContext): CheckPlaces {
  return {
    home: ctx.home,
    checks: checkPlacesOf(ctx.settings),
    log: (line) => ctx.logger.write(line),
    signal: ctx.signal,
  };
}
