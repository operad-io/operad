/**
 * The end of a task's flow: land the verified commit on main, then clean the
 * worktrees and branches away. Both steps run git and shell here; the kernel
 * never runs either itself.
 */

import {
  messageOf,
  type PluginStepResult,
  type StepContext,
  type StepRunOptions,
} from "@operad-io/engine";
import {
  appendChange,
  appendRework,
  isRecord,
  storeKey,
  type CleanupFailure,
  type CleanupRecord,
  type IntegrationRecord,
  type TaskAttempt,
  type TaskData,
} from "./model.ts";
import {
  branchHead,
  gateWorktreePath,
  recreateGateWorktree,
} from "./gate.ts";
import { getPlan, refreshPlanCounts } from "./service.ts";
import {
  conflictedFiles,
  git,
  headOf,
  mergeInProgress,
  saveTask,
  taskContext,
  worktreePath,
  type TaskContext,
} from "./steps.ts";
import type { DevSettings, IntegrationStyle } from "./settings.ts";

/** How many times a moved main sends the candidate back to the fetch. */
export const MAX_INTEGRATION_ROUNDS = 3;

/**
 * Test-only hook, run after a successful push and before the step records it.
 * A test child kills itself here to prove a recovery pushes nothing again.
 * Production code never sets it.
 */
export const integrateTestHooks: {
  afterPush?: ((candidate: string) => void) | undefined;
} = {};

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function revParse(cwd: string, ref: string): string | undefined {
  const result = git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return result.ok && result.out.length > 0 ? result.out : undefined;
}

/** True when `ancestor` is reachable from `descendant`. */
function contains(
  cwd: string,
  ancestor: string,
  descendant: string,
): boolean {
  return git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]).ok;
}

function stepOptions(ctx: StepContext, cwd: string): StepRunOptions {
  return {
    runId: ctx.runId,
    cwd,
    ...(ctx.object === undefined ? {} : { object: ctx.object }),
    params: ctx.params,
    access: ctx.access,
    ...(ctx.trigger === undefined ? {} : { trigger: ctx.trigger }),
    signal: ctx.signal,
  };
}

interface Candidate {
  readonly kind: "ok" | "conflict" | "failed";
  readonly sha?: string | undefined;
  readonly message?: string | undefined;
  readonly files?: readonly string[] | undefined;
}

/** Builds the candidate on main: a merge commit, or one squashed commit. */
function mergeCandidate(
  path: string,
  verified: string,
  style: IntegrationStyle,
  message: string,
): Candidate {
  if (style === "squash") {
    const merge = git(path, ["merge", "--squash", verified]);
    if (!merge.ok) {
      const files = conflictedFiles(path);
      if (files.length > 0) return { kind: "conflict", files };
      return {
        kind: "failed",
        message: `cannot squash ${verified}: ${merge.err || merge.out}`,
      };
    }
    if (git(path, ["diff", "--cached", "--name-only"]).out.length > 0) {
      const commit = git(path, ["commit", "-m", message]);
      if (!commit.ok) {
        return {
          kind: "failed",
          message: `cannot commit the squashed change: ${commit.err || commit.out}`,
        };
      }
    }
    const sha = headOf(path);
    return sha === undefined
      ? { kind: "failed", message: "the candidate has no commit" }
      : { kind: "ok", sha };
  }

  const merge = git(path, ["merge", "--no-ff", "-m", message, verified]);
  if (!merge.ok) {
    const files = conflictedFiles(path);
    if (files.length > 0 || mergeInProgress(path)) {
      return { kind: "conflict", files };
    }
    return {
      kind: "failed",
      message: `cannot merge ${verified}: ${merge.err || merge.out}`,
    };
  }
  const sha = headOf(path);
  return sha === undefined
    ? { kind: "failed", message: "the candidate has no commit" }
    : { kind: "ok", sha };
}

/** Leaves the gate worktree clean after a conflict, before it is recreated. */
function clearConflict(path: string): void {
  if (mergeInProgress(path)) git(path, ["merge", "--abort"]);
  git(path, ["reset", "--hard", "HEAD"]);
}

interface SaveOptions {
  readonly phase?: TaskData["phase"] | undefined;
  readonly change?: string | undefined;
}

