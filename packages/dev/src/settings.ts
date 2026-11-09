/**
 * A repository's dev settings: `<repository>/.operad/dev.json`, checked against
 * the shipped `dev.schema.json`. The file is JSON; the schema is what editors
 * read, and this module applies the same rules when a step loads the file.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
  sep,
} from "node:path";
import {
  DEFAULT_POOL,
  harnessOf,
  parseWorkers,
  WorkerDefinitionError,
  type ParsedWorkers,
  type WorkerDefinition,
} from "@operad-io/pool";
import { defaultOperadHome } from "@operad-io/engine";
import { DevError, isRecord } from "./model.ts";

/** Where a repository keeps its dev settings. */
export const DEV_SETTINGS_FILE = ".operad/dev.json";

/** The `$id` of the shipped schema, written as a generated file's `$schema`. */
export const DEV_SETTINGS_SCHEMA = "https://operad.io/schemas/dev.schema.json";

/** The default location of a repository's worker brief. */
export const WORKER_BRIEF_FILE = ".operad/worker-brief.md";

/** The harness step a repository uses when it names none. */
export const DEFAULT_WORKER_USE = "harness-radian/agent";

/** How long a review waits before it runs again after a model was unavailable. */
export const DEFAULT_REVIEWER_RETRY_SECS = 120;

/** What a repository may configure for the worker harness step. */
export interface WorkerSettings {
  readonly use: string;
  readonly args: readonly string[];
  readonly wallTimeSecs?: number | undefined;
  readonly stallSecs?: number | undefined;
}

/** The name of a harness step's plugin, or the whole text when it has no `/`. */
function workerNameOf(use: string): string {
  return use.includes("/") ? harnessOf(use) : use;
}

/**
 * The old single `worker` as a pool: one worker named after its harness,
 * `count` = `concurrency`, in a pool named `default`.
 */
function legacyWorkers(worker: WorkerSettings, concurrency: number): ParsedWorkers {
  const name = workerNameOf(worker.use);
  return {
    workers: [
      {
        name,
        use: worker.use,
        args: worker.args,
        count: concurrency,
        ...(worker.wallTimeSecs === undefined ? {} : { wallTimeSecs: worker.wallTimeSecs }),
        ...(worker.stallSecs === undefined ? {} : { stallSecs: worker.stallSecs }),
      },
    ],
    pools: { [DEFAULT_POOL]: [name] },
  };
}

/** How serious a review finding must be before it fails the gate. */
export type FixLevel = "critical" | "major" | "minor";

/** How a failed check command runs only the tests that failed. */
export interface FailedRerun {
  /** A regex with one capture group: the failed test's name. */
  readonly match: string;
  /** The command that runs one test again; `{name}` and `{pattern}` are replaced. */
  readonly rerun: string;
  /** The most failed tests that are run again; more fails the check. */
  readonly max: number;
}

/** A check command: a shell line, or a line with a rerun of its failed tests. */
export type CheckCommand =
  | string
  | { readonly run: string; readonly failed?: FailedRerun };

/** How a work step that is running out of time is told to stop. */
export interface WorkSettings {
  /**
   * The share of the work step's time limit, above 0 and below 1, at which the
   * worker is asked to stop starting new things, commit and write a progress
   * note.
   */
  readonly wrapUpAt: number;
}

/** The commands a task's gate runs and how long each may take. */
export interface GateSettings {
  readonly commands: readonly CheckCommand[];
  readonly commandTimeoutSecs: number;
  /** The most checks of this repository that run at once; unset means no limit of its own. */
  readonly places?: number;
}

/** What a failed check does before it counts as a failure. */
export interface CheckSettings {
  /** How many times a failed check line list runs again; 0 turns it off. */
  readonly rerun: number;
  /**
   * How many passes on rerun of one test in a repository propose a task to fix
   * it; 0 turns the proposal off.
   */
  readonly flakyTask: number;
}

/** What a task does when its step failed for a reason outside its own work. */
export interface RetrySettings {
  /**
   * How long a retry waits for what was missing (a step that is not loaded,
   * settings that cannot be read) before the task waits for a person.
   */
  readonly environmentWaitMinutes: number;
}

/** How the integrate step lands a verified commit on main. */
export type IntegrationStyle = "merge" | "squash";

/** How the integrate step builds and lands a candidate on main. */
export interface IntegrationSettings {
  readonly style: IntegrationStyle;
  /** Commands that must pass on the candidate before it is pushed. */
  readonly keyCommands: readonly CheckCommand[];
}

