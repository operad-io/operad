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

/** How serious a review finding must be before it fails the gate. */
export type FixLevel = "critical" | "major" | "minor";

/** The commands a task's gate runs and how long each may take. */
export interface GateSettings {
  readonly commands: readonly string[];
  readonly commandTimeoutSecs: number;
}

/** How the integrate step lands a verified commit on main. */
export type IntegrationStyle = "merge" | "squash";

/** How the integrate step builds and lands a candidate on main. */
export interface IntegrationSettings {
  readonly style: IntegrationStyle;
  /** Commands that must pass on the candidate before it is pushed. */
  readonly keyCommands: readonly string[];
}

/** Commands the cleanup step runs after a merge. */
export interface HookSettings {
  readonly afterMerge: readonly string[];
}

/** What a repository may configure for the review harness step. */
export interface ReviewerSettings {
  readonly use: string;
  readonly args: readonly string[];
  /** The arguments of the first review of an attempt, when they differ. */
  readonly firstArgs?: readonly string[] | undefined;
  readonly timeoutSecs: number;
  /** How long a review may print nothing; unset uses the harness default. */
  readonly stallSecs?: number | undefined;
  readonly fixLevel: FixLevel;
  /** The largest diff one file may put in the review prompt. */
  readonly maxFileDiffBytes: number;
  /** The largest diff the whole review prompt may carry. */
  readonly maxDiffBytes: number;
}

/** The whole `.operad/dev.json` document, with every default filled. */
export interface DevSettings {
  readonly name?: string | undefined;
  readonly remote: string;
  readonly mainBranch: string;
  readonly worktreeRoot: string;
  /** How many tasks this repository may run at once. */
  readonly concurrency: number;
  readonly worker: WorkerSettings;
  readonly workerBrief: string;
  readonly gate: GateSettings;
  readonly reviewer: ReviewerSettings;
  readonly integration: IntegrationSettings;
  readonly hooks: HookSettings;
  readonly maxAutoRework: number;
}

/**
 * The commands cleanup runs when a repository sets none. They remove the task
 * and gate worktrees, prune a worktree that was removed by hand, and delete the
 * task's local and remote branch. The step records a failure and keeps going.
 */
export const DEFAULT_AFTER_MERGE: readonly string[] = [
  'git worktree remove --force "$OPERAD_WORKTREE"',
  'git worktree remove --force "$OPERAD_WORKTREE-gate"',
  "git worktree prune",
  'git branch -D "work/$OPERAD_TASK"',
  'git push "$OPERAD_REMOTE" --delete "work/$OPERAD_TASK"',
];

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
  concurrency: 1,
  worker: {
    use: DEFAULT_WORKER_USE,
    args: [],
  },
  workerBrief: WORKER_BRIEF_FILE,
  gate: {
    commands: [],
    commandTimeoutSecs: 1800,
  },
  reviewer: {
    use: DEFAULT_WORKER_USE,
    args: [],
    timeoutSecs: 600,
    fixLevel: "major",
    maxFileDiffBytes: 200_000,
    maxDiffBytes: 1_000_000,
  },
  integration: {
    style: "merge",
    keyCommands: [],
  },
  hooks: {
    afterMerge: DEFAULT_AFTER_MERGE,
  },
  maxAutoRework: 2,
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
  "concurrency",
  "worker",
  "workerBrief",
  "gate",
  "reviewer",
  "integration",
  "hooks",
  "maxAutoRework",
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

function positiveInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new DevError(field, "must be a positive integer");
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new DevError(field, "must be zero or a positive integer");
  }
  return value;
}

function commandList(value: unknown, field: string): readonly string[] {
  const commands = stringList(value, field);
  commands.forEach((command, index) => {
    if (command.trim().length === 0) {
      throw new DevError(`${field}[${index}]`, "must be a non-empty string");
    }
  });
  return commands;
}

function gateSettings(value: unknown, field: string): GateSettings {
  if (!isRecord(value)) {
    throw new DevError(field, "must be an object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "commands" && key !== "commandTimeoutSecs") {
      throw new DevError(`${field}.${key}`, "is not a gate setting");
    }
  }
  return {
    commands:
      value.commands === undefined
        ? DEFAULT_DEV_SETTINGS.gate.commands
        : commandList(value.commands, `${field}.commands`),
    commandTimeoutSecs:
      value.commandTimeoutSecs === undefined
        ? DEFAULT_DEV_SETTINGS.gate.commandTimeoutSecs
        : positiveSeconds(value.commandTimeoutSecs, `${field}.commandTimeoutSecs`),
  };
}

function fixLevelOf(value: unknown, field: string): FixLevel {
  if (value === undefined) return DEFAULT_DEV_SETTINGS.reviewer.fixLevel;
  if (value !== "critical" && value !== "major" && value !== "minor") {
    throw new DevError(field, 'must be "critical", "major" or "minor"');
  }
  return value;
}

