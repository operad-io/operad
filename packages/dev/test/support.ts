/** Scratch directories and git repositories for the dev tests. */

import { afterEach, expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { GIT_TIMEOUT_MS, GitTimeoutError } from "../src/git.ts";
import {
  SqlitePluginStore,
  objectValueAfter,
  type ObjectStore,
  type PluginFact,
  type StoredObject,
} from "@operad-io/engine";
import { openWaitHandleCount as openLockHandleCount } from "@operad-io/engine/platform";
import {
  appendRework,
  listAll,
  splitBrief,
  taskData,
  type TaskPhase,
} from "../src/model.ts";
import {
  changeTaskPhase,
  getTask,
  putTaskKeepingPlanCost,
  withRepoLock,
} from "../src/service.ts";

export {
  alive,
  cleanupTempRoots,
  osTempRoot,
  tempRoot,
  waitForFile,
  waitForGone,
  waitForPid,
  waitUntil,
} from "@operad-io/engine/testing";

// A test that reads settings must never keep a copy in the real home.
if (process.env.OPERAD_HOME === undefined) {
  process.env.OPERAD_HOME = join(realpathSync(tmpdir()), `operad-dev-test-home-${process.pid}`);
}

function git(cwd: string, args: readonly string[]): void {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdout: "pipe",
    stderr: "pipe",
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (result.exitedDueToTimeout === true) {
    throw new GitTimeoutError(cwd, args, GIT_TIMEOUT_MS);
  }
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
}

/** A git work tree with an origin remote. */
export async function makeGitRepository(
  parent: string,
  name = "repository",
): Promise<string> {
  const path = join(parent, name);
  await mkdir(path, { recursive: true });
  git(path, ["init", "-q"]);
  git(path, ["remote", "add", "origin", "https://example.com/repo.git"]);
  await writeFile(join(path, "README.md"), "# test\n");
  git(path, ["add", "README.md"]);
  git(path, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "start"]);
  return path;
}

export function storeAt(path: string): SqlitePluginStore {
  return new SqlitePluginStore({ root: join(path, "store") });
}

/** The Markdown of the rework sections, for a test that reads a brief. */
export function reworkBody(brief: string): string {
  return splitBrief(brief).reworks;
}

/** The Markdown of the trailing changes section, for a test that reads a brief. */
export function changesBody(brief: string): string {
  return splitBrief(brief).changes;
}

/** Moves a task to a phase, as a run's own write would; a test helper. */
export async function setTaskPhase(
  store: ObjectStore,
  id: string,
  phase: TaskPhase,
  options: { readonly run?: string | null | undefined } = {},
): Promise<StoredObject> {
  const written = await changeTaskPhase(store, id, undefined, phase, options);
  if (written === undefined) throw new Error(`no task "${id}"`);
  return written;
}

/** Appends a rework section to a task, as the dev action does; a test helper. */
export async function addRework(
  store: ObjectStore,
  id: string,
  source: string,
  text: string,
): Promise<StoredObject> {
  const initial = await getTask(store, id);
  const data = taskData(initial.data);
  return withRepoLock(store, data.repository, async () => {
    const current = await getTask(store, id);
    const latest = taskData(current.data);
    return putTaskKeepingPlanCost(
      store,
      id,
      { ...latest, brief: appendRework(latest.brief, source, text) },
      "dev:task-rework",
    );
  });
}

/** Rebuilds the objects a store's facts describe, in append order; a test helper. */
export function rebuildObjects(
  facts: readonly PluginFact[],
): Map<string, Record<string, unknown>> {
  const objects = new Map<string, Record<string, unknown>>();
  for (const fact of facts) {
    const object = fact.object;
    if (object === undefined) continue;
    const key = `${object.type}:${object.id}`;
    const value = objectValueAfter(fact, objects.get(key) ?? {});
    if (value !== undefined) objects.set(key, { ...value });
  }
  return objects;
}

/** The live object data, keyed the way `rebuildObjects` keys it; a test helper. */
export async function liveObjects(
  store: ObjectStore,
): Promise<Map<string, Record<string, unknown>>> {
  const objects = new Map<string, Record<string, unknown>>();
  for (const type of ["repo", "plan", "task"]) {
    for (const object of await listAll(store, type)) {
      objects.set(`${type}:${object.id}`, { ...object.data });
    }
  }
  return objects;
}

/**
 * Every dev test file calls this. It checks after each of that file's tests
 * that no directory watch or fallback timer is still open, so a leak fails
 * in the file that caused it. One "last" test cannot see a leak from a file Bun
 * happens to run later. Test-only: the platform module exports the counter for this.
 */
export function guardLockHandles(): void {
  afterEach(() => {
    expect(openLockHandleCount()).toBe(0);
  });
}

/** The CLI's own entry point, loaded by path: the dev package does not build against the cli package. */
interface CliMain {
  main(
    args: readonly string[],
    options: {
      home: string;
      io: { write(text: string): void; error(text: string): void };
      isTTY: boolean;
    },
  ): Promise<number>;
}
const CLI_MAIN = fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url));

export interface RunResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

let inProcess: Promise<unknown> = Promise.resolve();

/**
 * Runs a command in this process: the CLI's own `main` with collected output,
 * the working directory, standard input (empty unless given) and environment
 * set around it. One command at a time, because the working directory, stdin
 * and environment belong to the process; commands a test starts together run
 * in turn.
 */
export function runInProcess(
  home: string,
  cwd: string,
  args: readonly string[],
  input?: string | Readable,
  env: Record<string, string> = {},
): Promise<RunResult> {
  const turn = inProcess.then(() => runInProcessNow(home, cwd, args, input, env));
  inProcess = turn.catch(() => undefined);
  return turn;
}

async function runInProcessNow(
  home: string,
  cwd: string,
  args: readonly string[],
  input: string | Readable | undefined,
  env: Record<string, string>,
): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  process.chdir(cwd);
  Object.assign(process.env, { OPERAD_HOME: home }, env);
  Object.defineProperty(process, "stdin", {
    configurable: true,
    value:
      input instanceof Readable
        ? input
        : Readable.from(input === undefined ? [] : [Buffer.from(input)]),
  });
  try {
    const { main } = (await import(CLI_MAIN)) as CliMain;
    const code = await main([...args], {
      home,
      io: { write: (text) => out.push(text), error: (text) => err.push(text) },
      isTTY: false,
    });
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    if (stdinDescriptor !== undefined) {
      Object.defineProperty(process, "stdin", stdinDescriptor);
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
    process.chdir(previousCwd);
  }
}
