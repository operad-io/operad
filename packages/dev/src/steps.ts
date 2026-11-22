/**
 * The two steps a task runs before a check: `worktree` gives it a branch and a
 * worktree, `work` asks a harness step to do the task and reads the result.
 * The kernel never runs git or a harness itself; both live here in `dev`.
 */

import { withWorkerReports } from "@operad-io/engine/platform";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  isRecord,
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
  idOfKey,
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
import { now as devNow } from "./clock.ts";
import { modelErrorIn, modelWaitsForPerson } from "./model-error.ts";
import {
  branchExists,
  git,
  headOf,
  isAncestor,
  type GitResult,
} from "./git.ts";
import { runPrepare, taskStepAccess } from "./prepare.ts";
import { classifyStop, isConnectionError, STOP_REASONS } from "./stops.ts";
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
  devSettingsFromText,
  readDevSettings,
  readDevSettingsText,
  readWorkerBrief,
  type DevSettings,
} from "./settings.ts";

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

/**
 * Where a task's work is done: its own worktree, or the main clone itself when
 * the repository works in a branch of its folder (ADR 0039 D1).
 */
export function workPath(
  repository: RepositoryData,
  settings: DevSettings,
  taskId: string,
): string {
  return settings.workIn === "branch"
    ? repository.path
    : worktreePath(repository.path, settings, taskId);
}

/** The branch a task's worktree is on. */
export function workBranch(taskId: string): string {
  return `work/${taskId}`;
}

/** The step a host error says was not loaded; undefined for any other error. */
function notLoadedStep(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return error.kind === "step_not_loaded" && typeof error.use === "string"
    ? error.use
    : undefined;
}

export interface TaskContext {
  readonly task: TaskData;
  readonly repository: RepositoryData;
  readonly taskKey: string;
  readonly taskId: string;
  /** The name of the task's worktree and branch: the task id, or the chat worktree it was opened on. */
  readonly workName: string;
  readonly settings: DevSettings;
  /** The dev.json text `settings` came from; empty when the file does not exist. */
  readonly settingsText?: string;
}

/**
 * The task's context. The settings are the ones the task's attempt recorded
 * when it started (ADR 0039 D6); `fresh` reads the file instead, for the step
 * that starts an attempt.
 */
