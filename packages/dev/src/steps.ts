/**
 * The two steps a task runs before a check: `worktree` gives it a branch and a
 * worktree, `work` asks a harness step to do the task and reads the result.
 * The kernel never runs git or a harness itself; both live here in `dev`.
 */

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  messageOf,
  type PluginStepResult,
  type StepContext,
  type StepRunOptions,
} from "@operad-io/engine";
import {
  bareId,
  DevError,
  listAll,
  repositoryData,
  splitBrief,
  storeKey,
  taskData,
  type RepositoryData,
  type TaskAttempt,
  type TaskData,
} from "./model.ts";
import { findRepository } from "./service.ts";
import {
  assertInsideRepository,
  readDevSettings,
  readWorkerBrief,
  type DevSettings,
} from "./settings.ts";

interface GitResult {
  readonly ok: boolean;
  readonly out: string;
  readonly err: string;
}

function git(cwd: string, args: readonly string[]): GitResult {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: result.exitCode === 0,
    out: result.stdout.toString().trim(),
    err: result.stderr.toString().trim(),
  };
}

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

interface TaskContext {
  readonly task: TaskData;
  readonly repository: RepositoryData;
  readonly taskKey: string;
  readonly taskId: string;
  readonly settings: DevSettings;
}

async function taskContext(ctx: StepContext): Promise<TaskContext> {
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
  const settings = await readDevSettings(repository.path);
  const taskId = bareId(stored?.id ?? object.id);
  let taskKey = stored?.id ?? object.id;
  if ((await ctx.store.get("task", taskKey)) === undefined) {
    taskKey = storeKey(repository.name, taskId);
  }
  return {
    task,
    repository,
    taskKey,
    taskId,
    settings,
  };
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
  return {
    attempt: { number, run: ctx.runId },
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

function isRegistered(repositoryPath: string, path: string): boolean {
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

function headOf(path: string): string | undefined {
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

/** The files `git status` calls changed, untracked included. */
export function changedFiles(worktree: string): readonly string[] {
  const result = git(worktree, ["status", "--porcelain"]);
  if (!result.ok || result.out.length === 0) return [];
  const files: string[] = [];
  for (const line of result.out.split("\n")) {
    if (line.length < 4) continue;
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    files.push(arrow < 0 ? rest : rest.slice(arrow + 4));
  }
  return [...new Set(files)].sort();
}

interface Prepared {
  readonly kind: "ready" | "conflict" | "failed";
  readonly base?: string | undefined;
  readonly message?: string | undefined;
  readonly files?: readonly string[] | undefined;
}

function failed(message: string, files?: readonly string[]): Prepared {
  return { kind: "failed", message, ...(files === undefined ? {} : { files }) };
}

/** Merges the fetched main into a reused branch and reports a conflict. */
function mergeLatest(path: string, mainRef: string): Prepared {
  const merge = git(path, ["merge", "--no-edit", "--no-ff", mainRef]);
  if (!merge.ok) {
    const files = conflictedFiles(path);
    if (files.length > 0 || mergeInProgress(path)) {
      return { kind: "conflict", base: headOf(path), files };
    }
    return failed(
      `cannot merge "${mainRef}" into the worktree: ${merge.err || merge.out}`,
    );
  }
  return { kind: "ready", base: headOf(path) };
}

/** Fetches, creates the worktree when needed, and merges main into a reused one. */
function prepareWorktree(
  repository: RepositoryData,
  settings: DevSettings,
  taskId: string,
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
  if (reused) return mergeLatest(path, mainRef);
  return { kind: "ready", base: headOf(path) };
}

async function saveTask(
  ctx: StepContext,
  key: string,
  data: TaskData,
  cause: string,
): Promise<void> {
  await ctx.store.put("task", key, data, cause);
}

/** Step `dev/worktree`: make the task's worktree ready or report a conflict. */
export async function runWorktree(
  ctx: StepContext,
): Promise<PluginStepResult> {
  const context = await taskContext(ctx);
  const { attempt, attempts } = attemptFor(ctx, context.task);
  const prepared = prepareWorktree(
    context.repository,
    context.settings,
    context.taskId,
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
  };
  const next: TaskData = {
    ...context.task,
    phase: "running",
    run: ctx.runId,
    attempts,
    attempt: nextAttempt,
  };
  await saveTask(ctx, context.taskKey, next, "dev:worktree");
  const data = {
    attempt: attempts,
    worktree: nextAttempt.worktree,
    path: nextAttempt.worktree,
    branch: nextAttempt.branch,
    base,
    ...(prepared.message === undefined ? {} : { message: prepared.message }),
    ...(prepared.files === undefined ? {} : { files: prepared.files }),
  };
  return { result: prepared.kind, data };
}

function briefText(task: TaskData): string {
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
    "Start by resolving every conflict, then commit the merge and continue with the task.",
  ].join("\n\n");
}

/** Builds the prompt a worker reads: conflict note, worker brief, task brief. */
export function buildWorkerPrompt(
  worktree: string,
  workerBrief: string,
  task: TaskData,
): string {
  const pieces: string[] = [];
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
  readonly cost: number | null;
}

function harnessReading(data: Record<string, unknown>): HarnessReading {
  const sessionId =
    typeof data.sessionId === "string" ? data.sessionId : null;
  const cost = data.cost;
  const micros =
    typeof cost === "object" &&
    cost !== null &&
    "micros" in cost &&
    typeof (cost as { micros?: unknown }).micros === "number" &&
    Number.isFinite((cost as { micros: number }).micros)
      ? (cost as { micros: number }).micros
      : null;
  return {
    sessionId,
    costMicros: micros,
    cost: micros === null ? null : micros / 1_000_000,
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
    ...extra,
  };
}

function harnessParams(
  prompt: string,
  worktree: string,
  settings: DevSettings,
): Record<string, unknown> {
  return {
    prompt,
    cwd: worktree,
    // An empty list is still a configured value: leaving it out would let the
    // flow's params provide the harness arguments the repository did not set.
    args: settings.worker.args,
    ...(settings.worker.wallTimeSecs === undefined
      ? {}
      : { wallTimeSecs: settings.worker.wallTimeSecs }),
    ...(settings.worker.stallSecs === undefined
      ? {}
      : { stallSecs: settings.worker.stallSecs }),
  };
}

/** Step `dev/work`: run the configured harness step and decide what it left. */
export async function runWork(ctx: StepContext): Promise<PluginStepResult> {
  const context = await taskContext(ctx);
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
    await saveTask(
      ctx,
      context.taskKey,
      {
        ...task,
        phase: "running",
        run: ctx.runId,
        attempts,
        attempt: nextAttempt,
      },
      "dev:work",
    );
    return {
      result: "failed",
      data: resultData(nextAttempt, harnessReading({}), {
        reason: "no_worktree",
        message: `no worktree at ${path}; run the worktree step first`,
      }),
    };
  }

  const workerBrief = await readWorkerBrief(
    context.repository.path,
    context.settings,
  );
  const prompt = buildWorkerPrompt(path, workerBrief, task);
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
    await saveTask(
      ctx,
      context.taskKey,
      {
        ...task,
        phase: "running",
        run: ctx.runId,
        attempts,
        attempt: nextAttempt,
      },
      "dev:work",
    );
    return {
      result: "failed",
      data: resultData(nextAttempt, harnessReading({}), {
        reason: "no_host",
        message: "the kernel did not offer a way to run the configured harness step",
      }),
    };
  }

  const options: StepRunOptions = {
    runId: ctx.runId,
    cwd: path,
    ...(ctx.object === undefined ? {} : { object: ctx.object }),
    params: ctx.params,
    access: ctx.access,
    ...(ctx.trigger === undefined ? {} : { trigger: ctx.trigger }),
    signal: ctx.signal,
  };
  let outcome: PluginStepResult | undefined;
  let hostError: string | undefined;
  try {
    outcome = await runStep(
      context.settings.worker.use,
      harnessParams(prompt, path, context.settings),
      options,
    );
  } catch (error) {
    hostError = messageOf(error);
  }
  const outcomeData =
    outcome !== undefined &&
    typeof outcome.data === "object" &&
    outcome.data !== null
      ? (outcome.data as Record<string, unknown>)
      : {};
  const reading = harnessReading(outcomeData);

  let nextAttempt: TaskAttempt = {
    ...attempt,
    run: ctx.runId,
    worktree: path,
    branch,
    base,
    sessionId: reading.sessionId,
    cost: reading.cost,
    costMicros: reading.costMicros,
    worked: true,
  };

  const finish = async (
    result: string,
    extra: Readonly<Record<string, unknown>>,
  ): Promise<PluginStepResult> => {
    nextAttempt = { ...nextAttempt, result };
    await saveTask(
      ctx,
      context.taskKey,
      {
        ...task,
        phase: "running",
        run: ctx.runId,
        attempts,
        attempt: nextAttempt,
        ...(reading.cost === null ? {} : { cost: reading.cost }),
      },
      "dev:work",
    );
    return {
      result,
      data: resultData(nextAttempt, reading, {
        worktree: path,
        path,
        branch,
        base,
        prompt,
        ...extra,
      }),
    };
  };

  // Inspect the tree before deciding: a harness failure must still name what
  // it left uncommitted, and a success must still fail on a dirty tree.
  const dirty = changedFiles(path);

  if (hostError !== undefined) {
    return finish("failed", {
      reason: "harness",
      message: hostError,
      ...(dirty.length === 0 ? {} : { files: dirty }),
    });
  }

  if (outcome === undefined || outcome.result !== "done") {
    const message =
      typeof outcomeData.message === "string"
        ? outcomeData.message
        : `the harness step ended "${outcome?.result ?? "unknown"}"`;
    return finish("failed", {
      reason: "harness",
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
  if (
    head === undefined ||
    base === null ||
    head === base ||
    // A reset below the base, or to unrelated history, is not new work: the
    // branch must still descend from the base before anything is pushed.
    !isAncestor(path, base, head)
  ) {
    return finish("nothing", { head: head ?? base });
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
  return finish("done", { head, pushed: true });
}
