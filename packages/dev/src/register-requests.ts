/**
 * Repositories that an approved Setup Dev asks `dev` to register (ADR 0030
 * D15). The `bot` plugin leaves one file per request in `<home>/dev-register/`
 * because `dev` may not be loaded when the proposal is approved; `dev` reads
 * the directory on every tick, registers each repository as `operad dev repo
 * add` does and removes the file. A request that cannot be registered stays,
 * with the reason written into it, and is shown as a pending item until it is
 * fixed or removed.
 *
 * A request with `"kind": "setup-git"` (ADR 0039 D8) asks for git to be set up in
 * a folder instead: it carries the `.gitignore` text, the approved paths and,
 * when git has none, the name and email (see `setup-git.ts`). It is run the
 * same way and a failure stays in the file the same way.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, messageOf, type ObjectStore, type StandingItem } from "@operad-io/engine";
import { addRepository } from "./service.ts";
import { applySetupGit, type SetupGitRequest } from "./setup-git.ts";

/** The directory under the home that holds the requests. */
export function registerRequestsDirectory(home: string): string {
  return join(home, "dev-register");
}

interface Request {
  readonly file: string;
  readonly path: string;
  readonly error: string | undefined;
  /** The whole file, kept when a failure is written back. */
  readonly body: Record<string, unknown>;
  /** Set for a request to set up git. */
  readonly setupGit: SetupGitRequest | undefined;
}

function setupGitOf(body: Record<string, unknown>, path: string): SetupGitRequest | undefined {
  if (body.kind !== "setup-git") return undefined;
  const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === "string") : [];
  const identity = isRecord(body.identity) ? body.identity : undefined;
  return {
    path,
    gitignore: typeof body.gitignore === "string" ? body.gitignore : "",
    paths,
    ...(identity !== undefined && typeof identity.name === "string" && typeof identity.email === "string"
      ? { identity: { name: identity.name, email: identity.email } }
      : {}),
  };
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
        body: parsed,
        setupGit: setupGitOf(parsed, parsed.path),
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
      if (request.setupGit !== undefined) {
        await applySetupGit(request.setupGit, { lock: { home: ctx.home } });
      } else {
        await addRepository(ctx.store, { path: request.path, cwd: ctx.cwd });
      }
      rmSync(request.file, { force: true });
    } catch (error) {
      const message = messageOf(error);
      if (message.includes("is already registered")) {
        rmSync(request.file, { force: true });
        continue;
      }
      if (message !== request.error) {
        const body = request.setupGit === undefined ? { path: request.path } : request.body;
        writeFileSync(request.file, `${JSON.stringify({ ...body, error: message })}\n`);
      }
    }
  }
}

/** The pending items of requests that could not be registered. */
export function registerStanding(home: string): readonly StandingItem[] {
  return readRequests(home)
    .filter((request) => request.error !== undefined)
    .map((request) => ({
      id: `${request.setupGit === undefined ? "register" : "setup-git"}:${request.path}`,
      prompt:
        request.setupGit === undefined
          ? `the repository ${request.path} could not be registered: ${request.error ?? ""}; fix it and it is registered on its own, or remove ${request.file}`
          : `git could not be set up in ${request.path}: ${request.error ?? ""}; fix it and it is tried again on its own, or remove ${request.file}`,
    }));
}
