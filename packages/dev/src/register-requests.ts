/**
 * Repositories that an approved Setup Dev asks `dev` to register (ADR 0030
 * D15). The `bot` plugin leaves one file per request in `<home>/dev-register/`
 * because `dev` may not be loaded when the proposal is approved; `dev` reads
 * the directory on every tick, registers each repository as `operad dev repo
 * add` does and removes the file. A request that cannot be registered stays,
 * with the reason written into it, and is shown as a pending item until it is
 * fixed or removed.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, messageOf, type ObjectStore, type StandingItem } from "@operad-io/engine";
import { addRepository } from "./service.ts";

/** The directory under the home that holds the requests. */
export function registerRequestsDirectory(home: string): string {
  return join(home, "dev-register");
}

interface Request {
  readonly file: string;
  readonly path: string;
  readonly error: string | undefined;
}

function readRequests(home: string): Request[] {
  const directory = registerRequestsDirectory(home);
  if (!existsSync(directory)) return [];
  const found: Request[] = [];
  let names: string[];
  try {
    names = readdirSync(directory).sort();
  } catch {
    // An unreadable directory holds no requests; it must not stop the tick.
    return found;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(directory, name);
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!isRecord(parsed) || typeof parsed.path !== "string") continue;
      found.push({
        file,
        path: parsed.path,
        error: typeof parsed.error === "string" ? parsed.error : undefined,
      });
    } catch {
      // A file that is not written yet or is not a request is left alone.
    }
  }
  return found;
}

/** Registers every requested repository; a failure stays in its file. */
export async function registerRequested(ctx: {
  readonly home: string;
  readonly cwd: string;
  readonly store: ObjectStore;
}): Promise<void> {
  for (const request of readRequests(ctx.home)) {
    try {
      await addRepository(ctx.store, { path: request.path, cwd: ctx.cwd });
      rmSync(request.file, { force: true });
    } catch (error) {
      const message = messageOf(error);
      if (message.includes("is already registered")) {
        rmSync(request.file, { force: true });
        continue;
      }
      if (message !== request.error) {
        writeFileSync(request.file, `${JSON.stringify({ path: request.path, error: message })}\n`);
      }
    }
  }
}

/** The pending items of requests that could not be registered. */
export function registerStanding(home: string): readonly StandingItem[] {
  return readRequests(home)
    .filter((request) => request.error !== undefined)
    .map((request) => ({
      id: `register:${request.path}`,
      prompt: `the repository ${request.path} could not be registered: ${request.error ?? ""}; fix it and it is registered on its own, or remove ${request.file}`,
    }));
}