async function writeIntegration(
  ctx: StepContext,
  context: TaskContext,
  task: TaskData,
  attempt: TaskAttempt,
  record: IntegrationRecord,
  options: SaveOptions = {},
): Promise<TaskData> {
  const brief =
    options.change === undefined
      ? task.brief
      : appendChange(task.brief, options.change);
  const next: TaskData = {
    ...task,
    ...(options.phase === undefined ? {} : { phase: options.phase }),
    run: ctx.runId,
    attempts: Math.max(task.attempts, attempt.number),
    attempt: { ...attempt, run: ctx.runId, integration: record },
    brief,
  };
  await saveTask(ctx, context.taskKey, next, "dev:integrate");
  return next;
}

async function refreshPlan(
  ctx: StepContext,
  context: TaskContext,
): Promise<void> {
  const plan = await getPlan(
    ctx.store,
    storeKey(context.repository.name, context.task.plan),
  );
  await refreshPlanCounts(ctx.store, plan);
}

function integrationData(
  record: IntegrationRecord,
  attempt: TaskAttempt,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    attempt: attempt.number,
    result: record.result,
    ...(record.verified === undefined ? {} : { verified: record.verified }),
    ...(record.candidate === undefined ? {} : { candidate: record.candidate }),
    ...(record.base === undefined ? {} : { base: record.base }),
    ...(record.head === undefined ? {} : { head: record.head }),
    ...(record.headMoved === undefined ? {} : { headMoved: record.headMoved }),
    ...(record.pushed === undefined ? {} : { pushed: record.pushed }),
    ...(record.message === undefined ? {} : { message: record.message }),
    ...(record.command === undefined ? {} : { command: record.command }),
    ...(record.log === undefined ? {} : { log: record.log }),
    ...(record.lineNumber === undefined
      ? {}
      : { lineNumber: record.lineNumber }),
    ...(record.files === undefined ? {} : { files: record.files }),
    ...extra,
  };
}