function reviewerSettings(value: unknown, field: string): ReviewerSettings {
  if (!isRecord(value)) {
    throw new DevError(field, "must be an object");
  }
  for (const key of Object.keys(value)) {
    if (
      key !== "use" &&
      key !== "args" &&
      key !== "firstArgs" &&
      key !== "timeoutSecs" &&
      key !== "stallSecs" &&
      key !== "fixLevel" &&
      key !== "maxFileDiffBytes" &&
      key !== "maxDiffBytes"
    ) {
      throw new DevError(`${field}.${key}`, "is not a reviewer setting");
    }
  }
  const firstArgs =
    value.firstArgs === undefined
      ? undefined
      : stringList(value.firstArgs, `${field}.firstArgs`);
  return {
    use:
      value.use === undefined
        ? DEFAULT_DEV_SETTINGS.reviewer.use
        : nonEmptyString(value.use, `${field}.use`),
    args:
      value.args === undefined
        ? []
        : stringList(value.args, `${field}.args`),
    ...(firstArgs === undefined ? {} : { firstArgs }),
    timeoutSecs:
      value.timeoutSecs === undefined
        ? DEFAULT_DEV_SETTINGS.reviewer.timeoutSecs
        : positiveSeconds(value.timeoutSecs, `${field}.timeoutSecs`),
    ...(value.stallSecs === undefined
      ? {}
      : { stallSecs: positiveSeconds(value.stallSecs, `${field}.stallSecs`) }),
    fixLevel: fixLevelOf(value.fixLevel, `${field}.fixLevel`),
    maxFileDiffBytes:
      value.maxFileDiffBytes === undefined
        ? DEFAULT_DEV_SETTINGS.reviewer.maxFileDiffBytes
        : positiveInteger(value.maxFileDiffBytes, `${field}.maxFileDiffBytes`),
    maxDiffBytes:
      value.maxDiffBytes === undefined
        ? DEFAULT_DEV_SETTINGS.reviewer.maxDiffBytes
        : positiveInteger(value.maxDiffBytes, `${field}.maxDiffBytes`),
  };
}

function integrationStyle(value: unknown, field: string): IntegrationStyle {
  if (value === undefined) return DEFAULT_DEV_SETTINGS.integration.style;
  if (value !== "merge" && value !== "squash") {
    throw new DevError(field, 'must be "merge" or "squash"');
  }
  return value;
}

function integrationSettings(value: unknown, field: string): IntegrationSettings {
  if (!isRecord(value)) {
    throw new DevError(field, "must be an object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "style" && key !== "keyCommands") {
      throw new DevError(`${field}.${key}`, "is not an integration setting");
    }
  }
  return {
    style: integrationStyle(value.style, `${field}.style`),
    keyCommands:
      value.keyCommands === undefined
        ? DEFAULT_DEV_SETTINGS.integration.keyCommands
        : commandList(value.keyCommands, `${field}.keyCommands`),
  };
}

function hookSettings(value: unknown, field: string): HookSettings {
  if (!isRecord(value)) {
    throw new DevError(field, "must be an object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "afterMerge") {
      throw new DevError(`${field}.${key}`, "is not a hook setting");
    }
  }
  return {
    afterMerge:
      value.afterMerge === undefined
        ? DEFAULT_DEV_SETTINGS.hooks.afterMerge
        : commandList(value.afterMerge, `${field}.afterMerge`),
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
    concurrency:
      value.concurrency === undefined
        ? DEFAULT_DEV_SETTINGS.concurrency
        : positiveInteger(value.concurrency, "concurrency"),
    worker:
      value.worker === undefined
        ? DEFAULT_DEV_SETTINGS.worker
        : workerSettings(value.worker, "worker"),
    workerBrief:
      value.workerBrief === undefined
        ? DEFAULT_DEV_SETTINGS.workerBrief
        : nonEmptyString(value.workerBrief, "workerBrief"),
    gate:
      value.gate === undefined
        ? DEFAULT_DEV_SETTINGS.gate
        : gateSettings(value.gate, "gate"),
    reviewer:
      value.reviewer === undefined
        ? DEFAULT_DEV_SETTINGS.reviewer
        : reviewerSettings(value.reviewer, "reviewer"),
    integration:
      value.integration === undefined
        ? DEFAULT_DEV_SETTINGS.integration
        : integrationSettings(value.integration, "integration"),
    hooks:
      value.hooks === undefined
        ? DEFAULT_DEV_SETTINGS.hooks
        : hookSettings(value.hooks, "hooks"),
    maxAutoRework:
      value.maxAutoRework === undefined
        ? DEFAULT_DEV_SETTINGS.maxAutoRework
        : nonNegativeInteger(value.maxAutoRework, "maxAutoRework"),
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
