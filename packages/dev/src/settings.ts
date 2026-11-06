/**
 * A repository's dev settings: `<repository>/.operad/dev.json`, checked against
 * the shipped `dev.schema.json`. The file is JSON; the schema is what editors
 * read, and this module applies the same rules when a step loads the file.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
  sep,
} from "node:path";
import { DevError, isRecord } from "./model.ts";

/** Where a repository keeps its dev settings. */
export const DEV_SETTINGS_FILE = ".operad/dev.json";

/** The default location of a repository's worker brief. */
export const WORKER_BRIEF_FILE = ".operad/worker-brief.md";

/** The harness step a repository uses when it names none. */
export const DEFAULT_WORKER_USE = "harness-radian/agent";

/** What a repository may configure for the worker harness step. */
export interface WorkerSettings {
  readonly use: string;
  readonly args: readonly string[];
  readonly wallTimeSecs?: number | undefined;
  readonly stallSecs?: number | undefined;
}

/** The whole `.operad/dev.json` document, with every default filled. */
export interface DevSettings {
  readonly name?: string | undefined;
  readonly remote: string;
  readonly mainBranch: string;
  readonly worktreeRoot: string;
  readonly worker: WorkerSettings;
  readonly workerBrief: string;
}

/**
 * The text a task's worker gets when the repository ships no brief of its own.
 * It says the four things every worker must know and nothing project-specific.
 */
export const DEFAULT_WORKER_BRIEF = [
  "Work only in this worktree. Do not change files outside it.",
  "Commit each whole piece of work as you finish it; leave the worktree clean.",
  "Before you finish, run the repository's verify command and make it pass.",
  "End with a summary of what you changed and what is left.",
].join("\n");

export const DEFAULT_DEV_SETTINGS: DevSettings = {
  remote: "origin",
  mainBranch: "main",
  worktreeRoot: ".operad-worktrees",
  worker: {
    use: DEFAULT_WORKER_USE,
    args: [],
  },
  workerBrief: WORKER_BRIEF_FILE,
};

const KNOWN_FIELDS = new Set([
  "$schema",
  "name",
  "remote",
  "mainBranch",
  "worktreeRoot",
  // Written by versions before the step work; `worktrees` is the old name of
  // `worktreeRoot`, `sandbox` is no longer used at all.
  "worktrees",
  "sandbox",
  "worker",
  "workerBrief",
]);

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DevError(field, "must be a non-empty string");
  }
  return value;
}

/**
 * A directory setting must stay inside the repository: an absolute path or one
 * that climbs out would put worktrees where `dev` does not own them.
 */
function repositoryRelativePath(value: unknown, field: string): string {
  const path = nonEmptyString(value, field);
  if (isAbsolute(path)) {
    throw new DevError(field, "must be relative to the repository");
  }
  const normalized = normalize(path);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new DevError(field, "must stay inside the repository");
  }
  return path;
}

/**
 * The real path of `path`, resolving the symlinks of every part that exists.
 * A tail that does not exist yet is appended unchanged, so the answer is where
 * creating it now would land.
 */
function realPathOf(path: string): string {
  const target = resolve(path);
  let current = target;
  const missing: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return target;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Refuses a path that resolves outside the repository. The lexical check in
 * `repositoryRelativePath` cannot see a symlink; this one follows every part
 * that exists, including a `worktreeRoot` that is a link to somewhere else.
 */
export function assertInsideRepository(
  repositoryPath: string,
  path: string,
  field: string,
): void {
  const repository = realPathOf(repositoryPath);
  const target = realPathOf(path);
  if (target !== repository && !target.startsWith(`${repository}${sep}`)) {
    throw new DevError(field, "must stay inside the repository");
  }
}

function positiveSeconds(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new DevError(field, "must be a positive number of seconds");
  }
  return value;
}

function stringList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new DevError(field, "must be an array of strings");
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new DevError(`${field}[${index}]`, "must be a string");
    }
    return item;
  });
}

function workerSettings(value: unknown, field: string): WorkerSettings {
  if (!isRecord(value)) {
    throw new DevError(field, "must be an object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "use" && key !== "args" && key !== "wallTimeSecs" && key !== "stallSecs") {
      throw new DevError(`${field}.${key}`, "is not a worker setting");
    }
  }
  const use =
    value.use === undefined
      ? DEFAULT_DEV_SETTINGS.worker.use
      : nonEmptyString(value.use, `${field}.use`);
  const args =
    value.args === undefined
      ? []
      : stringList(value.args, `${field}.args`);
  const wallTimeSecs =
    value.wallTimeSecs === undefined
      ? undefined
      : positiveSeconds(value.wallTimeSecs, `${field}.wallTimeSecs`);
  const stallSecs =
    value.stallSecs === undefined
      ? undefined
      : positiveSeconds(value.stallSecs, `${field}.stallSecs`);
  return {
    use,
    args,
    ...(wallTimeSecs === undefined ? {} : { wallTimeSecs }),
    ...(stallSecs === undefined ? {} : { stallSecs }),
  };
}