/** Step `dev/integrate`: land the verified commit on main. */
export async function runIntegrate(
  ctx: StepContext,
): Promise<PluginStepResult> {
  const context = await taskContext(ctx);
  const task = context.task;
  const settings = context.settings;
  const attempt = task.attempt ?? {
    number: Math.max(task.attempts, 0) + 1,
    run: ctx.runId,
  };
  const verified = task.attempt?.verified;
  const repository = context.repository.path;
  const gate = gateWorktreePath(
    repository,
    settings,
    context.taskId,
  );
  const head = branchHead(repository, settings, context.taskId);
  const mainRef = `refs/remotes/${settings.remote}/${settings.mainBranch}`;
  const keyCommands = settings.integration.keyCommands;
  const runStep = ctx.runStep;

  const fail = async (
    message: string,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<PluginStepResult> => {
    const record: IntegrationRecord = {
      result: "failed",
      run: ctx.runId,
      style: settings.integration.style,
      ...(typeof verified === "string" ? { verified } : {}),
      ...(head === undefined ? {} : { head }),
      ...(verified === undefined ? {} : { headMoved: head !== verified }),
      message,
    };
    await writeIntegration(ctx, context, task, attempt, record, {
      phase: "waiting",
    });
    return {
      result: "failed",
      data: integrationData(record, attempt, { message, ...extra }),
    };
  };

  if (typeof verified !== "string" || verified.length === 0) {
    return fail("the task has no verified commit to integrate");
  }
  const headMoved = head !== undefined && head !== verified;
  const message = `Merge work/${context.taskId} (${shortSha(verified)})`;

  // A replay after the push must not push again. The candidate saved before the
  // push and the remote's main decide whether the push already landed.
  const previous = task.attempt?.integration;
  if (
    previous !== undefined &&
    previous !== null &&
    previous.run === ctx.runId &&
    typeof previous.candidate === "string" &&
    previous.candidate.length > 0
  ) {
    const fetched = git(repository, ["fetch", "--prune", settings.remote]);
    const remoteMain = revParse(repository, mainRef);
    if (
      fetched.ok &&
      remoteMain !== undefined &&
      contains(repository, previous.candidate, remoteMain)
    ) {
      const record: IntegrationRecord = {
        ...previous,
        result: "merged",
        run: ctx.runId,
        verified,
        candidate: previous.candidate,
        head: head ?? previous.head ?? null,
        headMoved,
        pushed: true,
        style: settings.integration.style,
      };
      await writeIntegration(ctx, context, task, attempt, record, {
        phase: "merged",
        change: `merged ${shortSha(previous.candidate)}`,
      });
      await refreshPlan(ctx, context);
      return {
        result: "merged",
        data: integrationData(record, attempt, { replayed: true }),
      };
    }
  }

  let lastError = "";
  for (let round = 0; round < MAX_INTEGRATION_ROUNDS; round += 1) {
    const fetched = git(repository, ["fetch", "--prune", settings.remote]);
    if (!fetched.ok) {
      return fail(
        `cannot fetch "${settings.remote}": ${fetched.err || fetched.out || "git fetch failed"}`,
      );
    }
    const base = revParse(repository, mainRef);
    if (base === undefined) {
      return fail(`"${settings.remote}/${settings.mainBranch}" does not exist after the fetch`);
    }

    const prepared = recreateGateWorktree(repository, gate, base);
    if (prepared !== undefined) return fail(prepared);

    const candidate = mergeCandidate(
      gate,
      verified,
      settings.integration.style,
      message,
    );
    if (candidate.kind === "conflict") {
      clearConflict(gate);
      const files = candidate.files ?? [];
      const text = [
        files.length === 0
          ? "The verified commit conflicts with the latest main."
          : [
              "The verified commit conflicts with the latest main in these files:",
              ...files.map((file) => `- ${file}`),
            ].join("\n"),
        "Merge the latest main into the task branch, resolve the conflict, and continue.",
      ].join("\n\n");
      const withRework = appendRework(task, "conflict with main", text);
      const record: IntegrationRecord = {
        result: "conflict",
        run: ctx.runId,
        style: settings.integration.style,
        verified,
        base,
        head: head ?? null,
        headMoved,
        files,
      };
      await saveTask(
        ctx,
        context.taskKey,
        {
          ...withRework,
          phase: "running",
          run: ctx.runId,
          attempts: Math.max(task.attempts, attempt.number),
          attempt: { ...attempt, run: ctx.runId, integration: record },
        },
        "dev:integrate",
      );
      return {
        result: "conflict",
        data: integrationData(record, attempt, { files, rework: true }),
      };
    }
    if (candidate.kind === "failed" || candidate.sha === undefined) {
      return fail(candidate.message ?? "cannot build the candidate");
    }
    const sha = candidate.sha;

    if (keyCommands.length > 0) {
      if (runStep === undefined) {
        return fail("the kernel did not offer a way to run the integration checks");
      }
      let outcome: PluginStepResult | undefined;
      let hostError: string | undefined;
      try {
        outcome = await runStep(
          "shell/check",
          { lines: keyCommands, cwd: gate },
          stepOptions(ctx, gate),
        );
      } catch (error) {
        hostError = messageOf(error);
      }
      if (hostError !== undefined || outcome?.result !== "pass") {
        const data =
          outcome !== undefined && isRecord(outcome.data) ? outcome.data : {};
        const command =
          typeof data.line === "string" ? data.line : undefined;
        const log = typeof data.log === "string" ? data.log : undefined;
        const lineNumber =
          typeof data.lineNumber === "number" ? data.lineNumber : undefined;
        const detail =
          hostError ??
          (typeof data.message === "string" ? data.message : undefined) ??
          `the integration checks failed (${outcome?.result ?? "unknown"})`;
        const pieces = [
          command === undefined
            ? "An integration check failed."
            : `The integration check failed: \`${command}\``,
          ...(log === undefined ? [] : [`Log: \`${log}\``]),
          detail,
        ];
        const withRework = appendRework(
          task,
          "integration",
          pieces.join("\n\n"),
        );
        const record: IntegrationRecord = {
          result: "fail",
          run: ctx.runId,
          style: settings.integration.style,
          verified,
          candidate: sha,
          base,
          head: head ?? null,
          headMoved,
          ...(command === undefined ? {} : { command }),
          ...(log === undefined ? {} : { log }),
          ...(lineNumber === undefined ? {} : { lineNumber }),
          message: detail,
        };
        await saveTask(
          ctx,
          context.taskKey,
          {
            ...withRework,
            phase: "running",
            run: ctx.runId,
            attempts: Math.max(task.attempts, attempt.number),
            attempt: { ...attempt, run: ctx.runId, integration: record },
          },
          "dev:integrate",
        );
        return {
          result: "fail",
          data: integrationData(record, attempt, { rework: true }),
        };
      }
    }

    // Record the candidate before the push: a crash after the push finds it and
    // the remote's main, and finishes without pushing again.
    const pending: IntegrationRecord = {
      result: "pending",
      run: ctx.runId,
      style: settings.integration.style,
      verified,
      candidate: sha,
      base,
      head: head ?? null,
      headMoved,
      pushed: false,
    };
    await writeIntegration(ctx, context, task, attempt, pending);

    const push = git(gate, [
      "push",
      settings.remote,
      `HEAD:refs/heads/${settings.mainBranch}`,
    ]);
    if (push.ok) {
      integrateTestHooks.afterPush?.(sha);
      const record: IntegrationRecord = {
        ...pending,
        result: "merged",
        pushed: true,
      };
      await writeIntegration(ctx, context, task, attempt, record, {
        phase: "merged",
        change: `merged ${shortSha(sha)}`,
      });
      await refreshPlan(ctx, context);
      return { result: "merged", data: integrationData(record, attempt) };
    }

    lastError = `cannot push "${settings.mainBranch}" to "${settings.remote}": ${push.err || push.out || "git push failed"}`;
    git(repository, ["fetch", "--prune", settings.remote]);
    const now = revParse(repository, mainRef);
    // Only a main that moved makes the same candidate worth building again; a
    // remote that refused the push for another reason is a failure.
    if (now !== undefined && now !== base) continue;
    return fail(lastError, { candidate: sha, base, head, headMoved });
  }

  return fail(
    `main moved ${MAX_INTEGRATION_ROUNDS} times while the candidate was built; ${lastError}`,
  );
}

/** Step `dev/cleanup`: run the after-merge hooks and remove the task's traces. */
export async function runCleanup(
  ctx: StepContext,
): Promise<PluginStepResult> {
  const context = await taskContext(ctx);
  const task = context.task;
  const settings: DevSettings = context.settings;
  const attempt = task.attempt ?? {
    number: Math.max(task.attempts, 0) + 1,
    run: ctx.runId,
  };
  const worktree = worktreePath(
    context.repository.path,
    settings,
    context.taskId,
  );
  const env: Record<string, string> = {
    OPERAD_TASK: context.taskId,
    OPERAD_WORKTREE: worktree,
    OPERAD_REMOTE: settings.remote,
  };
  const failures: CleanupFailure[] = [];
  const runStep = ctx.runStep;

  if (runStep === undefined) {
    if (settings.hooks.afterMerge.length > 0) {
      failures.push({
        line: 0,
        text: "",
        message: "the kernel did not offer a way to run the cleanup hooks",
      });
    }
  } else {
    for (const [index, line] of settings.hooks.afterMerge.entries()) {
      let outcome: PluginStepResult | undefined;
      let hostError: string | undefined;
      try {
        outcome = await runStep(
          "shell/command",
          { line, cwd: context.repository.path, env },
          stepOptions(ctx, context.repository.path),
        );
      } catch (error) {
        hostError = messageOf(error);
      }
      if (hostError !== undefined || outcome?.result !== "pass") {
        const data =
          outcome !== undefined && isRecord(outcome.data) ? outcome.data : {};
        failures.push({
          line: index + 1,
          text: line,
          message:
            hostError ??
            (typeof data.message === "string"
              ? data.message
              : `the hook ended "${outcome?.result ?? "unknown"}"`),
        });
      }
    }
  }

  const record: CleanupRecord = { run: ctx.runId, failures };
  const next: TaskData = {
    ...task,
    phase: "merged",
    run: ctx.runId,
    attempts: Math.max(task.attempts, attempt.number),
    attempt: { ...attempt, run: ctx.runId, cleanup: record },
    brief:
      failures.length === 0
        ? task.brief
        : appendChange(task.brief, `cleanup: ${failures.length} hook(s) failed`),
  };
  await saveTask(ctx, context.taskKey, next, "dev:cleanup");
  await refreshPlan(ctx, context);
  return {
    result: "done",
    data: {
      attempt: attempt.number,
      failures: failures.length,
      ...(failures.length === 0 ? {} : { failed: failures }),
    },
  };
}