/** Commands the cleanup step runs after a merge. */
export interface HookSettings {
  readonly afterMerge: readonly string[];
}

/** A second harness step the reviewer may fall back to. */
export interface ReviewerFallback {
  readonly use: string;
  readonly args: readonly string[];
}

/** What a repository may configure for the review harness step. */
export interface ReviewerSettings {
  readonly use: string;
  readonly args: readonly string[];
  /** The arguments of the first review of an attempt, when they differ. */
  readonly firstArgs?: readonly string[] | undefined;
  /** The step used when the primary reviewer is unavailable. */
  readonly fallback?: ReviewerFallback | undefined;
  readonly timeoutSecs: number;
  /** How long a review may print nothing; unset uses the harness default. */
  readonly stallSecs?: number | undefined;
  readonly fixLevel: FixLevel;
  /** Whether findings that did not fail a review become a follow-up task. */
  readonly followups: boolean;
  /** How long an unavailable review waits before it runs again. */
  readonly retrySecs: number;
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
  /**
   * The cap `concurrency` sets on running tasks. When the file does not set
   * it, the default pool's counts alone decide (see `runningTaskCap`).
   */
  readonly concurrency: number;
  /** Whether the file wrote `concurrency` itself. */
  readonly concurrencySet: boolean;
  /**
   * The worker the repository's work step runs first: the old `worker`
   * setting, or the first worker of the `default` pool.
   */
  readonly worker: WorkerSettings;
  /**
   * Every worker and pool of the repository. The old `worker` setting is one
   * worker named after its harness, with `count` = `concurrency`, in `default`.
   */
  readonly workers: ParsedWorkers;
  readonly workerBrief: string;
  /**
   * Commands run in every checkout dev makes (the worker's worktree, the gate
   * checkout, the integration checkout) after it is created or moved to a new
   * commit and before a step uses it.
   */
  readonly prepare: readonly string[];
  readonly gate: GateSettings;
  readonly check: CheckSettings;
  readonly work: WorkSettings;
  readonly reviewer: ReviewerSettings;
  readonly integration: IntegrationSettings;
  readonly hooks: HookSettings;
  readonly maxAutoRework: number;
  readonly retry: RetrySettings;
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
  concurrencySet: false,
  worker: {
    use: DEFAULT_WORKER_USE,
    args: [],
  },
  workers: legacyWorkers({ use: DEFAULT_WORKER_USE, args: [] }, 1),
  workerBrief: WORKER_BRIEF_FILE,
  prepare: [],
  gate: {
    commands: [],
    commandTimeoutSecs: 1800,
  },
  check: { rerun: 1, flakyTask: 2 },
  work: { wrapUpAt: 0.85 },
  reviewer: {
    use: DEFAULT_WORKER_USE,
    args: [],
    timeoutSecs: 600,
    fixLevel: "major",
    followups: true,
    retrySecs: DEFAULT_REVIEWER_RETRY_SECS,
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
  retry: { environmentWaitMinutes: 60 },
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
  "workers",
  "pools",
  "workerBrief",
  "prepare",
  "gate",
  "check",
  "work",
  "reviewer",
  "integration",
  "hooks",
  "maxAutoRework",
  "retry",
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

function lineList(value: unknown, field: string): readonly string[] {
  const lines = stringList(value, field);
  lines.forEach((line, index) => {
    if (line.trim().length === 0) {
      throw new DevError(`${field}[${index}]`, "must be a non-empty string");
    }
  });
  return lines;
}

function failedRerun(value: unknown, field: string): FailedRerun {
  if (!isRecord(value)) throw new DevError(field, "must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "match" && key !== "rerun" && key !== "max") {
      throw new DevError(`${field}.${key}`, "is not a failed setting");
    }
  }
  const match = nonEmptyString(value.match, `${field}.match`);
  let groups: number;
  try {
    groups = (new RegExp(`${match}|`).exec("")?.length ?? 1) - 1;
  } catch {
    throw new DevError(`${field}.match`, "must be a valid regular expression");
  }
  if (groups !== 1) {
    throw new DevError(`${field}.match`, "must have exactly one capture group");
  }
  const rerun = nonEmptyString(value.rerun, `${field}.rerun`);
  if (!rerun.includes("{name}") && !rerun.includes("{pattern}")) {
    throw new DevError(`${field}.rerun`, "must contain {name} or {pattern}");
  }
  return {
    match,
    rerun,
    max:
      value.max === undefined
        ? 10
        : positiveInteger(value.max, `${field}.max`),
  };
}

function commandList(value: unknown, field: string): readonly CheckCommand[] {
  if (!Array.isArray(value)) {
    throw new DevError(field, "must be an array of commands");
  }
  return value.map((command: unknown, index): CheckCommand => {
    const at = `${field}[${index}]`;
    if (typeof command === "string") return nonEmptyString(command, at);
    if (!isRecord(command)) {
      throw new DevError(at, "must be a string or an object");
    }
    for (const key of Object.keys(command)) {
      if (key !== "run" && key !== "failed") {
        throw new DevError(`${at}.${key}`, "is not a command setting");
      }
    }
    const run = nonEmptyString(command.run, `${at}.run`);
    return command.failed === undefined
      ? { run }
      : { run, failed: failedRerun(command.failed, `${at}.failed`) };
  });
}

function prepareList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new DevError(field, "must be an array of command lines");
  }
  return value.map((line: unknown, index) =>
    nonEmptyString(line, `${field}[${index}]`),
  );
}

function positiveCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new DevError(field, "must be an integer of 1 or more");
  }
  return value;
}

function gateSettings(value: unknown, field: string): GateSettings {
  if (!isRecord(value)) {
    throw new DevError(field, "must be an object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "commands" && key !== "commandTimeoutSecs" && key !== "places") {
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
    ...(value.places === undefined
      ? {}
      : { places: positiveCount(value.places, `${field}.places`) }),
  };
}

function checkSettings(value: unknown, field: string): CheckSettings {
  if (!isRecord(value)) {
    throw new DevError(field, "must be an object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "rerun" && key !== "flakyTask") {
      throw new DevError(`${field}.${key}`, "is not a check setting");
    }
  }
  return {
    rerun:
      value.rerun === undefined
        ? DEFAULT_DEV_SETTINGS.check.rerun
        : nonNegativeInteger(value.rerun, `${field}.rerun`),
    flakyTask:
      value.flakyTask === undefined
        ? DEFAULT_DEV_SETTINGS.check.flakyTask
        : nonNegativeInteger(value.flakyTask, `${field}.flakyTask`),
  };
}

function workSettings(value: unknown, field: string): WorkSettings {
  if (!isRecord(value)) {
    throw new DevError(field, "must be an object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "wrapUpAt") {
      throw new DevError(`${field}.${key}`, "is not a work setting");
    }
  }
  const at = value.wrapUpAt;
  if (at === undefined) return DEFAULT_DEV_SETTINGS.work;
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0 || at >= 1) {
    throw new DevError(
      `${field}.wrapUpAt`,
      "must be a number above 0 and below 1",
    );
  }
  return { wrapUpAt: at };
}

function retrySettings(value: unknown, field: string): RetrySettings {
  if (!isRecord(value)) {
    throw new DevError(field, "must be an object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "environmentWaitMinutes") {
      throw new DevError(`${field}.${key}`, "is not a retry setting");
    }
  }
  return {
    environmentWaitMinutes:
      value.environmentWaitMinutes === undefined
        ? DEFAULT_DEV_SETTINGS.retry.environmentWaitMinutes
        : positiveInteger(
            value.environmentWaitMinutes,
            `${field}.environmentWaitMinutes`,
          ),
  };
}

function fixLevelOf(value: unknown, field: string): FixLevel {
  if (value === undefined) return DEFAULT_DEV_SETTINGS.reviewer.fixLevel;
  if (value !== "critical" && value !== "major" && value !== "minor") {
    throw new DevError(field, 'must be "critical", "major" or "minor"');
  }
  return value;
}

function reviewerFallback(value: unknown, field: string): ReviewerFallback {
  if (!isRecord(value)) {
    throw new DevError(field, "must be an object");
  }
  for (const key of Object.keys(value)) {
    if (key !== "use" && key !== "args") {
      throw new DevError(`${field}.${key}`, "is not a fallback setting");
    }
  }
  return {
    use: nonEmptyString(value.use, `${field}.use`),
    args:
      value.args === undefined ? [] : stringList(value.args, `${field}.args`),
  };
}

