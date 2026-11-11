/**
 * The two steps a task runs before a check: `worktree` gives it a branch and a
 * worktree, `work` asks a harness step to do the task and reads the result.
 * The kernel never runs git or a harness itself; both live here in `dev`.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  messageOf,
  readUsage,
  type CostQuality,
  type PluginStepResult,
  type StepContext,
  type StepEvent,
  type StepRunOptions,
} from "@operad-io/engine";
import {
  appendChange,
  bareId,
  DevError,
  listAll,
  repositoryData,
  splitBrief,
  storeKey,
  taskData,
  type RepositoryData,
  type StopRecord,
  type TaskAttempt,
  type TaskData,
} from "./model.ts";
import {
  ACQUIRED_EVENT,
  DEFAULT_POOL,
  resolvePool,
  WAITING_EVENT,
  type WorkerDefinition,
} from "@operad-io/pool";
import { git, type GitResult } from "./git.ts";
import { runPrepare } from "./prepare.ts";
import { classifyStop, STOP_REASONS } from "./stops.ts";
import { findRepository, putTaskKeepingPlanCost, withRepoLock } from "./service.ts";
import {
  createOutbox,
  NOTE_REMOVED_MESSAGE,
  previousAttemptText,
  progressOf,
  PROGRESS_FILE,
  WIP_MESSAGE,
  wrapUpMessage,
  type Progress,
} from "./progress.ts";
import { MAX_WORK_WAITS, STEP_TIMEOUT_SECS } from "./timeouts.ts";
import {
  assertInsideRepository,
  readDevSettings,
  readWorkerBrief,
  type DevSettings,
} from "./settings.ts";

export { git, type GitResult };

function resolvePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The path a task's worktree occupies, refused when it lands outside the repository. */
export function worktreePath(
  repositoryPath: string,
  settings: DevSettings,
  taskId: string,
): string {
  const path = resolve(repositoryPath, settings.worktreeRoot, taskId);
  // Settings were checked when they were read, but a link can appear before the
  // step runs; the worktree must still stay inside the repository.
  assertInsideRepository(repositoryPath, path, "worktreeRoot");
  return path;
}

/** The branch a task's worktree is on. */
export function workBranch(taskId: string): string {
  return `work/${taskId}`;
}

/** The step a host error says was not loaded; undefined for any other error. */
function notLoadedStep(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as { readonly kind?: unknown; readonly use?: unknown };
  return record.kind === "step_not_loaded" && typeof record.use === "string"
    ? record.use
    : undefined;
}

export interface TaskContext {
  readonly task: TaskData;
  readonly repository: RepositoryData;
  readonly taskKey: string;
  readonly taskId: string;
  readonly settings: DevSettings;
}

export async function taskContext(ctx: StepContext): Promise<TaskContext> {
  const parts = await taskParts(ctx);
  const settings = await readDevSettings(parts.repository.path);
  return { ...parts, settings };
}

/** A task context whose settings may be missing: a step that can retry reads it. */
export type LooseTaskContext = Omit<TaskContext, "settings"> & {
  readonly settings?: DevSettings | undefined;
  /** Why the settings could not be read, when `settings` is absent. */
  readonly settingsError?: string | undefined;
};

/**
 * Like `taskContext`, but a repository whose settings cannot be read comes
 * back with `settingsError` instead of throwing, so the step can say so.
 */
export async function looseTaskContext(
  ctx: StepContext,
): Promise<LooseTaskContext> {
  const parts = await taskParts(ctx);
  try {
    return { ...parts, settings: await readDevSettings(parts.repository.path) };
  } catch (error) {
    if (error instanceof DevError && error.field === "dev.json") {
      return { ...parts, settingsError: error.message };
    }
    throw error;
  }
}

async function taskParts(
  ctx: StepContext,
): Promise<Omit<TaskContext, "settings">> {
  const object = ctx.object;
  if (object === undefined || object.type !== "task") {
    throw new DevError("object", "this step runs on a task");
  }
  let stored = await ctx.store.get("task", object.id);
  if (stored === undefined && !object.id.includes("/")) {
    const matches = (await listAll(ctx.store, "task")).filter(
      (candidate) => bareId(candidate.id) === object.id,
    );
    if (matches.length === 1) stored = matches[0];
  }
  const task = taskData(stored?.data ?? object.data);
  const found = await findRepository(ctx.store, task.repository);
  if (found === undefined) {
    throw new DevError(
      "repository",
      `no registered repository "${task.repository}"`,
    );
  }
  const repository = repositoryData(found.data);
  const taskId = bareId(stored?.id ?? object.id);
  let taskKey = stored?.id ?? object.id;
  if ((await ctx.store.get("task", taskKey)) === undefined) {
    taskKey = storeKey(repository.name, taskId);
  }
  return { task, repository, taskKey, taskId };
}

interface AttemptState {
  readonly attempt: TaskAttempt;
  readonly attempts: number;
  readonly replay: boolean;
}

function attemptFor(ctx: StepContext, task: TaskData): AttemptState {
  const previous = task.attempt;
  const replay =
    task.phase === "running" &&
    task.run === ctx.runId &&
    previous?.run === ctx.runId &&
    // A worktree visit that follows a `work` in the same run is a retry, not a
    // replay: the attempt has already been used and the next one must count.
    previous.worked !== true;
  if (replay && previous !== undefined) {
    return { attempt: previous, attempts: task.attempts, replay: true };
  }
  const number = Math.max(task.attempts, previous?.number ?? 0) + 1;
  // The worker of the attempt before this one, so the work goes back to it.
  const previousWorker =
    typeof previous?.worker === "string" ? previous.worker : previous?.previousWorker;
  const ran = typeof previous?.worker === "string";
  const previousSession = ran ? previous?.sessionId : previous?.previousSession;
  // What the attempt before left to continue from; only an attempt that left
  // a note or ran out of time has any.
  const left = progressOf(previous?.progress);
  return {
    attempt: {
      number,
      run: ctx.runId,
      ...(left === undefined ? {} : { previousProgress: left }),
      ...(typeof previousWorker === "string" ? { previousWorker } : {}),
      ...(typeof previousSession === "string" ? { previousSession } : {}),
    },
    attempts: number,
    replay: false,
  };
}

function listWorktrees(repositoryPath: string): readonly string[] {
  const result = git(repositoryPath, ["worktree", "list", "--porcelain"]);
  if (!result.ok) return [];
  const paths: string[] = [];
  for (const line of result.out.split("\n")) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length));
  }
  return paths;
}

