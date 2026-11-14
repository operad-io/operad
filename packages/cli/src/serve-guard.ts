/**
 * What keeps `operad serve` up when a store is busy, and what it says when it
 * ends on an error anyway. A busy store is another process holding the write
 * lock past the busy timeout: it is never a reason to end the serve.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { isBusy } from "@operad-io/engine/platform";

/** Where the serve is, so an error says which operation it came from. */
let stage = "starting";

export function serveStage(next?: string): string {
  if (next !== undefined) stage = next;
  return stage;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A frame is operad's own when its path is in a source checkout (`/packages/`)
 * or in an installed operad package (`node_modules/@operad-io/`); other
 * dependencies and the runtime are not.
 */
function isOwnFrame(frame: string): boolean {
  // Windows paths use backslashes; the checks below read forward slashes.
  const line = frame.replaceAll("\\", "/");
  if (line.includes("node:") || line.includes("[native code]")) return false;
  if (line.includes("/node_modules/@operad-io/")) return true;
  if (line.includes("node_modules")) return false;
  return /\/(packages|plugins)\/|operad/.test(line);
}

/** The first frames of the stack that are operad's own code (not node_modules, not the runtime). */
export function ownFrames(error: unknown, limit = 5): string[] {
  if (!(error instanceof Error) || error.stack === undefined) return [];
  return error.stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at ") && isOwnFrame(line))
    .slice(0, limit);
}

/**
 * Writes the operation and the stack's first frames to `<home>/serve.log`, and
 * returns the one short line for the user.
 */
export function recordServeFailure(
  home: string,
  operation: string,
  error: unknown,
  now: () => number = () => Date.now(),
): string {
  const lines = [
    `${new Date(now()).toISOString()} serve: ${operation}: ${messageOf(error)}`,
    ...ownFrames(error).map((frame) => `    ${frame}`),
  ];
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause !== undefined) {
    lines.push(`  caused by: ${messageOf(cause)}`, ...ownFrames(cause).map((frame) => `    ${frame}`));
  }
  try {
    appendFileSync(join(home, "serve.log"), `${lines.join("\n")}\n`);
  } catch {
    // The user line below still says where it came from.
  }
  return `serve: ${operation}: ${messageOf(error)}`;
}

export interface BusyRetry {
  readonly log: (message: string) => void;
  /** Waits before the next try; the default waits one second. */
  readonly wait?: (() => Promise<void>) | undefined;
}

/**
 * Runs `operation`; a busy store is tried again, without end, because a serve
 * that is not running is worse than one that waits for the store.
 */
export async function retryWhileBusy<T>(
  operation: string,
  run: () => Promise<T>,
  options: BusyRetry,
): Promise<T> {
  const wait =
    options.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 1_000)));
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (!isBusy(error)) throw error;
      options.log(`serve: ${operation}: database is locked; trying again`);
    }
    await wait();
  }
}

/**
 * While the serve runs, a busy store that surfaces outside any pass (a
 * plugin's own timer, a source, a client request) is logged and the serve goes
 * on. Any other error ends the process as it did before, after it is recorded.
 * Returns what removes the handlers.
 */
export function guardBackgroundBusy(options: {
  readonly home: string;
  readonly log: (message: string) => void;
  readonly exit?: (code: number) => void;
  readonly target?: NodeJS.Process;
}): () => void {
  const target = options.target ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const handle = (error: unknown): void => {
    const operation = `${serveStage()} (background)`;
    if (isBusy(error)) {
      options.log(recordServeFailure(options.home, operation, error) + "; going on");
      return;
    }
    options.log(recordServeFailure(options.home, operation, error));
    exit(1);
  };
  target.on("unhandledRejection", handle);
  target.on("uncaughtException", handle);
  return () => {
    target.off("unhandledRejection", handle);
    target.off("uncaughtException", handle);
  };
}