function booleanOf(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new DevError(field, "must be true or false");
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
      key !== "fallback" &&
      key !== "timeoutSecs" &&
      key !== "stallSecs" &&
      key !== "fixLevel" &&
      key !== "followups" &&
      key !== "retrySecs" &&
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
  const fallback =
    value.fallback === undefined
      ? undefined
      : reviewerFallback(value.fallback, `${field}.fallback`);
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
    ...(fallback === undefined ? {} : { fallback }),
    timeoutSecs:
      value.timeoutSecs === undefined
        ? DEFAULT_DEV_SETTINGS.reviewer.timeoutSecs
        : positiveSeconds(value.timeoutSecs, `${field}.timeoutSecs`),
    ...(value.stallSecs === undefined
      ? {}
      : { stallSecs: positiveSeconds(value.stallSecs, `${field}.stallSecs`) }),
    fixLevel: fixLevelOf(value.fixLevel, `${field}.fixLevel`),
    followups:
      value.followups === undefined
        ? DEFAULT_DEV_SETTINGS.reviewer.followups
        : booleanOf(value.followups, `${field}.followups`),
    retrySecs:
      value.retrySecs === undefined
        ? DEFAULT_DEV_SETTINGS.reviewer.retrySecs
        : positiveSeconds(value.retrySecs, `${field}.retrySecs`),
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
        : lineList(value.afterMerge, `${field}.afterMerge`),
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

/** The first worker of the `default` pool, as the single-worker settings. */
function firstWorker(workers: ParsedWorkers): WorkerSettings {
  const name = workers.pools[DEFAULT_POOL]?.[0];
  const found = workers.workers.find((worker) => worker.name === name);
  if (found === undefined) {
    throw new DevError("pools", `needs a pool named "${DEFAULT_POOL}"`);
  }
  return {
    use: found.use,
    args: found.args,
    ...(found.wallTimeSecs === undefined ? {} : { wallTimeSecs: found.wallTimeSecs }),
    ...(found.stallSecs === undefined ? {} : { stallSecs: found.stallSecs }),
  };
}

/** Reads `worker` or `workers` and `pools`; both forms together are refused. */
function workerSettingsOf(
  value: Readonly<Record<string, unknown>>,
  concurrency: number,
): { readonly worker: WorkerSettings; readonly workers: ParsedWorkers } {
  if (value.workers === undefined) {
    if (value.pools !== undefined) {
      throw new DevError("pools", "needs workers; the single worker setting has no pools");
    }
    const worker =
      value.worker === undefined
        ? DEFAULT_DEV_SETTINGS.worker
        : workerSettings(value.worker, "worker");
    return { worker, workers: legacyWorkers(worker, concurrency) };
  }
  if (value.worker !== undefined) {
    throw new DevError(
      "worker",
      "cannot be set together with workers; use one or the other",
    );
  }
  let workers: ParsedWorkers;
  try {
    workers = parseWorkers(value.workers, value.pools);
  } catch (error) {
    if (error instanceof WorkerDefinitionError) {
      throw new DevError(error.field, error.message.slice(error.field.length + 2));
    }
    throw error;
  }
  if (workers.pools[DEFAULT_POOL] === undefined) {
    throw new DevError("pools", `needs a pool named "${DEFAULT_POOL}", the one the dev flow uses`);
  }
  return { worker: firstWorker(workers), workers };
}

/** The workers of one pool, in the order the pool lists them. */
export function poolWorkers(
  settings: DevSettings,
  pool: string,
): readonly WorkerDefinition[] {
  const names = settings.workers.pools[pool] ?? [];
  const found: WorkerDefinition[] = [];
  for (const name of names) {
    const worker = settings.workers.workers.find((item) => item.name === name);
    if (worker !== undefined) found.push(worker);
  }
  return found;
}

/**
 * How many tasks the repository runs at once: the sum of the `default` pool's
 * counts, further capped by `concurrency` when the file sets it.
 */
export function runningTaskCap(settings: DevSettings): number {
  const total = poolWorkers(settings, DEFAULT_POOL).reduce(
    (sum, worker) => sum + worker.count,
    0,
  );
  return settings.concurrencySet ? Math.min(total, settings.concurrency) : total;
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
  const concurrency =
    value.concurrency === undefined
      ? DEFAULT_DEV_SETTINGS.concurrency
      : positiveInteger(value.concurrency, "concurrency");
  const { worker, workers } = workerSettingsOf(value, concurrency);
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
    concurrency,
    concurrencySet: value.concurrency !== undefined,
    worker,
    workers,
    workerBrief:
      value.workerBrief === undefined
        ? DEFAULT_DEV_SETTINGS.workerBrief
        : nonEmptyString(value.workerBrief, "workerBrief"),
    prepare:
      value.prepare === undefined
        ? DEFAULT_DEV_SETTINGS.prepare
        : prepareList(value.prepare, "prepare"),
    gate:
      value.gate === undefined
        ? DEFAULT_DEV_SETTINGS.gate
        : gateSettings(value.gate, "gate"),
    check:
      value.check === undefined
        ? DEFAULT_DEV_SETTINGS.check
        : checkSettings(value.check, "check"),
    work:
      value.work === undefined
        ? DEFAULT_DEV_SETTINGS.work
        : workSettings(value.work, "work"),
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
    retry:
      value.retry === undefined
        ? DEFAULT_DEV_SETTINGS.retry
        : retrySettings(value.retry, "retry"),
  };
}