export function isRegistered(repositoryPath: string, path: string): boolean {
  const wanted = resolvePath(path);
  return listWorktrees(repositoryPath).some(
    (candidate) => resolvePath(candidate) === wanted,
  );
}

function isWorktree(path: string): boolean {
  if (!existsSync(path)) return false;
  const result = git(path, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.out === "true";
}

function currentBranch(path: string): string | undefined {
  const result = git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return result.ok && result.out.length > 0 ? result.out : undefined;
}

export function headOf(path: string): string | undefined {
  const result = git(path, ["rev-parse", "HEAD"]);
  return result.ok && result.out.length > 0 ? result.out : undefined;
}

/** True when `ancestor` is reachable from `descendant`, so it is not new work. */
function isAncestor(
  path: string,
  ancestor: string,
  descendant: string,
): boolean {
  return git(path, ["merge-base", "--is-ancestor", ancestor, descendant]).ok;
}

function branchExists(repositoryPath: string, branch: string): boolean {
  return git(repositoryPath, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]).ok;
}

function remoteBranchExists(
  repositoryPath: string,
  remote: string,
  branch: string,
): boolean {
  return git(repositoryPath, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/remotes/${remote}/${branch}`,
  ]).ok;
}

function gitDirOf(worktree: string): string | undefined {
  const result = git(worktree, ["rev-parse", "--git-dir"]);
  if (!result.ok || result.out.length === 0) return undefined;
  return resolve(worktree, result.out);
}

/** True while a merge left conflicts for the worker to resolve. */
export function mergeInProgress(worktree: string): boolean {
  const directory = gitDirOf(worktree);
  return directory !== undefined && existsSync(join(directory, "MERGE_HEAD"));
}

/** The files git recorded as conflicted, in path order. */
export function conflictedFiles(worktree: string): readonly string[] {
  const result = git(worktree, [
    "diff",
    "--name-only",
    "--diff-filter=U",
  ]);
  if (!result.ok || result.out.length === 0) return [];
  return result.out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

/**
 * The files `git status` calls changed, untracked included. Read from
 * `--porcelain -z`: names are not quoted or trimmed, a name may hold spaces, and
 * a rename or copy is followed by its old path, which is skipped (the new path
 * is the changed file).
 */
export function changedFiles(worktree: string): readonly string[] {
  const result = git(worktree, ["status", "--porcelain", "-z"], true);
  if (!result.ok || result.out.length === 0) return [];
  const entries = result.out.split("\0");
  const files: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    const code = entry.slice(0, 2);
    if (code.includes("R") || code.includes("C")) index += 1;
  }
  return [...new Set(files)].filter((file) => file !== PROGRESS_FILE).sort();
}

export interface Prepared {
  readonly kind: "ready" | "conflict" | "failed";
  readonly base?: string | undefined;
  readonly message?: string | undefined;
  readonly files?: readonly string[] | undefined;
  /** The main this visit merged into the branch, when it merged one. */
  readonly merged?: MergedMain | undefined;
  /** Set when the prepare commands failed. */
  readonly reason?: string | undefined;
  readonly log?: string | undefined;
}

/** Runs the prepare commands in a ready worktree; a failure turns it into a failed visit. */
async function withPrepare(
  ctx: StepContext,
  settings: DevSettings,
  path: string,
  prepared: Prepared,
): Promise<Prepared> {
  if (prepared.kind !== "ready") return prepared;
  const failure = await runPrepare(ctx, settings, path);
  if (failure === undefined) return prepared;
  return {
    ...prepared,
    kind: "failed",
    message: failure.message,
    reason: failure.reason,
    log: failure.log,
  };
}

/** What the worktree step merged: the remote main's commit, and whether it conflicted. */
export type MergedMain = {
  readonly ref: string;
  readonly commit: string;
  readonly conflict: boolean;
};

function failed(message: string, files?: readonly string[]): Prepared {
  return { kind: "failed", message, ...(files === undefined ? {} : { files }) };
}

/** Merges the fetched main into a reused branch and reports a conflict. */
function mergeLatest(path: string, mainRef: string): Prepared {
  const before = headOf(path);
  const commit = git(path, ["rev-parse", "--short", mainRef]).out;
  const merge = git(path, ["merge", "--no-edit", "--no-ff", mainRef]);
  if (!merge.ok) {
    const files = conflictedFiles(path);
    if (files.length > 0 || mergeInProgress(path)) {
      return {
        kind: "conflict",
        base: headOf(path),
        files,
        merged: { ref: mainRef, commit, conflict: true },
      };
    }
    return failed(
      `cannot merge "${mainRef}" into the worktree: ${merge.err || merge.out}`,
    );
  }
  const after = headOf(path);
  return {
    kind: "ready",
    base: after,
    ...(after === before
      ? {}
      : { merged: { ref: mainRef, commit, conflict: false } }),
  };
}

/** Fetches, creates the worktree when needed, and merges main into a reused one. */
export function prepareWorktree(
  repository: RepositoryData,
  settings: DevSettings,
  taskId: string,
  mergeMain = true,
): Prepared {
  const fetch = git(repository.path, ["fetch", "--prune", settings.remote]);
  if (!fetch.ok) {
    return failed(
      `cannot fetch "${settings.remote}": ${fetch.err || fetch.out || "git fetch failed"}`,
    );
  }
  const mainRef = `${settings.remote}/${settings.mainBranch}`;
  if (!git(repository.path, ["show-ref", "--verify", "--quiet", `refs/remotes/${mainRef}`]).ok) {
    return failed(`"${mainRef}" does not exist after the fetch`);
  }

  const path = worktreePath(repository.path, settings, taskId);
  const branch = workBranch(taskId);
  const registered = isRegistered(repository.path, path);

  if (existsSync(path) && !registered) {
    return failed(
      `${path} exists but is not a git worktree of this repository`,
    );
  }
  if (!existsSync(path) && registered) {
    git(repository.path, ["worktree", "prune"]);
  }

  if (existsSync(path)) {
    if (!isWorktree(path)) {
      return failed(`${path} is not a git worktree`);
    }
    if (currentBranch(path) !== branch) {
      return failed(
        `${path} is on "${currentBranch(path) ?? "no branch"}", not "${branch}"`,
      );
    }
    if (!mergeMain) {
      return { kind: "ready", base: headOf(path) };
    }
    if (mergeInProgress(path)) {
      return {
        kind: "conflict",
        base: headOf(path),
        files: conflictedFiles(path),
      };
    }
    return mergeLatest(path, mainRef);
  }

  mkdirSync(dirname(path), { recursive: true });
  let add: GitResult;
  let reused = false;
  if (branchExists(repository.path, branch)) {
    add = git(repository.path, ["worktree", "add", path, branch]);
    reused = true;
  } else if (remoteBranchExists(repository.path, settings.remote, branch)) {
    add = git(repository.path, [
      "worktree",
      "add",
      "--no-track",
      "-b",
      branch,
      path,
      `${settings.remote}/${branch}`,
    ]);
    reused = true;
  } else {
    add = git(repository.path, [
      "worktree",
      "add",
      "--no-track",
      "-b",
      branch,
      path,
      mainRef,
    ]);
  }
  if (!add.ok) {
    return failed(`cannot create worktree at ${path}: ${add.err || add.out}`);
  }
  // A branch kept from an earlier attempt continues from its old base, so the
  // freshly fetched main is merged before the worker sees it.
  if (reused && mergeMain) return mergeLatest(path, mainRef);
  return { kind: "ready", base: headOf(path) };
}

export async function saveTask(
  ctx: StepContext,
  key: string,
  data: TaskData,
  cause: string,
): Promise<void> {
  await putTaskKeepingPlanCost(ctx.store, key, data, cause);
}

/** The claim token the scheduler put in the run's start parameters. */
export function runToken(ctx: StepContext): string | undefined {
  const params = ctx.params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }
  const token = (params as Record<string, unknown>).token;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

/**
 * True while a step may write its task: the task is not cancelled, the run
 * carries the claim's token, and a step that runs before the run recorded
 * itself still finds the phase the claim wrote. A task without a claim was not
 * started by the scheduler (a step test or a direct call), so it is allowed.
 */
export function claimAllows(ctx: StepContext, task: TaskData): boolean {
  if (task.phase === "cancelled" || task.phase === "paused") return false;
  const claim = task.claim;
  if (claim === undefined || claim === null) {
    // A scheduler-started step that finds the task ready with no run and no
    // claim belongs to a run that was paused and resumed: its task is back in
    // the queue, so its late write would overwrite the resumed task.
    return !(
      runToken(ctx) !== undefined && task.run === null && task.phase === "ready"
    );
  }
  if (runToken(ctx) !== claim.token) return false;
  if (task.run === null && task.phase !== claim.phase) return false;
  return true;
}

/** The task as it is now, when the current step may still write it. */
export async function guardTask(
  ctx: StepContext,
  key: string,
): Promise<TaskData | undefined> {
  const object = await ctx.store.get("task", key);
  if (object === undefined) return undefined;
  const task = taskData(object.data);
  return claimAllows(ctx, task) ? task : undefined;
}

/**
 * Test-only hook, run by a guarded write after its caller built the new data
 * and before the write takes the repository lock. A test uses it to cancel the
 * task from another process in that window.
 */
export const stepTestHooks: {
  beforeGuardedWrite?:
    | ((ctx: StepContext, key: string) => Promise<void> | void)
    | undefined;
  /** Replaces the timers of a work step's wrap-up and time limit. */
  workClock?: WorkClock | undefined;
} = {};

/** The timers a work step uses for its wrap-up message and its time limit. */
export interface WorkClock {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realWorkClock: WorkClock = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** How long before the limit the step stops the worker itself, so it can still commit. */
function limitMarginMs(limitMs: number): number {
  return Math.min(30_000, Math.floor(limitMs / 100));
}

/** The commits the branch has beyond `base`, newest first. */
function commitsSince(
  worktree: string,
  base: string | null,
): Progress["commits"] {
  if (base === null) return [];
  const result = git(worktree, ["log", "--format=%h %s", "-n", "50", `${base}..HEAD`]);
  if (!result.ok || result.out.length === 0) return [];
  return result.out.split("\n").map((line) => {
    const space = line.indexOf(" ");
    return space === -1
      ? { sha: line, subject: "" }
      : { sha: line.slice(0, space), subject: line.slice(space + 1) };
  });
}

function readNote(worktree: string): string | null {
  try {
    const text = readFileSync(join(worktree, PROGRESS_FILE), "utf8");
    return text.trim().length === 0 ? null : text;
  } catch {
    return null;
  }
}

/** Takes the note out of the branch when the worker committed it anyway. */
function untrackNote(worktree: string): void {
  if (!git(worktree, ["ls-files", "--error-unmatch", PROGRESS_FILE]).ok) return;
  const removed = git(worktree, ["rm", "--cached", "-q", PROGRESS_FILE]);
  if (removed.ok) git(worktree, ["commit", "-q", "-m", NOTE_REMOVED_MESSAGE]);
}

/** Commits what a timed-out step left, except the note. False when nothing was committed. */
function commitWip(worktree: string): boolean {
  if (conflictedFiles(worktree).length > 0) return false;
  if (changedFiles(worktree).length === 0) return false;
  const added = git(worktree, ["add", "-A", "--", ".", `:(exclude)${PROGRESS_FILE}`]);
  if (!added.ok) return false;
  return git(worktree, ["commit", "-q", "--no-verify", "-m", WIP_MESSAGE]).ok;
}

/**
 * Writes the task only while the step still owns its claim. The check reads the
 * task again under the repository lock, so a `cancel` that landed after the
 * caller's own guard cannot be overwritten by the data built from stale task
 * state.
 */
export async function saveTaskGuarded(
  ctx: StepContext,
  key: string,
  data: TaskData,
  cause: string,
): Promise<boolean> {
  await stepTestHooks.beforeGuardedWrite?.(ctx, key);
  return withRepoLock(ctx.store, data.repository, async () => {
    const object = await ctx.store.get("task", key);
    if (object === undefined) return false;
    if (!claimAllows(ctx, taskData(object.data))) return false;
    await saveTask(ctx, key, data, cause);
    return true;
  });
}

/** The result a step returns when its task was cancelled under it. */
export function cancelledStep(): PluginStepResult {
  return { result: "cancelled", data: { reason: "cancelled" } };
}

/** The step a repair run says stopped, when the scheduler asked for one. */
function runStoppedAt(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }
  const value = (params as Record<string, unknown>).runStoppedAt;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The cancelled dependency a blocked start names, when the flow carries one. */
function blockedDependency(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }
  const value = (params as Record<string, unknown>).blockedBy;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Step `dev/worktree`: make the task's worktree ready or report a conflict. */
export async function runWorktree(
  ctx: StepContext,
): Promise<PluginStepResult> {
  const context = await taskContext(ctx);
  if (!claimAllows(ctx, context.task)) return cancelledStep();
  const stoppedAt = runStoppedAt(ctx.params);
  if (stoppedAt !== undefined && context.task.run === null) {
    // A run stopped without reaching an edge; the scheduler starts this run
    // only to put the task in front of a person again.
    const written = await saveTaskGuarded(
      ctx,
      context.taskKey,
      {
        ...context.task,
        phase: "waiting",
        run: ctx.runId,
        startRequested: false,
        // The run that stopped is over: this one only asks a person, so the
        // retry step must not run anything again.
        stop: {
          step: "worktree",
          result: "interrupted",
          reason: STOP_REASONS.runEnded,
        },
        brief: appendChange(
          context.task.brief,
          `waiting: ${stoppedAt} stopped`,
        ),
      },
      "dev:task-run-stopped",
    );
    if (!written) return cancelledStep();
    return {
      result: "interrupted",
      data: {
        reason: "run_stopped",
        step: stoppedAt,
        message: `the run stopped during ${stoppedAt}; reject to run it again`,
      },
    };
  }
  const blockedBy = blockedDependency(ctx.params);
  if (blockedBy !== undefined && context.task.run === null) {
    // A cancelled dependency made the scheduler start this run only to log a
    // real person wait. The claim has no run yet; this step records the wait
    // so the kernel's pending view and the task's normal actions both see it.
    const written = await saveTaskGuarded(
      ctx,
      context.taskKey,
      {
        ...context.task,
        phase: "waiting",
        run: ctx.runId,
        startRequested: false,
        brief: appendChange(
          context.task.brief,
          `waiting: ${blockedBy} cancelled`,
        ),
      },
      "dev:task-wait-dependency",
    );
    if (!written) return cancelledStep();
    return {
      result: "blocked",
      data: { reason: "cancelled_dependency", dependency: blockedBy },
    };
  }
  const { attempt, attempts, replay } = attemptFor(ctx, context.task);
  const prepared = await withPrepare(
    ctx,
    context.settings,
    worktreePath(context.repository.path, context.settings, context.taskId),
    prepareWorktree(
      context.repository,
      context.settings,
      context.taskId,
      beforeAttemptOf(ctx.params) !== "none",
    ),
  );
  const base = prepared.base ?? attempt.base ?? null;
  const nextAttempt: TaskAttempt = {
    ...attempt,
    run: ctx.runId,
    worktree: worktreePath(
      context.repository.path,
      context.settings,
      context.taskId,
    ),
    branch: workBranch(context.taskId),
    base,
    result: prepared.kind,
    workWaits: 0,
    workRetryAt: null,
    // A new attempt starts with no gate results; the branch may have moved.
    // A passing verify of the very commit the branch is at still stands.
    ...(passedAt(context.task.attempt, prepared.base ?? null)
      ? {
          verified: context.task.attempt?.verified ?? null,
          verify: context.task.attempt?.verify ?? null,
        }
      : { verified: null, verify: null }),
    review: null,
    reviewRuns: [],
    reviews: 0,
    // The next gate failure appends a fresh rework even in the same flow run.
    rework: null,
    // A replay finds main already merged and keeps what the first visit said.
    merged: prepared.merged ?? (replay ? (attempt.merged ?? null) : null),
  };
  const mergedNote =
    prepared.merged === undefined
      ? undefined
      : prepared.merged.conflict
        ? `merged ${prepared.merged.ref} ${prepared.merged.commit} into the branch (conflict)`
        : `merged ${prepared.merged.ref} ${prepared.merged.commit} into the branch (clean)`;
  const next: TaskData = {
    ...context.task,
    phase: "running",
    run: ctx.runId,
    // The run now names the task, so the manual start request has been met.
    startRequested: false,
    attempts,
    attempt: nextAttempt,
    // A merge conflict between two review failures resets the count.
    ...(prepared.kind === "conflict" ? { reviewFailed: undefined } : {}),
    ...(mergedNote === undefined
      ? {}
      : { brief: appendChange(context.task.brief, mergedNote) }),
  };
  if (!(await saveTaskGuarded(ctx, context.taskKey, next, "dev:worktree"))) {
    return cancelledStep();
  }
  const data = {
    attempt: attempts,
    worktree: nextAttempt.worktree,
    path: nextAttempt.worktree,
    branch: nextAttempt.branch,
    base,
    ...(prepared.message === undefined ? {} : { message: prepared.message }),
    ...(prepared.reason === undefined ? {} : { reason: prepared.reason }),
    ...(prepared.log === undefined ? {} : { log: prepared.log }),
    ...(prepared.files === undefined ? {} : { files: prepared.files }),
    ...(prepared.merged === undefined ? {} : { merged: prepared.merged }),
  };
  return { result: prepared.kind, data };
}

/**
 * Step `dev/reverify`: bring the branch up to date with main before a reverify
 * gates it. It keeps the attempt, since the work is the same: a clean merge (or
 * a main already contained) goes to verify, a conflict goes to the worker with
 * the merge left open.
 */
export async function runReverify(
  ctx: StepContext,
): Promise<PluginStepResult> {
  const context = await taskContext(ctx);
  if (!claimAllows(ctx, context.task)) return cancelledStep();
  const previous = context.task.attempt;
  const attempt: TaskAttempt = previous ?? {
    number: Math.max(context.task.attempts, 0) + 1,
    run: ctx.runId,
  };
  const attempts = Math.max(context.task.attempts, attempt.number);
  const prepared = await withPrepare(
    ctx,
    context.settings,
    worktreePath(context.repository.path, context.settings, context.taskId),
    prepareWorktree(context.repository, context.settings, context.taskId),
  );
  const base = prepared.base ?? attempt.base ?? null;
  const worktree = worktreePath(
    context.repository.path,
    context.settings,
    context.taskId,
  );
  const message =
    prepared.kind === "conflict"
      ? "reverify: main conflicts, sending to work"
      : prepared.kind === "ready"
        ? prepared.merged === undefined
          ? "reverify: main already contained, checking again"
          : `reverify: merged main ${prepared.merged.commit}, checking again`
        : undefined;
  const nextAttempt: TaskAttempt = {
    ...attempt,
    run: ctx.runId,
    worktree,
    branch: workBranch(context.taskId),
    base,
    result: prepared.kind,
    // A conflict is worked on again; a clean merge goes straight to the gate.
    ...(prepared.kind === "conflict" ? { worked: false } : {}),
    workWaits: 0,
    workRetryAt: null,
    merged: prepared.merged ?? attempt.merged ?? null,
  };
  const next: TaskData = {
    ...context.task,
    phase: "running",
    run: ctx.runId,
    attempts,
    attempt: nextAttempt,
    // A merge conflict between two review failures resets the count.
    ...(prepared.kind === "conflict" ? { reviewFailed: undefined } : {}),
    ...(message === undefined
      ? {}
      : { brief: appendChange(context.task.brief, message) }),
  };
  if (!(await saveTaskGuarded(ctx, context.taskKey, next, "dev:reverify"))) {
    return cancelledStep();
  }
  return {
    result: prepared.kind,
    data: {
      attempt: attempts,
      worktree,
      path: worktree,
      branch: nextAttempt.branch,
      base,
      ...(message === undefined ? {} : { message }),
      ...(prepared.message === undefined ? {} : { failure: prepared.message }),
      ...(prepared.reason === undefined ? {} : { reason: prepared.reason }),
      ...(prepared.log === undefined ? {} : { log: prepared.log }),
      ...(prepared.files === undefined ? {} : { files: prepared.files }),
      ...(prepared.merged === undefined ? {} : { merged: prepared.merged }),
    },
  };
}

export function briefText(task: TaskData): string {
  const parts = splitBrief(task.brief);
  const pieces = [parts.body, parts.reworks].filter(
    (piece) => piece.trim().length > 0,
  );
  return pieces.join("\n\n");
}

/** The conflict instruction a worker sees first when a merge is left open. */
export function conflictPrompt(files: readonly string[]): string {
  const named =
    files.length === 0
      ? "The worktree has an unresolved merge conflict."
      : [
          "The worktree has an unresolved merge conflict in these files:",
          ...files.map((file) => `- ${file}`),
        ].join("\n");
  return [
    named,
    "The branch has a merge of the latest main in progress, and resolving it is part of this attempt. Start by resolving every conflict, then commit the merge and continue with the task.",
  ].join("\n\n");
}

/** Builds the prompt a worker reads: conflict note, worker brief, task brief. */
export function buildWorkerPrompt(
  worktree: string,
  workerBrief: string,
  task: TaskData,
  previous?: Progress,
): string {
  const pieces: string[] = [];
  if (previous !== undefined) pieces.push(previousAttemptText(previous));
  if (mergeInProgress(worktree)) {
    pieces.push(conflictPrompt(conflictedFiles(worktree)));
  }
  pieces.push(workerBrief.trim());
  const taskText = briefText(task).trim();
  if (taskText.length > 0) pieces.push(taskText);
  return pieces.join("\n\n");
}

interface HarnessReading {
  readonly sessionId: string | null;
  readonly costMicros: number | null;
  readonly costQuality: CostQuality | null;
  readonly cost: number | null;
  readonly log: string | null;
  readonly tokens: { readonly input: number; readonly output: number } | null;
  readonly durationMs: number | null;
}

function harnessReading(
  data: Record<string, unknown>,
  onProblem?: (message: string) => void,
): HarnessReading {
  const sessionId =
    typeof data.sessionId === "string" ? data.sessionId : null;
  // The one reader of a step's usage: it takes the standard field and, for
  // a fact written before it existed, the old fields.
  const usage = readUsage(data, onProblem);
  const micros = usage?.costMicros ?? null;
  return {
    sessionId,
    costMicros: micros,
    costQuality: usage?.costQuality ?? null,
    cost: micros === null ? null : micros / 1_000_000,
    log: typeof data.log === "string" && data.log.length > 0 ? data.log : null,
    tokens:
      // A run that reported no tokens at all has none to show.
      usage === undefined || (usage.tokens.input === 0 && usage.tokens.output === 0)
        ? null
        : { input: usage.tokens.input, output: usage.tokens.output },
    durationMs:
      typeof data.durationMs === "number" && Number.isFinite(data.durationMs)
        ? data.durationMs
        : null,
  };
}

function resultData(
  attempt: TaskAttempt,
  reading: HarnessReading,
  extra: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    attempt: attempt.number,
    sessionId: reading.sessionId,
    cost: reading.cost,
    costMicros: reading.costMicros,
    costQuality: reading.costQuality,
    ...extra,
  };
}

/**
 * The params of the `pool/agent` call: the `default` pool's definitions, the
 * key prefix `<repository>/default`, and the worker a rework goes back to.
 */
function poolParams(
  prompt: string,
  worktree: string,
  repository: RepositoryData,
  settings: DevSettings,
  worker: string | undefined,
  resumeSession: string | undefined,
  inbox: unknown,
  holder: string,
  stage?: { readonly use?: string | undefined; readonly args?: readonly string[] | undefined },
): Record<string, unknown> {
  const resolved = resolvePool(settings.workers, DEFAULT_POOL);
  // A stage may name its own harness step or arguments. A named step runs as
  // one worker; arguments alone replace the pool's.
  const workers: readonly WorkerDefinition[] =
    stage?.use === undefined
      ? stage?.args === undefined
        ? resolved.workers
        : resolved.workers.map((item) => ({ ...item, args: stage.args as readonly string[] }))
      : [{ name: "flow", use: stage.use, args: stage.args ?? [], count: 1 }];
  // A fallback worker that ran is not a member of the pool; hand it over as
  // one so pool/agent can be asked for it by name.
  const fallback =
    worker === undefined || workers.some((item) => item.name === worker)
      ? undefined
      : resolved.fallbacks.find((item) => item.name === worker);
  return {
    prompt,
    cwd: worktree,
    inbox,
    prefix: `${repository.name}/${DEFAULT_POOL}`,
    holder,
    workers: fallback === undefined ? workers : [...workers, fallback],
    fallbacks: resolved.fallbacks,
    ...(worker === undefined ? {} : { worker }),
    ...(worker !== undefined && resumeSession !== undefined ? { resumeSession } : {}),
  };
}

/** The harness overrides a work stage wrote in its params. */
function stageParamsOf(params: unknown): {
  readonly use?: string | undefined;
  readonly args?: readonly string[] | undefined;
} {
  const given = (params ?? {}) as { readonly flowUse?: unknown; readonly flowArgs?: unknown };
  const use = typeof given.flowUse === "string" ? given.flowUse : undefined;
  const args =
    Array.isArray(given.flowArgs) &&
    given.flowArgs.every((item): item is string => typeof item === "string")
      ? given.flowArgs
      : undefined;
  return {
    ...(use === undefined ? {} : { use }),
    ...(args === undefined ? {} : { args }),
  };
}

/** The preparation a work stage asks for before its attempt. */
type BeforeAttempt = "merge-main" | "none";

function beforeAttemptOf(params: unknown): BeforeAttempt | undefined {
  const given = ((params ?? {}) as { readonly beforeAttempt?: unknown }).beforeAttempt;
  return given === "merge-main" || given === "none" ? given : undefined;
}

/** The history line of a work run: `claude`, or `pi (fallback from claude)`. */
function workLine(attempt: TaskAttempt): string {
  const base = `work: ${String(attempt.worker)}`;
  const from = attempt.fallbackFrom;
  const changed = attempt.workerChanged;
  return [
    typeof from === "string" ? `${base} (fallback from ${from})` : base,
    typeof changed === "string" ? `; ${changed} is no longer in the pool` : "",
  ].join("");
}

/** Step `dev/work`: run the configured harness step and decide what it left. */
/** True when the harness reported that its model is unavailable or at its usage limit. */
function modelUnavailable(data: Record<string, unknown>): boolean {
  const error = data.modelError;
  if (typeof error !== "object" || error === null) return false;
  const kind = (error as { readonly kind?: unknown }).kind;
  return kind === "unavailable" || kind === "usage_limit";
}

/** True when the attempt's verify passed on exactly `head`. */
function passedAt(attempt: TaskAttempt | undefined, head: string | null): boolean {
  return (
    head !== null &&
    attempt?.verified === head &&
    attempt.verify?.result === "pass"
  );
}

const UNCHECKED_WORK_NOTE = "the branch already has unchecked work; checking it";

/** True when the branch holds commits of its own (not a merge of main) that main lacks and `head` never passed verify. */
function hasUncheckedWork(
  path: string,
  head: string,
  attempt: TaskAttempt,
  context: { readonly settings: { readonly remote: string; readonly mainBranch: string } },
): boolean {
  if (attempt.verified === head && attempt.verify?.result === "pass") return false;
  const mainRef = `${context.settings.remote}/${context.settings.mainBranch}`;
  const ahead = git(path, ["rev-list", "--count", "--no-merges", `${mainRef}..${head}`]);
  return ahead.ok && Number(ahead.out) > 0;
}

export async function runWork(ctx: StepContext): Promise<PluginStepResult> {
  const loose = await looseTaskContext(ctx);
  if (!claimAllows(ctx, loose.task)) return cancelledStep();
  if (loose.settings === undefined) {
    // Not the task's fault: record why, and the flow retries once.
    const message = loose.settingsError ?? "the settings could not be read";
    const written = await saveTaskGuarded(
      ctx,
      loose.taskKey,
      {
        ...loose.task,
        stop: {
          step: "work",
          result: "failed",
          reason: STOP_REASONS.settingsUnreadable,
        },
      },
      "dev:work",
    );
    if (!written) return cancelledStep();
    return {
      result: "failed",
      data: { reason: STOP_REASONS.settingsUnreadable, message },
    };
  }
  const context: TaskContext = { ...loose, settings: loose.settings };
  const task = context.task;
  const path =
    task.attempt?.worktree ??
    worktreePath(context.repository.path, context.settings, context.taskId);
  const branch = task.attempt?.branch ?? workBranch(context.taskId);
  const attempt: TaskAttempt = task.attempt ?? {
    number: Math.max(task.attempts, 0) + 1,
    run: ctx.runId,
  };
  const attempts = Math.max(task.attempts, attempt.number);
  const base = attempt.base ?? headOf(path) ?? null;

  if (!existsSync(path) || !isWorktree(path)) {
    const nextAttempt: TaskAttempt = {
      ...attempt,
      run: ctx.runId,
      worktree: path,
      branch,
      base,
      result: "failed",
      worked: true,
    };
    const written = await saveTaskGuarded(
      ctx,
      context.taskKey,
      {
        ...task,
        phase: "waiting",
        run: ctx.runId,
        attempts,
        attempt: nextAttempt,
      },
      "dev:work",
    );
    if (!written) return cancelledStep();
    return {
      result: "failed",
      data: resultData(nextAttempt, harnessReading({}), {
        reason: "no_worktree",
        message: `no worktree at ${path}; run the worktree step first`,
      }),
    };
  }

  if (beforeAttemptOf(ctx.params) === "merge-main") {
    const remote = context.settings.remote;
    const mainRef = `${remote}/${context.settings.mainBranch}`;
    const failBefore = async (message: string): Promise<PluginStepResult> => {
      const nextAttempt: TaskAttempt = {
        ...attempt,
        run: ctx.runId,
        worktree: path,
        branch,
        base,
        result: "failed",
        worked: true,
      };
      const written = await saveTaskGuarded(
        ctx,
        context.taskKey,
        {
          ...task,
          phase: "waiting",
          run: ctx.runId,
          attempts,
          attempt: nextAttempt,
        },
        "dev:work",
      );
      if (!written) return cancelledStep();
      return {
        result: "failed",
        data: resultData(nextAttempt, harnessReading({}), {
          reason: "before_attempt",
          message,
        }),
      };
    };
    const fetch = git(context.repository.path, ["fetch", "--prune", remote]);
    if (!fetch.ok) {
      return failBefore(
        `cannot fetch "${remote}": ${fetch.err || fetch.out || "git fetch failed"}`,
      );
    }
    const prepared = mergeLatest(path, mainRef);
    if (prepared.kind === "failed") {
      return failBefore(prepared.message ?? `cannot merge "${mainRef}"`);
    }
  }

  const workerBrief = await readWorkerBrief(
    context.repository.path,
    context.settings,
  );
  const prompt = buildWorkerPrompt(
    path,
    workerBrief,
    task,
    progressOf(attempt.previousProgress),
  );
  const stageBrief = (() => {
    const given = ((ctx.params ?? {}) as { readonly flowBrief?: unknown }).flowBrief;
    return typeof given === "string" && given.trim().length > 0 ? given.trim() : undefined;
  })();
  const finalPrompt =
    stageBrief === undefined ? prompt : `${prompt}\n\n${stageBrief}`;
  // A note from an earlier visit is in the task's data by now; the worker
  // writes a fresh one.
  rmSync(join(path, PROGRESS_FILE), { force: true });
  const runStep = ctx.runStep;
  if (runStep === undefined) {
    const nextAttempt: TaskAttempt = {
      ...attempt,
      run: ctx.runId,
      worktree: path,
      branch,
      base,
      result: "failed",
      worked: true,
    };
    const written = await saveTaskGuarded(
      ctx,
      context.taskKey,
      {
        ...task,
        phase: "waiting",
        run: ctx.runId,
        attempts,
        attempt: nextAttempt,
      },
      "dev:work",
    );
    if (!written) return cancelledStep();
    return {
      result: "failed",
      data: resultData(nextAttempt, harnessReading({}), {
        reason: "no_host",
        message: "the kernel did not offer a way to run the configured harness step",
      }),
    };
  }

  // The step stops the worker itself a little before its time limit, so it
  // can still commit what is left; the kernel's own timeout stays behind it.
  const stopper = new AbortController();
  const forwardAbort = (): void => stopper.abort();
  if (ctx.signal.aborted) stopper.abort();
  else ctx.signal.addEventListener("abort", forwardAbort, { once: true });
  const options: StepRunOptions = {
    runId: ctx.runId,
    cwd: path,
    ...(ctx.object === undefined ? {} : { object: ctx.object }),
    params: ctx.params,
    access: ctx.access,
    ...(ctx.trigger === undefined ? {} : { trigger: ctx.trigger }),
    signal: stopper.signal,
  };
  // A rework or reject goes back to the worker that ran the attempt before,
  // and resumes its session when the harness can. When that worker is no
  // longer in the pool, any free worker takes it and the change is recorded.
  const before =
    typeof attempt.previousWorker === "string" && attempt.previousWorker.length > 0
      ? attempt.previousWorker
      : undefined;
  const stillThere =
    before !== undefined &&
    (() => {
      const resolved = resolvePool(context.settings.workers, DEFAULT_POOL);
      return [...resolved.workers, ...resolved.fallbacks].some(
        (worker) => worker.name === before,
      );
    })();
  const asked = stillThere ? before : undefined;
  const workerChangedFrom = before !== undefined && !stillThere ? before : undefined;
  const clock = stepTestHooks.workClock ?? realWorkClock;
  let timedOut = false;
  const timeOut = (): void => {
    timedOut = true;
    stopper.abort();
  };
  // The step's own limit is the backstop, counted from the step's start. A
  // harness that can take a message says when its run begins and how long it
  // may run (its wall time, which starts after the pool gave it a place), and
  // the wrap-up and the stop are timed from then.
  let limitMs = STEP_TIMEOUT_SECS * 1000;
  const timers: unknown[] = [
    clock.setTimeout(timeOut, limitMs - limitMarginMs(limitMs)),
  ];
  let runTimers: unknown[] = [];
  const outbox = createOutbox((runMs) => {
    for (const timer of runTimers) clock.clearTimeout(timer);
    limitMs = runMs;
    const hardMs = runMs - limitMarginMs(runMs);
    const wrapMs = Math.min(
      Math.floor(runMs * context.settings.work.wrapUpAt),
      hardMs,
    );
    runTimers = [
      clock.setTimeout(() => outbox.send(wrapUpMessage()), wrapMs),
      clock.setTimeout(timeOut, hardMs),
    ];
  });
  let outcome: PluginStepResult | undefined;
  let hostError: string | undefined;
  let notLoaded: string | undefined;
  // While a rework waits for the worker it asked for, the task says what it
  // waits for and who holds it, in the row and in the step log.
  let waitingFor: string | undefined;
  const setWorkerWait = async (text: string | null): Promise<void> => {
    await saveTaskGuarded(
      ctx,
      context.taskKey,
      { ...task, attempt: { ...attempt, workerWait: text } },
      "dev:work-wait",
    );
  };
  const onPoolEvent = async (_plugin: string, event: StepEvent): Promise<void> => {
    if (asked === undefined) return;
    const data: unknown = event.data;
    if (event.type === WAITING_EVENT) {
      const entries = Array.isArray((data as { workers?: unknown } | undefined)?.workers)
        ? ((data as { workers: unknown[] }).workers)
        : [];
      const mine = entries.find(
        (entry): entry is { holders?: unknown } =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { worker?: unknown }).worker === asked,
      );
      const holders = Array.isArray(mine?.holders)
        ? mine.holders.filter((item): item is string => typeof item === "string")
        : [];
      const line = `waiting for worker ${asked}${
        holders.length === 0 ? "" : `: held by ${holders.join(", ")}`
      }`;
      waitingFor = line;
      await ctx.logger.write(line);
      await setWorkerWait(line);
    } else if (event.type === ACQUIRED_EVENT && waitingFor !== undefined) {
      waitingFor = undefined;
      await ctx.logger.write(`worker ${asked} is free; the work starts`);
      await setWorkerWait(null);
    }
  };
  try {
    outcome = await runStep(
      "pool/agent",
      poolParams(
        finalPrompt,
        path,
        context.repository,
        context.settings,
        asked,
        typeof attempt.previousSession === "string" ? attempt.previousSession : undefined,
        outbox.inbox,
        context.taskId,
        stageParamsOf(ctx.params),
      ),
      { ...options, observe: onPoolEvent },
    );
  } catch (error) {
    hostError = messageOf(error);
    notLoaded = notLoadedStep(error);
  } finally {
    if (waitingFor !== undefined) {
      waitingFor = undefined;
      await ctx.logger.write(`stopped waiting for worker ${String(asked)}`).catch(() => undefined);
    }
    for (const timer of [...timers, ...runTimers]) clock.clearTimeout(timer);
    ctx.signal.removeEventListener("abort", forwardAbort);
  }
  const outcomeData =
    outcome !== undefined &&
    typeof outcome.data === "object" &&
    outcome.data !== null
      ? (outcome.data as Record<string, unknown>)
      : {};
  const reading = harnessReading(outcomeData, (problem) => {
    // A usage the harness got wrong is the harness's bug; say which run.
    void ctx.logger
      .write(`run ${ctx.runId}: the harness reported a usage that is not standard: ${problem}`)
      .catch(() => undefined);
  });

  let nextAttempt: TaskAttempt = {
    ...attempt,
    run: ctx.runId,
    worktree: path,
    branch,
    base,
    sessionId: reading.sessionId,
    cost: reading.cost,
    costMicros: reading.costMicros,
    costQuality: reading.costQuality,
    workLog: reading.log,
    tokens: reading.tokens,
    workMs: reading.durationMs,
    worked: true,
    // The worker the pool ran, so the next attempt can ask for it again.
    worker: typeof outcomeData.worker === "string" ? outcomeData.worker : null,
    fallbackFrom:
      typeof outcomeData.fallbackFrom === "string" ? outcomeData.fallbackFrom : null,
    workerChanged: workerChangedFrom ?? null,
  };

  // The worker ran past its limit: the step stopped it, or the harness's own
  // wall time did.
  const timedOutRun =
    outcome?.result !== "done" &&
    (timedOut ||
      (outcomeData.reason === "wall" && hostError === undefined));

  const finish = async (
    result: string,
    extra: Readonly<Record<string, unknown>>,
    waitsForModel = false,
  ): Promise<PluginStepResult> => {
    const note = readNote(path);
    const progress: Progress | undefined =
      note === null && !timedOutRun
        ? undefined
        : { note, commits: commitsSince(path, base), timedOut: timedOutRun };
    nextAttempt = {
      ...nextAttempt,
      result,
      workNote:
        result !== "done" && typeof extra.message === "string" ? extra.message : null,
      ...(waitsForModel ? {} : { workRetryAt: null }),
      // An attempt that left no note keeps the one before it for later attempts.
      progress: progress ?? progressOf(attempt.previousProgress) ?? null,
      workTimedOut: timedOutRun,
    };
    const reason = typeof extra.reason === "string" ? extra.reason : "";
    const stop: StopRecord | null =
      result === "failed"
        ? {
            step: "work",
            result,
            reason,
            ...(typeof extra.use === "string" ? { use: extra.use } : {}),
          }
        : null;
    // A failure outside the task's work is retried by the flow, not by a person.
    const retried =
      stop !== null &&
      classifyStop({ step: "work", result, reason, use: stop.use }).kind ===
        "environment";
    const written = await saveTaskGuarded(
      ctx,
      context.taskKey,
      {
        ...task,
        stop,
        // Only `done` continues to the gate; every other result goes to the
        // person wait, and the task says so while it waits. A model that is
        // unavailable is not a person's business: the work step runs again.
        phase:
          result === "done" || waitsForModel || retried ? "running" : "waiting",
        run: ctx.runId,
        attempts,
        attempt: nextAttempt,
        ...(reading.cost === null
          ? {}
          : { cost: reading.cost, costQuality: reading.costQuality }),
      },
      "dev:work",
    );
    if (!written) return cancelledStep();
    return {
      result,
      data: resultData(nextAttempt, reading, {
        worktree: path,
        path,
        branch,
        base,
        prompt,
        ...(progress === undefined
          ? {}
          : { progress: progress.note, commits: progress.commits }),
        ...(nextAttempt.worker === null || nextAttempt.worker === undefined
          ? {}
          : {
              work: workLine(nextAttempt),
              worker: nextAttempt.worker,
              ...(typeof nextAttempt.fallbackFrom === "string"
                ? { fallbackFrom: nextAttempt.fallbackFrom }
                : {}),
            }),
        ...extra,
      }),
    };
  };

  untrackNote(path);
  if (timedOutRun) {
    const committed = commitWip(path);
    const left = changedFiles(path);
    const seconds = Math.round(limitMs / 1000);
    return finish("failed", {
      reason: "timeout",
      message: `the work ran out of time (${seconds}s); ${
        committed
          ? "what it left was committed as work in progress"
          : left.length === 0
            ? "nothing was left uncommitted"
            : `uncommitted changes: ${left.join(", ")}`
      }`,
      ...(left.length === 0 ? {} : { files: left }),
    });
  }

  // Inspect the tree before deciding: a harness failure must still name what
  // it left uncommitted, and a success must still fail on a dirty tree.
  const dirty = changedFiles(path);

  if (hostError !== undefined) {
    return finish("failed", {
      reason: notLoaded === undefined ? "harness" : STOP_REASONS.stepNotLoaded,
      ...(notLoaded === undefined ? {} : { use: notLoaded }),
      message: hostError,
      ...(dirty.length === 0 ? {} : { files: dirty }),
    });
  }

  if (outcome !== undefined && outcome.result !== "done") {
    const waits = typeof attempt.workWaits === "number" ? attempt.workWaits : 0;
    if (modelUnavailable(outcomeData) && waits < MAX_WORK_WAITS) {
      const retryAt = Date.now() + context.settings.reviewer.retrySecs * 1000;
      nextAttempt = { ...nextAttempt, workWaits: waits + 1, workRetryAt: retryAt };
      return finish(
        "unavailable",
        {
          reason: "model_unavailable",
          message: `the worker's model was unavailable; the work runs again at ${new Date(retryAt).toISOString()}`,
          retryAt,
          ...(dirty.length === 0 ? {} : { files: dirty }),
        },
        true,
      );
    }
  }

  if (outcome === undefined || outcome.result !== "done") {
    const message =
      typeof outcomeData.message === "string"
        ? outcomeData.message
        : `the harness step ended "${outcome?.result ?? "unknown"}"`;
    // A harness that was stopped, or killed by a signal no cancel sent, says
    // nothing about the work.
    const stopped =
      outcome?.result === "interrupted" &&
      (outcomeData.reason === "signal" || outcomeData.reason === "cancelled");
    return finish("failed", {
      reason: stopped ? STOP_REASONS.stopped : "harness",
      harnessResult: outcome?.result ?? "unknown",
      // A failed attempt still reports the files it left behind.
      message:
        dirty.length === 0
          ? message
          : `${message}; uncommitted changes: ${dirty.join(", ")}`,
      ...(dirty.length === 0 ? {} : { files: dirty }),
      stderr: outcomeData.stderr ?? [],
    });
  }

  if (dirty.length > 0) {
    return finish("failed", {
      reason: "changes",
      files: dirty,
      message: `uncommitted changes: ${dirty.join(", ")}`,
    });
  }

  const head = headOf(path);
  let note: string | undefined;
  if (
    head === undefined ||
    base === null ||
    head === base ||
    // A reset below the base, or to unrelated history, is not new work: the
    // branch must still descend from the base before anything is pushed.
    !isAncestor(path, base, head)
  ) {
    if (head !== undefined && head === base && hasUncheckedWork(path, head, attempt, context)) {
      // An earlier run committed this work and stopped before verify ended.
      note = UNCHECKED_WORK_NOTE;
    } else {
      return finish("nothing", { head: head ?? base });
    }
  }

  const push = git(path, [
    "push",
    context.settings.remote,
    `HEAD:refs/heads/${branch}`,
  ]);
  if (!push.ok) {
    return finish("failed", {
      reason: "push",
      head,
      message: `cannot push "${branch}" to "${context.settings.remote}": ${push.err || push.out}`,
    });
  }
  return finish("done", {
    head,
    pushed: true,
    ...(note === undefined ? {} : { message: note }),
  });
}