export async function taskContext(
  ctx: StepContext,
  fresh: boolean = false,
): Promise<TaskContext> {
  const parts = await taskParts(ctx);
  const recorded = parts.task.attempt?.settingsText;
  if (!fresh && typeof recorded === "string") {
    return {
      ...parts,
      settings: devSettingsFromText(parts.repository.path, recorded),
      settingsText: recorded,
    };
  }
  const read = readDevSettingsText(parts.repository.path);
  return { ...parts, settings: read.settings, settingsText: read.text };
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
      (candidate) => idOfKey(candidate.id) === object.id,
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
  const taskId = idOfKey(stored?.id ?? object.id);
  let taskKey = stored?.id ?? object.id;
  if ((await ctx.store.get("task", taskKey)) === undefined) {
    taskKey = storeKey(repository.name, taskId);
  }
  return { task, repository, taskKey, taskId, workName: task.worktree ?? taskId };
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

/** The branch an attempt recorded the main clone as being on before the task's. */
function startBranchOf(attempt: TaskAttempt | undefined): string | undefined {
  const value = attempt?.startBranch;
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

// One `git status --porcelain` entry: its two status letters and its path.
interface CheckoutEntry {
  readonly code: string;
  readonly path: string;
  /** What the path held when it was read, when it is a readable file. */
  readonly content?: string | undefined;
}

// The status entries of a checkout, read from `--porcelain -z`: names are not
// quoted or trimmed, a name may hold spaces or newlines, and a rename or copy
// is followed by its old path, which is skipped. `--no-optional-locks` stops git
// from refreshing the index, so reading the checkout writes no metadata.
function checkoutEntries(checkout: string): readonly CheckoutEntry[] {
  const result = git(checkout, ["--no-optional-locks", "status", "--porcelain", "-z"], true);
  if (!result.ok || result.out.length === 0) return [];
  const entries = result.out.split("\0");
  const status: CheckoutEntry[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    status.push({ code, path: entry.slice(3) });
    if (code.includes("R") || code.includes("C")) index += 1;
  }
  return status;
}

function checkoutEntryKey(entry: CheckoutEntry): string {
  return `${entry.code}\0${entry.path}`;
}

/**
 * What a status path holds, so a further edit to a file that was already
 * changed before the step is a change too: its status letters and path stay the
 * same when it is edited again. A deleted file, a collapsed untracked directory
 * and any other unreadable path have none, and their status letters are all
 * they compare by. Only a checkout that is already dirty is read, so a clean
 * main checkout costs nothing.
 */
function checkoutContent(checkout: string, path: string): string | undefined {
  const file = join(checkout, path);
  try {
    if (!statSync(file).isFile()) return undefined;
    return Bun.hash(readFileSync(file)).toString(16);
  } catch {
    return undefined;
  }
}

/** The status entries of a checkout, with what each readable file holds. */
function checkoutSnapshot(checkout: string): readonly CheckoutEntry[] {
  return checkoutEntries(checkout).map((entry) => {
    const content = checkoutContent(checkout, entry.path);
    return content === undefined ? entry : { ...entry, content };
  });
}

// True when a status path is the task's worktree or lies inside it.
function insideWorktree(checkout: string, worktree: string, path: string): boolean {
  const root = relative(checkout, worktree).replace(/\\/g, "/");
  if (root.length === 0) return true;
  if (root.startsWith("..")) return false;
  const candidate = path.replace(/\\/g, "/");
  return candidate === root || candidate.startsWith(`${root}/`);
}

// The paths whose status in the main checkout is new since `before`, or whose
// file was edited again since then, leaving out the task's own worktree, whose
// presence there the worktree explains.
function newCheckoutChanges(
  checkout: string,
  worktree: string,
  before: readonly CheckoutEntry[],
): readonly string[] {
  const seen = new Map(before.map((entry) => [checkoutEntryKey(entry), entry]));
  const changed: string[] = [];
  for (const entry of checkoutEntries(checkout)) {
    const was = seen.get(checkoutEntryKey(entry));
    // The same status letters and path: only a further edit to the file itself
    // is a change. A path that was unreadable then has no content to compare.
    if (was !== undefined) {
      if (was.content === undefined) continue;
      if (checkoutContent(checkout, entry.path) === was.content) continue;
    }
    if (!insideWorktree(checkout, worktree, entry.path)) changed.push(entry.path);
  }
  return [...new Set(changed)].sort();
}

// The files `git status` calls changed, untracked included. Read from
// `--porcelain -z`: names are not quoted or trimmed, a name may hold spaces, and
// a rename or copy is followed by its old path, which is skipped (the new path
// is the changed file).
export function changedFiles(worktree: string): readonly string[] {
  return [
    ...new Set(
      checkoutEntries(worktree)
        .map((entry) => entry.path)
        .filter((file) => file !== PROGRESS_FILE),
    ),
  ].sort();
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
  /** In branch mode: the branch the main clone was on before the task's. */
  readonly startBranch?: string | undefined;
  /** In branch mode: the task was cancelled while the step was preparing. */
  readonly cancelled?: boolean | undefined;
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

/** True for the root and package files whose rows are appended, never moved. */
function isMutationFile(path: string): boolean {
  const parts = path.split("/");
  return (
    path === "MUTATIONS.md" ||
    (parts.length >= 3 &&
      parts[0] === "packages" &&
      parts[parts.length - 1] === "MUTATIONS.md")
  );
}

/** The lines of a file; a final newline does not add an empty last line. */
function linesOf(text: string): readonly string[] {
  if (text === "") return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

/** The lines `after` has beyond a longest common subsequence with `before`. */
function linesOnlyIn(before: readonly string[], after: readonly string[]): readonly string[] {
  const table: Uint32Array[] = Array.from(
    { length: before.length + 1 },
    () => new Uint32Array(after.length + 1),
  );
  for (let row = before.length - 1; row >= 0; row -= 1) {
    const line = table[row];
    const next = table[row + 1];
    if (line === undefined || next === undefined) continue;
    for (let column = after.length - 1; column >= 0; column -= 1) {
      line[column] =
        before[row] === after[column]
          ? (next[column + 1] ?? 0) + 1
          : Math.max(next[column] ?? 0, line[column + 1] ?? 0);
    }
  }
  const added: string[] = [];
  let row = 0;
  let column = 0;
  while (row < before.length && column < after.length) {
    if (before[row] === after[column]) {
      row += 1;
      column += 1;
    } else if ((table[row + 1]?.[column] ?? 0) >= (table[row]?.[column + 1] ?? 0)) {
      row += 1;
    } else {
      const line = after[column];
      if (line !== undefined) added.push(line);
      column += 1;
    }
  }
  while (column < after.length) {
    const line = after[column];
    if (line !== undefined) added.push(line);
    column += 1;
  }
  return added;
}

/** The lines `after` has in addition to the counts of the same lines in `before`. */
function linesBeyond(before: readonly string[], after: readonly string[]): readonly string[] {
  const left = new Map<string, number>();
  for (const line of before) left.set(line, (left.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of after) {
    const count = left.get(line) ?? 0;
    if (count === 0) added.push(line);
    else left.set(line, count - 1);
  }
  return added;
}

/** The lines a task appended to a file since the merge base. */
function taskAddition(baseText: string, taskText: string): readonly string[] {
  if (taskText.startsWith(baseText)) return linesOf(taskText.slice(baseText.length));
  return linesOnlyIn(linesOf(baseText), linesOf(taskText));
}

/**
 * Main's file unchanged, then the task's appended lines, then anything else the
 * merged file has. A union merge puts the task's rows before main's, so the
 * task's lines would otherwise sit inside main's file instead of after it. The
 * task's own version says exactly which lines it appended, so a blank line or
 * table header that is also in main's file is kept.
 */
function mainFirst(
  mainText: string,
  taskText: string,
  baseText: string,
  mergedText: string,
): string {
  const taskLines = taskAddition(baseText, taskText);
  const extra = linesBeyond([...linesOf(mainText), ...taskLines], linesOf(mergedText));
  const added = [...taskLines, ...extra];
  while (added[0]?.trim() === "") added.shift();
  while (added[added.length - 1]?.trim() === "") added.pop();
  if (added.length === 0) return mainText;
  let text = mainText;
  if (text.length > 0 && !text.endsWith("\n")) text += "\n";
  if (text.length > 0 && !text.endsWith("\n\n")) text += "\n";
  return `${text}${added.join("\n")}\n`;
}

/** A MUTATIONS.md main changed since a branch tip, and the merge base it changed from. */
type MutationChange = {
  readonly file: string;
  readonly base: string;
};

/** The MUTATIONS.md files main changed since a branch tip. */
function mainChangedMutations(
  path: string,
  before: string,
  mainRef: string,
): readonly MutationChange[] {
  const base = git(path, ["merge-base", before, mainRef]);
  if (!base.ok || base.out.length === 0) return [];
  const diff = git(path, ["diff", "--name-only", base.out, mainRef]);
  if (!diff.ok) return [];
  return diff.out
    .split("\n")
    .filter((file) => isMutationFile(file))
    .map((file) => ({ file, base: base.out }));
}

/** Rewrites the merged MUTATIONS.md files with main's rows first; returns those it changed. */
function mainFirstMutations(
  path: string,
  mainRef: string,
  taskRef: string,
  files: readonly MutationChange[],
): readonly string[] {
  const conflicted = new Set(conflictedFiles(path));
  const changed: string[] = [];
  for (const { file, base } of files) {
    if (conflicted.has(file)) continue;
    const main = git(path, ["show", `${mainRef}:${file}`], true);
    const task = git(path, ["show", `${taskRef}:${file}`], true);
    const fromBase = git(path, ["show", `${base}:${file}`], true);
    const merged = join(path, file);
    if (!main.ok || !task.ok || !fromBase.ok || !existsSync(merged)) continue;
    const current = readFileSync(merged, "utf8");
    const next = mainFirst(main.out, task.out, fromBase.out, current);
    if (next === current) continue;
    writeFileSync(merged, next);
    changed.push(file);
  }
  return changed;
}

/** Amends the merge, or commits after an extra worker commit, with the rewritten files. */
function commitMainFirstMutations(
  path: string,
  files: readonly string[],
  mergeHead?: string | undefined,
): boolean {
  if (files.length === 0) return true;
  const added = git(path, ["add", "--", ...files]);
  if (!added.ok) return false;
  const second = git(path, ["rev-parse", "--verify", "--quiet", "HEAD^2"]);
  const amend =
    second.ok && (mergeHead === undefined || second.out === mergeHead);
  return git(path, [
    "commit",
    ...(amend ? ["--amend", "--no-edit"] : ["-m", "mutations: keep main's rows first"]),
    "--no-verify",
  ]).ok;
}

/** Merges the fetched main into a reused branch and reports a conflict. */
function mergeLatest(path: string, mainRef: string): Prepared {
  const before = headOf(path);
  const commit = git(path, ["rev-parse", "--short", mainRef]).out;
  const mutationFiles =
    before === undefined ? [] : mainChangedMutations(path, before, mainRef);
  const merge = git(path, ["merge", "--no-edit", "--no-ff", mainRef]);
  if (!merge.ok) {
    const files = conflictedFiles(path);
    if (files.length > 0 || mergeInProgress(path)) {
      // The worker will commit the merge after resolving the other files; put
      // main's rows first now so that commit already has the right order.
      const changed =
        before === undefined
          ? []
          : mainFirstMutations(path, mainRef, before, mutationFiles);
      if (changed.length > 0) git(path, ["add", "--", ...changed]);
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
  const changed =
    before === undefined
      ? []
      : mainFirstMutations(path, mainRef, before, mutationFiles);
  if (changed.length > 0 && !commitMainFirstMutations(path, changed)) {
    return failed(`cannot keep main's rows first in ${changed.join(", ")}`);
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
  } else if (branchExists(repository.path, branch, settings.remote)) {
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

/** Adds a line to the repository's own ignore list, so git status never shows it. */
function excludeFromStatus(repositoryPath: string, entry: string): void {
  const path = git(repositoryPath, ["rev-parse", "--git-path", "info/exclude"]);
  if (!path.ok) return;
  const excludePath = resolve(repositoryPath, path.out);
  try {
    mkdirSync(dirname(excludePath), { recursive: true });
    const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    const lines = current.replace(/\r\n/g, "\n").split("\n");
    if (lines.some((line) => line.trim() === entry)) return;
    const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    appendFileSync(excludePath, `${prefix}${entry}\n`, "utf8");
  } catch {
    // Without the entry the note shows as an untracked file; the step goes on.
  }
}

export interface BranchOptions {
  /** The start branch this attempt already recorded (a replay of the step). */
  readonly recorded?: string | undefined;
  /** The start branch an earlier attempt recorded; used only while the clone is on the task's branch. */
  readonly carried?: string | undefined;
  readonly mergeMain: boolean;
  /**
   * Called once, with the branch the clone is on, before the clone is switched,
   * so a crash after the switch still knows where to switch back to. False
   * says the task was cancelled.
   */
  readonly beforeSwitch?: ((start: string) => Promise<boolean>) | undefined;
}

/** A message names at most this many files of a dirty clone. */
const NAMED_FILES = 20;

function namedFiles(files: readonly string[]): string {
  const shown = files.slice(0, NAMED_FILES).join(", ");
  return files.length > NAMED_FILES
    ? `${shown} and ${String(files.length - NAMED_FILES)} more`
    : shown;
}

/**
 * The branch mode of `prepareWorktree` (ADR 0039 D1, D4): the task works on
 * `work/<id>` in the main clone itself. The clone is in one of three states
 * when the step runs, told apart by the branch it is on:
 *
 * - on `work/<id>`: the step goes on from an earlier visit (a rework, or a
 *   crash after the switch). Edits in the tree are the worker's own, so main
 *   is not merged into a dirty tree.
 * - on the branch the task started on, or on any branch the first time: the
 *   clone must be clean, then it is switched.
 * - on another branch than the recorded start: the person moved it; the step
 *   stops and says so instead of switching under them.
 */
export async function prepareBranch(
  repository: RepositoryData,
  settings: DevSettings,
  taskId: string,
  options: BranchOptions,
): Promise<Prepared> {
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
  const path = repository.path;
  const branch = workBranch(taskId);
  const current = currentBranch(path);
  excludeFromStatus(path, PROGRESS_FILE);

  if (current === branch) {
    const startBranch = options.recorded ?? options.carried ?? settings.mainBranch;
    if (mergeInProgress(path)) {
      return { kind: "conflict", base: headOf(path), files: conflictedFiles(path), startBranch };
    }
    if (!options.mergeMain || changedFiles(path).length > 0) {
      return { kind: "ready", base: headOf(path), startBranch };
    }
    return { ...mergeLatest(path, mainRef), startBranch };
  }

  if (current === undefined) {
    return failed(
      "the main clone is not on a branch; switch it to a branch, then run the task again",
    );
  }
  if (options.recorded !== undefined && current !== options.recorded) {
    return failed(
      `the main clone is on "${current}", but the task started on "${options.recorded}"; switch it back to "${options.recorded}", then run the task again`,
    );
  }
  const dirty = changedFiles(path);
  if (dirty.length > 0) {
    return failed(
      `the main clone has uncommitted changes: ${namedFiles(dirty)}; commit or set them aside, then run the task again`,
      dirty,
    );
  }
  const startBranch = options.recorded ?? current;
  if (options.beforeSwitch !== undefined && options.recorded === undefined) {
    if (!(await options.beforeSwitch(startBranch))) {
      return { kind: "failed", cancelled: true };
    }
  }

  stepTestHooks.branchStep?.("before-switch");
  let reused = false;
  let switched: GitResult;
  if (branchExists(path, branch)) {
    switched = git(path, ["switch", "--quiet", branch]);
    reused = true;
  } else if (branchExists(path, branch, settings.remote)) {
    switched = git(path, [
      "switch",
      "--quiet",
      "--no-track",
      "-c",
      branch,
      `${settings.remote}/${branch}`,
    ]);
    reused = true;
  } else {
    switched = git(path, ["switch", "--quiet", "--no-track", "-c", branch, mainRef]);
  }
  if (!switched.ok) {
    return failed(`cannot switch the main clone to "${branch}": ${switched.err || switched.out}`);
  }
  stepTestHooks.branchStep?.("after-switch");
  if (reused && options.mergeMain) return { ...mergeLatest(path, mainRef), startBranch };
  return { kind: "ready", base: headOf(path), startBranch };
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
  if (!isRecord(params)) return undefined;
  const token = params.token;
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
  /** Replaces the timer that says a worker with a place has not started. */
  workerStartClock?: WorkClock | undefined;
  /**
   * Called at each point of the branch mode's worktree step where a crash
   * leaves the main clone in a different state. A test kills its own process
   * there.
   */
  branchStep?:
    | ((point: "before-switch" | "after-switch" | "before-save") => void)
    | undefined;
  /** Called once the task has recorded what the work step waits for (null: nothing). */
  afterWorkerWait?: ((text: string | null) => void) | undefined;
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

/**
 * How long a worker may hold its place without its program running before the
 * task says so. Starting a worker takes seconds; two minutes is a worker that
 * is not starting.
 */
export const WORKER_START_GRACE_MS = 120_000;

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
 * Commits everything left in the worktree (honouring .gitignore) with the given
 * message. Returns what went wrong when it could not, so the step can report it.
 */
function commitLeft(worktree: string, message: string): string | undefined {
  const conflicted = conflictedFiles(worktree);
  if (conflicted.length > 0) return `unresolved conflicts in ${conflicted.join(", ")}`;
  const added = git(worktree, ["add", "-A", "--", "."]);
  if (!added.ok) return `git add failed: ${(added.err || added.out).trim()}`;
  const committed = git(worktree, ["commit", "-q", "--no-verify", "-m", message]);
  // The note is the worker's report, not part of the change: take it out of the
  // branch again, leaving the file for the step to read.
  untrackNote(worktree);
  return committed.ok ? undefined : `git commit failed: ${(committed.err || committed.out).trim()}`;
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
  if (!isRecord(params)) return undefined;
  const value = params.runStoppedAt;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The cancelled dependency a blocked start names, when the flow carries one. */
function blockedDependency(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  const value = params.blockedBy;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Step `dev/worktree`: make the task's worktree ready or report a conflict. */
export async function runWorktree(
  ctx: StepContext,
): Promise<PluginStepResult> {
  const context = await taskContext(ctx, true);
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
  // A replay of an attempt keeps what its first visit recorded.
  const recordedText = replay ? attempt.settingsText : undefined;
  const settingsText = recordedText ?? context.settingsText ?? "";
  const settings =
    recordedText === undefined
      ? context.settings
      : devSettingsFromText(context.repository.path, recordedText);
  const inPlace = settings.workIn === "branch";
  const mergeMain = beforeAttemptOf(ctx.params) !== "none";
  const where = workPath(context.repository, settings, context.workName);
  const prepared = await withPrepare(
    ctx,
    settings,
    where,
    inPlace
      ? await prepareBranch(context.repository, settings, context.workName, {
          recorded: replay ? startBranchOf(attempt) : undefined,
          carried: startBranchOf(context.task.attempt),
          mergeMain,
          // Record where the clone started before it is switched, so a crash
          // between the two still knows which branch to switch back to.
          beforeSwitch: (start) =>
            saveTaskGuarded(
              ctx,
              context.taskKey,
              {
                ...context.task,
                phase: "running",
                waitKind: undefined,
                run: ctx.runId,
                startRequested: false,
                attempts,
                attempt: {
                  ...attempt,
                  run: ctx.runId,
                  settingsText,
                  inPlace: true,
                  startBranch: start,
                },
              },
              "dev:worktree-start",
            ),
        })
      : prepareWorktree(context.repository, settings, context.workName, mergeMain),
  );
  if (prepared.cancelled === true) return cancelledStep();
  if (inPlace) stepTestHooks.branchStep?.("before-save");
  const base = prepared.base ?? attempt.base ?? null;
  const startBranch = prepared.startBranch ?? startBranchOf(replay ? attempt : undefined);
  const nextAttempt: TaskAttempt = {
    ...attempt,
    run: ctx.runId,
    settingsText,
    worktree: where,
    branch: workBranch(context.workName),
    ...(inPlace
      ? { inPlace: true, ...(startBranch === undefined ? {} : { startBranch }) }
      : {}),
    base,
    result: prepared.kind,
    // The answer of an earlier attempt belongs to that attempt.
    finalMessage: null,
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
    waitKind: undefined,
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
  const worktree = workPath(
    context.repository,
    context.settings,
    context.workName,
  );
  const inPlace = context.settings.workIn === "branch";
  const prepared = await withPrepare(
    ctx,
    context.settings,
    worktree,
    inPlace
      ? await prepareBranch(context.repository, context.settings, context.workName, {
          recorded: startBranchOf(attempt),
          mergeMain: true,
        })
      : prepareWorktree(context.repository, context.settings, context.workName),
  );
  const base = prepared.base ?? attempt.base ?? null;
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
    branch: workBranch(context.workName),
    ...(inPlace
      ? {
          inPlace: true,
          ...(prepared.startBranch === undefined ? {} : { startBranch: prepared.startBranch }),
        }
      : {}),
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
    waitKind: undefined,
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
  readonly finalMessage: string | null;
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
    finalMessage:
      typeof data.finalMessage === "string" && data.finalMessage.trim().length > 0
        ? data.finalMessage
        : null,
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
 * The params of the `pool/agent` call: the stage's pool's definitions (`default`
 * when the stage names none), the key prefix `<repository>/<pool>`, and the worker a rework goes back to.
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
  stage?: {
    readonly use?: string | undefined;
    readonly args?: readonly string[] | undefined;
    readonly pool?: string | undefined;
  },
): Record<string, unknown> {
  const pool = stage?.pool ?? DEFAULT_POOL;
  const resolved = resolvePool(settings.workers, pool);
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
    prefix: `${repository.name}/${pool}`,
    // A worker shared by two pools has one count: the claim ignores the pool.
    countPrefix: repository.name,
    holder,
    workers: fallback === undefined ? workers : [...workers, fallback],
    fallbacks: resolved.fallbacks,
    ...(worker === undefined ? {} : { worker }),
    ...(worker !== undefined && resumeSession !== undefined ? { resumeSession } : {}),
  };
}

/** The harness overrides a code stage wrote in its params. */
function stageParamsOf(params: unknown): {
  readonly use?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly pool?: string | undefined;
} {
  const given = (params ?? {}) as {
    readonly flowUse?: unknown;
    readonly flowArgs?: unknown;
    readonly flowPool?: unknown;
  };
  const pool = typeof given.flowPool === "string" ? given.flowPool : undefined;
  const use = typeof given.flowUse === "string" ? given.flowUse : undefined;
  const args =
    Array.isArray(given.flowArgs) &&
    given.flowArgs.every((item): item is string => typeof item === "string")
      ? given.flowArgs
      : undefined;
  return {
    ...(use === undefined ? {} : { use }),
    ...(args === undefined ? {} : { args }),
    ...(pool === undefined ? {} : { pool }),
  };
}

/** The preparation a code stage asks for before its attempt. */
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

/** The lines of a step's `stderr` data, which may be a string or a list. */
function stderrLines(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value)
    ? value.filter((line): line is string => typeof line === "string")
    : [];
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

/** Step `dev/work`: run the configured harness step and decide what it left. */
export async function runWork(ctx: StepContext, stepParams?: unknown): Promise<PluginStepResult> {
  // The step's own params (a flow stage writes them) and the run's start params
  // (a direct call writes them) both reach this step; the step's own win.
  const stage: Record<string, unknown> = {
    ...(isRecord(ctx.params) ? ctx.params : {}),
    ...(isRecord(stepParams) ? stepParams : {}),
  };
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
    workPath(context.repository, context.settings, context.workName);
  const branch = task.attempt?.branch ?? workBranch(context.workName);
  const attempt: TaskAttempt = task.attempt ?? {
    number: Math.max(task.attempts, 0) + 1,
    run: ctx.runId,
  };
  const attempts = Math.max(task.attempts, attempt.number);
  const base = attempt.base ?? headOf(path) ?? null;

  // The attempt's own record says where it works; the settings may have
  // changed since (a task switched from one mode to the other keeps its way).
  const inPlace = task.attempt?.inPlace === true;
  const wrongBranch = inPlace ? currentBranch(path) !== branch : false;
  if (!existsSync(path) || !isWorktree(path) || wrongBranch) {
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
        message: inPlace
          ? `the main clone is on "${currentBranch(path) ?? "no branch"}", not "${branch}"; run the worktree step first`
          : `no worktree at ${path}; run the worktree step first`,
      }),
    };
  }

  if (beforeAttemptOf(stage) === "merge-main") {
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

  // A conflict is left for the worker to resolve and commit. Keep the main it
  // merged so the commit is checked again after the worker is done.
  const mergeHead = mergeInProgress(path)
    ? git(path, ["rev-parse", "MERGE_HEAD"]).out
    : undefined;
  let mergeTaskRef: string | undefined;
  let mergeMutationFiles: readonly MutationChange[] = [];
  if (mergeHead !== undefined && mergeHead.length > 0) {
    const mergeBefore = headOf(path);
    if (mergeBefore !== undefined) {
      mergeTaskRef = mergeBefore;
      mergeMutationFiles = mainChangedMutations(path, mergeBefore, mergeHead);
    }
  }

  const stageParams = stage as {
    readonly flowWorkerBrief?: unknown;
    readonly flowCommit?: unknown;
  };
  const workerBrief = await readWorkerBrief(
    context.repository.path,
    context.settings,
    typeof stageParams.flowWorkerBrief === "string" ? stageParams.flowWorkerBrief : undefined,
  );
  const prompt = buildWorkerPrompt(
    path,
    workerBrief,
    task,
    progressOf(attempt.previousProgress),
  );
  const stageBrief = (() => {
    const given = (stage as { readonly flowBrief?: unknown }).flowBrief;
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
    access: taskStepAccess(ctx.access),
    ...(ctx.trigger === undefined ? {} : { trigger: ctx.trigger }),
    signal: stopper.signal,
  };
  // A rework or reject goes back to the worker that ran the attempt before,
  // and resumes its session when the harness can. When that worker is no
  // longer in the pool, any free worker takes it and the change is recorded.
  const stagePool = stageParamsOf(stage).pool ?? DEFAULT_POOL;
  const resumedSession =
    typeof stage.resumeSession === "string" ? stage.resumeSession : undefined;
  const askAnswer = isRecord(stage.askAnswer) ? stage.askAnswer : undefined;
  // An answer to the worker's own question comes back to this step; it resumes
  // the same worker, never a fallback.
  const resumed = resumedSession !== undefined || askAnswer !== undefined;
  const before =
    typeof attempt.previousWorker === "string" && attempt.previousWorker.length > 0
      ? attempt.previousWorker
      : undefined;
  const stillThere =
    before !== undefined &&
    (() => {
      try {
        const resolved = resolvePool(context.settings.workers, stagePool);
        return [...resolved.workers, ...resolved.fallbacks].some(
          (worker) => worker.name === before,
        );
      } catch {
        return false;
      }
    })();
  const asked = resumed
    ? (typeof attempt.worker === "string" ? attempt.worker : before)
    : stillThere
      ? before
      : undefined;
  const workerChangedFrom = !resumed && before !== undefined && !stillThere ? before : undefined;
  const resumeSession =
    resumedSession ??
    (typeof attempt.previousSession === "string" ? attempt.previousSession : undefined);
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
    workerStarted();
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
  // While the step waits for a worker, the task says what it waits for and who
  // holds it, in the row and in the step log. A rework waits for the worker it
  // asked for; any other attempt waits for the workers of the pool.
  let waitingFor: string | undefined;
  // The worker the pool placed and its harness step, kept on the attempt while
  // the work runs so the log view finds the right log before the outcome.
  let placedWorker: { readonly workerRunning: string; readonly workerUse: string } | undefined;
  const setWorkerWait = async (text: string | null): Promise<void> => {
    await saveTaskGuarded(
      ctx,
      context.taskKey,
      { ...task, attempt: { ...attempt, ...placedWorker, workerWait: text } },
      "dev:work-wait",
    );
    stepTestHooks.afterWorkerWait?.(text);
  };
  const onPoolEvent = async (_plugin: string, event: StepEvent): Promise<void> => {
    const data: unknown = event.data;
    if (event.type === WAITING_EVENT) {
      const entries = Array.isArray((data as { workers?: unknown } | undefined)?.workers)
        ? ((data as { workers: unknown[] }).workers)
        : [];
      const mine = entries.filter(
        (entry): entry is { worker?: unknown; holders?: unknown } =>
          isRecord(entry) &&
          (asked === undefined || entry.worker === asked),
      );
      const names = mine.flatMap((entry) =>
        typeof entry.worker === "string" ? [entry.worker] : [],
      );
      const holders = [
        ...new Set(
          mine.flatMap((entry) =>
            Array.isArray(entry.holders)
              ? entry.holders.filter((item): item is string => typeof item === "string")
              : [],
          ),
        ),
      ];
      const line = `waiting for worker ${asked ?? names.join(" or ")}${
        stagePool === DEFAULT_POOL ? "" : ` in pool ${stagePool}`
      }${
        holders.length === 0 ? "" : `: held by ${holders.join(", ")}`
      }`;
      waitingFor = line;
      await ctx.logger.write(line);
      await setWorkerWait(line);
    } else if (event.type === ACQUIRED_EVENT && waitingFor !== undefined) {
      waitingFor = undefined;
      const worker = (data as { worker?: unknown } | undefined)?.worker;
      const name = asked ?? (typeof worker === "string" ? worker : undefined);
      await ctx.logger.write(
        `${name === undefined ? "a worker" : `worker ${name}`} is free; the work starts`,
      );
      await setWorkerWait(null);
    }
  };
  // A worker that has its place holds it against every other task that needs
  // that worker. When its program is not running a little after the place was
  // given, the task says so rather than looking like it works.
  const startClock = stepTestHooks.workerStartClock ?? realWorkClock;
  let startTimer: unknown;
  let started = false;
  let notStarted: string | undefined;
  // The notes are written one after another, and none after the step is over:
  // the step's own final save must be the last write to the task.
  let sayClosed = false;
  let sayChain: Promise<void> = Promise.resolve();
  const say = (line: string, wait: string | null): void => {
    sayChain = sayChain.then(async () => {
      if (sayClosed) return;
      await ctx.logger.write(line);
      if (sayClosed) return;
      await setWorkerWait(wait);
    }).catch(() => undefined);
  };
  const workerPlaced = (name: string): void => {
    let use = stageParamsOf(stage).use;
    if (use === undefined) {
      try {
        const resolved = resolvePool(context.settings.workers, stagePool);
        use = [...resolved.workers, ...resolved.fallbacks].find((item) => item.name === name)?.use;
      } catch {
        use = undefined;
      }
    }
    if (use !== undefined) {
      placedWorker = { workerRunning: name, workerUse: use };
      sayChain = sayChain
        .then(async () => {
          if (sayClosed) return;
          await saveTaskGuarded(
            ctx,
            context.taskKey,
            { ...task, attempt: { ...attempt, ...placedWorker, workerWait: null } },
            "dev:work-placed",
          );
        })
        .catch(() => undefined);
    }
    if (started) return;
    startTimer = startClock.setTimeout(() => {
      if (started) return;
      const line = `worker ${name} has had its place for ${Math.round(WORKER_START_GRACE_MS / 60_000)} minutes and has not started`;
      notStarted = line;
      say(line, line);
    }, WORKER_START_GRACE_MS);
  };
  const workerStarted = (): void => {
    if (started) return;
    started = true;
    if (startTimer !== undefined) startClock.clearTimeout(startTimer);
    if (notStarted !== undefined) {
      notStarted = undefined;
      say("the worker started", null);
    }
  };
  const poolCall: Record<string, unknown> = poolParams(
    finalPrompt,
    path,
    context.repository,
    context.settings,
    asked,
    resumeSession,
    outbox.inbox,
    context.taskId,
    stageParamsOf(stage),
  );
  if (askAnswer !== undefined) poolCall.askAnswer = askAnswer;
  // Working in the main clone changes it by design, so there is nothing to
  // report about it (ADR 0039 D1).
  const mainCheckoutBefore = inPlace ? [] : checkoutSnapshot(context.repository.path);
  let mainChanges: readonly string[] = [];
  try {
    outcome = await withWorkerReports(
      { placed: workerPlaced, started: workerStarted },
      () =>
        runStep(
          "pool/agent",
          poolCall,
          { ...options, observe: onPoolEvent },
        ),
    );
  } catch (error) {
    hostError = messageOf(error);
    notLoaded = notLoadedStep(error);
  } finally {
    // Reading the main checkout is part of ending the step, so a worker call
    // that throws still reports what the step left there.
    mainChanges = inPlace
      ? []
      : newCheckoutChanges(context.repository.path, path, mainCheckoutBefore);
    if (startTimer !== undefined) startClock.clearTimeout(startTimer);
    sayClosed = true;
    await sayChain;
    if (waitingFor !== undefined) {
      waitingFor = undefined;
      await ctx.logger.write(`stopped waiting for ${asked === undefined ? "a worker" : `worker ${asked}`}`).catch(() => undefined);
    }
    for (const timer of [...timers, ...runTimers]) clock.clearTimeout(timer);
    ctx.signal.removeEventListener("abort", forwardAbort);
  }
  const outcomeData =
    outcome !== undefined && isRecord(outcome.data) ? outcome.data : {};
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
    finalMessage: reading.finalMessage,
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
    const mainLine =
      mainChanges.length === 0
        ? undefined
        : `changed the main checkout: ${mainChanges.join(", ")}`;
    const said = (message: string | undefined): string | undefined => {
      if (mainLine === undefined) return message;
      return message === undefined || message.length === 0
        ? mainLine
        : `${message}; ${mainLine}`;
    };
    const mainMessage = said(
      typeof extra.message === "string" ? extra.message : undefined,
    );
    const data: Readonly<Record<string, unknown>> = {
      ...extra,
      ...(mainMessage === undefined ? {} : { message: mainMessage }),
    };
    const note = readNote(path);
    const progress: Progress | undefined =
      note === null && !timedOutRun
        ? undefined
        : { note, commits: commitsSince(path, base), timedOut: timedOutRun };
    nextAttempt = {
      ...nextAttempt,
      result,
      ...(mainLine === undefined
        ? {}
        : {
            finalMessage:
              typeof nextAttempt.finalMessage === "string" &&
              nextAttempt.finalMessage.trim().length > 0
                ? `${nextAttempt.finalMessage}\n\n${mainLine}`
                : mainLine,
          }),
      workNote:
        result !== "done" && typeof data.message === "string" ? data.message : null,
      ...(waitsForModel ? {} : { workRetryAt: null }),
      // An attempt that left no note keeps the one before it for later attempts.
      progress: progress ?? progressOf(attempt.previousProgress) ?? null,
      workTimedOut: timedOutRun,
      // A commit the worker made after the last verify has no result yet; the
      // verify before it must not stand for it, not even in the same run.
      ...(typeof extra.head === "string" && attempt.verified !== extra.head
        ? { verified: null, verify: null, review: null }
        : {}),
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
        waitKind: result === "waiting" ? "work-question" : undefined,
        run: ctx.runId,
        attempts,
        attempt: nextAttempt,
        ...(mainLine === undefined
          ? {}
          : { brief: appendChange(task.brief, mainLine) }),
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
        ...data,
      }),
    };
  };

  untrackNote(path);
  // The worker asked a person and the grace passed. The pool already gave the
  // worker's place back; the flow's wait carries the question, and the answer
  // returns here to resume the same worker's session.
  if (outcome?.result === "waiting") {
    return finish("waiting", { ...outcomeData });
  }
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
  let dirty = changedFiles(path);

  // The worker resolved and committed the merge; put main's rows first in that
  // commit, or in one commit after the worker's own. An aborted merge changed
  // nothing, so it is left alone.
  const afterMerge = headOf(path);
  if (
    mergeHead !== undefined &&
    mergeHead.length > 0 &&
    afterMerge !== undefined &&
    !mergeInProgress(path) &&
    isAncestor(path, mergeHead, afterMerge)
  ) {
    const changed =
      mergeTaskRef === undefined
        ? []
        : mainFirstMutations(path, mergeHead, mergeTaskRef, mergeMutationFiles);
    if (changed.length > 0 && !commitMainFirstMutations(path, changed, mergeHead)) {
      return finish("failed", {
        reason: "mutations",
        message: `cannot keep main's rows first in ${changed.join(", ")}`,
      });
    }
    dirty = changedFiles(path);
  }

  let commitError: string | undefined;
  // A worker whose sandbox cannot write .git leaves its work uncommitted; the
  // stage asks dev to commit it, before verify so the check sees the commit.
  if (
    // In the main clone dev commits what the worker left unless the stage says
    // the worker commits itself: the checks run on a commit (ADR 0020 D3).
    (stageParams.flowCommit === true || (inPlace && stageParams.flowCommit !== false)) &&
    hostError === undefined &&
    outcome?.result === "done" &&
    dirty.length > 0
  ) {
    commitError = commitLeft(path, `${context.taskId}: ${task.title}`);
    dirty = changedFiles(path);
  }

  if (hostError !== undefined) {
    return finish("failed", {
      reason:
        notLoaded !== undefined
          ? STOP_REASONS.stepNotLoaded
          : isConnectionError(hostError)
            ? STOP_REASONS.connection
            : "harness",
      ...(notLoaded === undefined ? {} : { use: notLoaded }),
      message: hostError,
      ...(dirty.length === 0 ? {} : { files: dirty }),
    });
  }

  if (outcome !== undefined && outcome.result !== "done") {
    const waits = typeof attempt.workWaits === "number" ? attempt.workWaits : 0;
    const modelError = modelErrorIn(outcomeData);
    if (modelError !== undefined && modelWaitsForPerson(modelError)) {
      // A usage limit, or a wait past the bound, is not an outage dev can wait
      // out: the work fails to a person who can change the worker or wait.
      const reported =
        modelError.message ??
        (typeof outcomeData.message === "string"
          ? outcomeData.message
          : "the worker's model cannot serve");
      const reset =
        modelError.retryAfterSecs === undefined
          ? ""
          : `; the model can serve again at ${new Date(
              (modelError.reportedAt ?? devNow()) +
                modelError.retryAfterSecs * 1000,
            ).toISOString()}`;
      return finish("failed", {
        reason: "model_unavailable",
        message: `${reported}${reset}`,
        ...(dirty.length === 0 ? {} : { files: dirty }),
      });
    }
    if (modelError !== undefined && waits < MAX_WORK_WAITS) {
      const waitSecs =
        modelError.retryAfterSecs ?? context.settings.reviewer.retrySecs;
      const retryAt =
        (modelError.retryAfterSecs === undefined
          ? devNow()
          : modelError.reportedAt ?? devNow()) +
        waitSecs * 1000;
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
      reason: stopped
        ? STOP_REASONS.stopped
        : isConnectionError(message, ...stderrLines(outcomeData.stderr))
          ? STOP_REASONS.connection
          : "harness",
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
      message:
        `uncommitted changes: ${dirty.join(", ")}` +
        (commitError === undefined ? "" : `; the commit the stage asked for failed: ${commitError}`),
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
