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

/** The repository's own limit: its name for the log, a key for the lock files. */
export interface RepositoryPlaces {
  readonly name: string;
  readonly path: string;
  readonly places: number;
}

/** Where a check takes its place and what it says while it waits. */
export interface CheckPlaces {
  readonly home: string;
  /** How many checks may run at once in the home. */
  readonly checks: number;
  /** The repository's limit, when `gate.places` sets one. */
  readonly repository?: RepositoryPlaces | undefined;
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

/** A pool that had no free place; `pool` says which, so the log can name it. */
class PlaceBusy extends Error {
  constructor(
    readonly pool: "home" | "repository",
    readonly inUse: number,
  ) {
    super("busy");
  }
}

/** The lock files of the repository's places, next to the home's. */
function repositoryKey(repository: RepositoryPlaces): string {
  const hash = new Bun.CryptoHasher("sha1").update(repository.path).digest("hex");
  const name = repository.name.replace(/[^A-Za-z0-9._-]/g, "_");
  return `repo-${name}-${hash.slice(0, 8)}`;
}

/** Takes one free place of a pool and runs `work`, or throws `PlaceBusy` at once. */
async function takeOne<T>(
  directory: string,
  prefix: string,
  count: number,
  pool: "home" | "repository",
  work: () => Promise<T> | T,
): Promise<T> {
  let busy = 0;
  for (let index = 1; index <= count; index += 1) {
    try {
      // A live holder makes the lock wait; waiting here means "taken".
      return await withLockFile(join(directory, `${prefix}-${index}.lock`), work, {
        label: "check place",
        onLog: () => {},
        wait: () => Promise.reject(new PlaceBusy(pool, 0)),
      });
    } catch (error) {
      if (!(error instanceof PlaceBusy) || error.pool !== pool) throw error;
      busy += 1;
    }
  }
  throw new PlaceBusy(pool, busy);
}

/**
 * Runs `work` holding a home place and, when the repository has a limit, a
 * repository place. Both are taken in one order, home first, and a check that
 * finds the second busy gives the first back before it waits, so it never
 * waits while it holds a place. Nothing times it out while it waits: the
 * check's own timeout starts when `work` does.
 */
export async function withCheckPlace<T>(
  places: CheckPlaces,
  work: () => Promise<T> | T,
): Promise<T> {
  const directory = checkPlacesDirectory(places.home);
  const repository = places.repository;
  let entry = "place-1.lock";
  const wait =
    places.wait ??
    ((ms: number) => waitForChange(directory, entry, ms));
  const inner =
    repository === undefined
      ? work
      : () =>
          takeOne(
            directory,
            repositoryKey(repository),
            repository.places,
            "repository",
            work,
          );
  let said: string | undefined;
  for (;;) {
    if (places.signal?.aborted === true) throw new CheckPlaceCancelled();
    try {
      return await takeOne(directory, "place", places.checks, "home", inner);
    } catch (error) {
      if (!(error instanceof PlaceBusy)) throw error;
      entry =
        error.pool === "repository" && repository !== undefined
          ? `${repositoryKey(repository)}-1.lock`
          : "place-1.lock";
      const line =
        error.pool === "home" || repository === undefined
          ? `waiting for a check place: ${error.inUse} in use`
          : `waiting for a check place of ${repository.name}: ${error.inUse} in use`;
      if (said !== line) {
        said = line;
        await places.log(line);
      }
    }
    await wait(RECHECK_MS);
  }
}

/** The places a step's checks take: the home's limit, the repository's, the step's own log. */
export function checkPlaces(
  ctx: StepContext,
  repository?: { readonly name: string; readonly path: string },
  repositoryLimit?: number,
): CheckPlaces {
  return {
    home: ctx.home,
    checks: checkPlacesOf(ctx.settings),
    repository:
      repository === undefined || repositoryLimit === undefined
        ? undefined
        : { name: repository.name, path: repository.path, places: repositoryLimit },
    log: (line) => ctx.logger.write(line),
    signal: ctx.signal,
  };
}