interface ReadSettings {
  readonly settings: DevSettings;
  /** The file's text; empty when the file does not exist. */
  readonly text: string;
}

/** Parses and checks the text of a settings file for the repository at `repositoryPath`. */
function settingsFromText(
  repositoryPath: string,
  path: string,
  text: string,
): ReadSettings {
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
  return { settings, text };
}

/** Reads the file as it is now; any problem with it is thrown. */
function readSettingsNow(repositoryPath: string): ReadSettings {
  const path = join(repositoryPath, DEV_SETTINGS_FILE);
  if (!existsSync(path)) {
    assertInsideRepository(
      repositoryPath,
      resolve(repositoryPath, DEFAULT_DEV_SETTINGS.worktreeRoot),
      "worktreeRoot",
    );
    return { settings: DEFAULT_DEV_SETTINGS, text: "" };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new DevError("dev.json", `cannot read ${path}: ${String(error)}`);
  }
  return settingsFromText(repositoryPath, path, text);
}

/**
 * The last settings of each repository that were valid, by repository path.
 * A process keeps them in memory; the text is also kept in the home, so a
 * process that starts while the file is invalid finds the same settings.
 */
const lastValid = new Map<string, ReadSettings>();

function keptFile(home: string, repositoryPath: string): string {
  const key = createHash("sha1").update(repositoryPath).digest("hex");
  return join(home, "dev", "settings", `${key}.json`);
}

function keptHome(): string | undefined {
  const home = defaultOperadHome();
  return existsSync(join(home, "config.json")) ? home : undefined;
}

function keep(repositoryPath: string, read: ReadSettings): void {
  const before = lastValid.get(repositoryPath);
  if (before !== undefined && before.text === read.text) return;
  lastValid.set(repositoryPath, read);
  const home = keptHome();
  if (home === undefined) return;
  try {
    const file = keptFile(home, repositoryPath);
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ path: repositoryPath, text: read.text }));
    renameSync(temporary, file);
  } catch {
    // The copy is a convenience for the next process; the memory copy stays.
  }
}

function recall(repositoryPath: string): ReadSettings | undefined {
  const remembered = lastValid.get(repositoryPath);
  if (remembered !== undefined) return remembered;
  const home = keptHome();
  if (home === undefined) return undefined;
  try {
    const raw: unknown = JSON.parse(readFileSync(keptFile(home, repositoryPath), "utf8"));
    if (isRecord(raw) && typeof raw.text === "string") {
      const read =
        raw.text === ""
          ? readDefaults(repositoryPath)
          : settingsFromText(
              repositoryPath,
              join(repositoryPath, DEV_SETTINGS_FILE),
              raw.text,
            );
      lastValid.set(repositoryPath, read);
      return read;
    }
  } catch {
    // No usable copy.
  }
  return undefined;
}

function readDefaults(repositoryPath: string): ReadSettings {
  assertInsideRepository(
    repositoryPath,
    resolve(repositoryPath, DEFAULT_DEV_SETTINGS.worktreeRoot),
    "worktreeRoot",
  );
  return { settings: DEFAULT_DEV_SETTINGS, text: "" };
}

/**
 * Reads a repository's settings. A missing file means the defaults, so a work
 * tree that `operad repo add` has not written yet still runs. A file that is
 * not valid never stops work: the last valid settings stay in force. Only a
 * repository that never had valid settings gets the error.
 */
export async function readDevSettings(
  repositoryPath: string,
): Promise<DevSettings> {
  try {
    const read = readSettingsNow(repositoryPath);
    keep(repositoryPath, read);
    return read.settings;
  } catch (error) {
    const kept = recall(repositoryPath);
    if (kept !== undefined) return kept.settings;
    throw error;
  }
}

/** What is wrong with the repository's settings file now, or undefined when it is valid. */
export function settingsProblem(repositoryPath: string): string | undefined {
  try {
    keep(repositoryPath, readSettingsNow(repositoryPath));
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** True when the repository has valid settings to fall back on. */
export function hasValidSettings(repositoryPath: string): boolean {
  return recall(repositoryPath) !== undefined;
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