/**
 * The root task worktrees live in. Settings written before the step work used
 * `worktrees`; it is read as the same setting so an upgrade needs no edit.
 */
function worktreeRootOf(value: Record<string, unknown>): {
  readonly root: string;
  readonly field: string;
} {
  if (value.worktreeRoot !== undefined) {
    return {
      root: repositoryRelativePath(value.worktreeRoot, "worktreeRoot"),
      field: "worktreeRoot",
    };
  }
  if (value.worktrees !== undefined) {
    return {
      root: repositoryRelativePath(value.worktrees, "worktrees"),
      field: "worktrees",
    };
  }
  return { root: DEFAULT_DEV_SETTINGS.worktreeRoot, field: "worktreeRoot" };
}

/** Validates one parsed dev.json value and fills the defaults. */
export function validateDevSettings(value: unknown): DevSettings {
  if (!isRecord(value)) {
    throw new DevError("dev.json", "must be a JSON object");
  }
  for (const key of Object.keys(value)) {
    if (!KNOWN_FIELDS.has(key)) {
      throw new DevError(key, "is not a dev setting");
    }
  }
  const worktreeRoot = worktreeRootOf(value);
  return {
    ...(value.name === undefined
      ? {}
      : { name: nonEmptyString(value.name, "name") }),
    remote:
      value.remote === undefined
        ? DEFAULT_DEV_SETTINGS.remote
        : nonEmptyString(value.remote, "remote"),
    mainBranch:
      value.mainBranch === undefined
        ? DEFAULT_DEV_SETTINGS.mainBranch
        : nonEmptyString(value.mainBranch, "mainBranch"),
    worktreeRoot: worktreeRoot.root,
    worker:
      value.worker === undefined
        ? DEFAULT_DEV_SETTINGS.worker
        : workerSettings(value.worker, "worker"),
    workerBrief:
      value.workerBrief === undefined
        ? DEFAULT_DEV_SETTINGS.workerBrief
        : nonEmptyString(value.workerBrief, "workerBrief"),
  };
}

/**
 * Reads a repository's settings. A missing file means the defaults, so a work
 * tree that `operad repo add` has not written yet still runs.
 */
export async function readDevSettings(
  repositoryPath: string,
): Promise<DevSettings> {
  const path = join(repositoryPath, DEV_SETTINGS_FILE);
  if (!existsSync(path)) {
    assertInsideRepository(
      repositoryPath,
      resolve(repositoryPath, DEFAULT_DEV_SETTINGS.worktreeRoot),
      "worktreeRoot",
    );
    return DEFAULT_DEV_SETTINGS;
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new DevError("dev.json", `cannot read ${path}: ${String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new DevError("dev.json", `invalid JSON in ${path}: ${String(error)}`);
  }
  const settings = validateDevSettings(parsed);
  const field =
    isRecord(parsed) &&
    parsed.worktreeRoot === undefined &&
    parsed.worktrees !== undefined
      ? "worktrees"
      : "worktreeRoot";
  assertInsideRepository(
    repositoryPath,
    resolve(repositoryPath, settings.worktreeRoot),
    field,
  );
  return settings;
}

/** An alias for callers that name the file rather than the plugin. */
export const readRepositorySettings = readDevSettings;

/** The absolute path of the brief a worker reads, whether it exists or not. */
export function workerBriefPath(
  repositoryPath: string,
  settings: DevSettings,
): string {
  return isAbsolute(settings.workerBrief)
    ? settings.workerBrief
    : resolve(repositoryPath, settings.workerBrief);
}

/**
 * The worker brief: the repository's own file when it has one, otherwise the
 * built-in text. A path that points at nothing is not an error; the repository
 * simply wanted the default.
 */
export async function readWorkerBrief(
  repositoryPath: string,
  settings: DevSettings,
): Promise<string> {
  const path = workerBriefPath(repositoryPath, settings);
  if (!existsSync(path)) return DEFAULT_WORKER_BRIEF;
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new DevError("workerBrief", `cannot read ${path}: ${String(error)}`);
  }
}
