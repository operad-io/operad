/**
 * The end of a task's flow: land the verified commit on main, then clean the
 * worktrees and branches away. Both steps run git and shell here; the kernel
 * never runs either itself.
 */

import { fileURLToPath } from "node:url";
import { isRecord, messageOf, type PluginStepResult, type StepContext, type StepRunOptions } from "@operad-io/engine";
import { appendChange, appendRework, storeKey, type CleanupFailure, type CleanupRecord, type IntegrationRecord, type TaskAttempt, type TaskData } from "./model.ts";
import {
  branchHead,
  gateWorktreePath,
  recreateGateWorktree,
} from "./gate.ts";
import { runPrepare, stepOptions } from "./prepare.ts";
import { checkPlaces } from "./places.ts";
import {
  IntegrationQueue,
  IntegrationQueueCancelled,
  type BatchResult,
  type Ticket,
  type Turn,
} from "./integration-queue.ts";
import {
  mainCloneChange,
  runCommand,
  updateMainClone,
  type CommandRunner,
  type MainCloneOutcome,
} from "./mainclone.ts";
import { recordServeCode } from "./standing.ts";
import { runCheckSteadily } from "./notcode.ts";
import { runCheckCommands } from "./rerun.ts";
import { reportFlakyTests } from "./flaky.ts";
import { recordRerunPasses } from "./reruns.ts";
import { getPlan, refreshPlanCounts } from "./service.ts";
import {
  cancelledStep,
  claimAllows,
  conflictedFiles,
  git,
  headOf,
  mergeInProgress,
  saveTaskGuarded,
  taskContext,
  worktreePath,
  type TaskContext,
} from "./steps.ts";
import { followupMark } from "./followups.ts";
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
  /**
   * Called at each point where a kill leaves outside state changed: a test child
   * kills itself at a named point. The points are `candidate-built`,
   * `pending-saved`, `clone-followed` and `merged-saved`; the push has its own
   * hook above, and cleanup calls `hook-ran` after each after-merge hook.
   */
  at?: ((point: string) => void) | undefined;
  /** Replaces the command runner the main clone's install uses. */
  runCommand?: CommandRunner | undefined;
  /** The repository serve's code comes from; tests name a scratch one. */
  codeRoot?: string | undefined;
  /** Called once a task has taken its ticket in the integration queue. */
  queued?: ((task: string) => void) | undefined;
  /** Awaited once a task has the turn, before it builds anything. */
  turnTaken?: ((task: string) => Promise<void> | void) | undefined;
  /** Awaited by a batch's leader once it has claimed the tasks queued behind it. */
  claimed?: ((followers: readonly string[]) => Promise<void> | void) | undefined;
  /** How a task waits for its turn before it looks again. */
  wait?: ((ms: number) => Promise<void>) | undefined;
} = {};

/** The repository whose code this module was loaded from. */
function ownCodeRoot(): string {
  const result = git(fileURLToPath(new URL(".", import.meta.url)), [
    "rev-parse",
    "--show-toplevel",
  ]);
  return result.ok ? result.out : "";
}

export function followMain(
  repository: { readonly name: string; readonly path: string },
  home: string,
  branch: string,
  sha: string,
): MainCloneOutcome {
  const before = git(repository.path, ["rev-parse", "HEAD"]);
  const outcome = updateMainClone(
    repository.path,
    branch,
    sha,
    integrateTestHooks.runCommand ?? runCommand,
  );
  const after = git(repository.path, ["rev-parse", "HEAD"]);
  if (outcome.updated && before.ok && after.ok && before.out !== after.out) {
    const changed = git(repository.path, ["diff", "--name-only", before.out, after.out]);
    try {
      recordServeCode({
        home,
        codeRoot: integrateTestHooks.codeRoot ?? ownCodeRoot(),
        repository,
        from: before.out,
        to: after.out,
        files: changed.ok ? changed.out.split("\n").filter((line) => line.length > 0) : [],
        at: Date.now(),
      });
    } catch {
      // The note is a courtesy; the merge has landed either way.
    }
  }
  return outcome;
}

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
    // `--ff` overrides a user's `merge.ff=only`, which would refuse a squash
    // onto a main that moved.
    const merge = git(path, ["merge", "--squash", "--ff", verified]);
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
  readonly change?: string | readonly string[] | undefined;
  /** Keep the task marked as integrating: the push has not happened yet. */
  readonly integrating?: boolean | undefined;
}

async function writeIntegration(
  ctx: StepContext,
  context: TaskContext,
  task: TaskData,
  attempt: TaskAttempt,
  record: IntegrationRecord,
  options: SaveOptions = {},
): Promise<TaskData | undefined> {
  const brief =
    options.change === undefined
      ? task.brief
      : [options.change].flat().reduce((text, line) => appendChange(text, line), task.brief);
  const next: TaskData = {
    ...task,
    ...(options.phase === undefined ? {} : { phase: options.phase }),
    ...(options.phase === "merged" ? followupMark(task, context.settings) : {}),
    run: ctx.runId,
    attempts: Math.max(task.attempts, attempt.number),
    attempt: {
      ...attempt,
      run: ctx.runId,
      integration: record,
      ...(options.integrating === true ? { integrating: ctx.runId } : {}),
    },
    brief,
  };
  const written = await saveTaskGuarded(
    ctx,
    context.taskKey,
    next,
    "dev:integrate",
  );
  return written ? next : undefined;
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
    ...(typeof record.checkNote === "string" ? { note: record.checkNote } : {}),
    ...(isRecord(record.mainClone) ? { mainClone: record.mainClone } : {}),
    ...extra,
  };
}

/** Step `dev/integrate`: land the verified commit on main. */
function treeOf(cwd: string, commit: string): string | undefined {
  const result = git(cwd, ["rev-parse", "--verify", "--quiet", `${commit}^{tree}`]);
  return result.ok && result.out.length > 0 ? result.out : undefined;
}

/** The patch id of a diff, which ignores line numbers and whitespace. */
function patchIdOf(cwd: string, args: readonly string[]): string | undefined {
  const diff = git(cwd, args, { raw: true });
  if (!diff.ok || diff.out.length === 0) return undefined;
  const id = git(cwd, ["patch-id", "--stable"], { input: diff.out });
  const first = id.out.split(/\s+/)[0];
  return id.ok && first !== undefined && first.length > 0 ? first : undefined;
}

/**
 * The commit on `main` that carries the change of `verified`, found by patch
 * id, so a squash or a merge made under another message is still recognised.
 */
function carrierOnMain(cwd: string, verified: string, main: string): string | undefined {
  // A verified commit that main contains arrived in the first commit of main's
  // own line that has it.
  if (git(cwd, ["merge-base", "--is-ancestor", verified, main]).ok) {
    const arrived = git(cwd, [
      "rev-list",
      "--first-parent",
      "--ancestry-path",
      "--reverse",
      `${verified}..${main}`,
    ]);
    return arrived.ok ? arrived.out.split("\n")[0] || undefined : undefined;
  }
  const base = git(cwd, ["merge-base", verified, main]);
  if (!base.ok || base.out.length === 0) return undefined;
  const want = patchIdOf(cwd, ["diff", base.out, verified]);
  if (want === undefined) return undefined;
  const recent = git(cwd, ["rev-list", "--first-parent", "--max-count=200", main]);
  if (!recent.ok) return undefined;
  for (const commit of recent.out.split("\n")) {
    if (commit.length === 0) continue;
    if (patchIdOf(cwd, ["diff", `${commit}^`, commit]) === want) return commit;
  }
  return undefined;
}

export async function runIntegrate(
  ctx: StepContext,
): Promise<PluginStepResult> {
  const context = await taskContext(ctx);
  if (!claimAllows(ctx, context.task)) return cancelledStep();
  const task = context.task;
  const settings = context.settings;
  // Every result this step writes ends the "integrating" mark; only the start
  // and the pending record, written before the push, set it.
  const attempt: TaskAttempt = {
    ...(task.attempt ?? {
      number: Math.max(task.attempts, 0) + 1,
      run: ctx.runId,
    }),
    integrating: null,
    integrationWait: null,
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
    if (
      (await writeIntegration(ctx, context, task, attempt, record, {
        phase: "waiting",
      })) === undefined
    ) {
      return cancelledStep();
    }
    return {
      result: "failed",
      data: integrationData(record, attempt, { message, ...extra }),
    };
  };

  let flakyReason: string | undefined;
  /** The other tasks this task was merged with in one batch. */
  let batchWith: readonly string[] = [];
  const recordMerged = async (
    record: IntegrationRecord,
    sha: string,
    extra: Readonly<Record<string, unknown>> = {},
    cloneSha: string = sha,
    mergedLine: string = `merged as ${shortSha(sha)}`,
  ): Promise<PluginStepResult> => {
    const note = record.checkNote;
    const clone = followMain(context.repository, ctx.home, settings.mainBranch, cloneSha);
    integrateTestHooks.at?.("clone-followed");
    const cloneChange = mainCloneChange(clone);
    const withClone: IntegrationRecord = { ...record, mainClone: { ...clone } };
    if (
      (await writeIntegration(ctx, context, task, attempt, withClone, {
        phase: "merged",
        change: [
          ...(typeof note === "string" ? [note] : []),
          ...(batchWith.length === 0
            ? []
            : [`integrated in a batch with ${batchWith.join(", ")}`]),
          mergedLine,
          ...(cloneChange === undefined ? [] : [cloneChange]),
        ],
      })) === undefined
    ) {
      return cancelledStep();
    }
    integrateTestHooks.at?.("merged-saved");
    await refreshPlan(ctx, context);
    return {
      result: "merged",
      data: integrationData(withClone, attempt, {
        ...extra,
        ...(batchWith.length === 0 ? {} : { batch: batchWith }),
        ...(flakyReason === undefined ? {} : { reason: flakyReason }),
      }),
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
      // A batch's leader saved the batch's head and its other tasks with the
      // candidate: the clone follows the head, and the brief says the batch.
      const previousBatch = Array.isArray(previous.batch)
        ? previous.batch.filter((name): name is string => typeof name === "string")
        : [];
      const clone = followMain(
        context.repository,
        ctx.home,
        settings.mainBranch,
        typeof previous.batchHead === "string" ? previous.batchHead : previous.candidate,
      );
      const cloneChange = mainCloneChange(clone);
      const withClone: IntegrationRecord = {
        ...record,
        mainClone: { ...clone },
      };
      if (
        (await writeIntegration(ctx, context, task, attempt, withClone, {
          phase: "merged",
          // A kill after the merge was recorded leaves its lines in the brief;
          // say them once.
          change:
            previous.result === "merged"
              ? []
              : [
                  ...(typeof previous.checkNote === "string"
                    ? [previous.checkNote]
                    : []),
                  ...(previousBatch.length === 0
                    ? []
                    : [`integrated in a batch with ${previousBatch.join(", ")}`]),
                  `merged as ${shortSha(previous.candidate)}`,
                  ...(cloneChange === undefined ? [] : [cloneChange]),
                ],
        })) === undefined
      ) {
        return cancelledStep();
      }
      await refreshPlan(ctx, context);
      return {
        result: "merged",
        data: integrationData(withClone, attempt, { replayed: true }),
      };
    }
  }

  const queue = new IntegrationQueue({
    home: ctx.home,
    repository: context.repository,
    task: context.taskId,
    run: ctx.runId,
    verified,
    message,
    signal: ctx.signal,
    wait: integrateTestHooks.wait,
    landed: (result) => {
      if (!git(repository, ["fetch", "--prune", settings.remote]).ok) return false;
      const main = revParse(repository, mainRef);
      return main !== undefined && contains(repository, result.head, main);
    },
    say: async (line, holder) => {
      await ctx.logger.write(line);
      const saved = await saveTaskGuarded(
        ctx,
        context.taskKey,
        {
          ...task,
          attempt: {
            ...attempt,
            integrating: ctx.runId,
            integrationWait: `${holder} is integrating`,
          },
        },
        "dev:integrate",
      );
      if (!saved) throw new IntegrationQueueCancelled();
    },
  });
  await queue.join();
  integrateTestHooks.queued?.(context.taskId);

  /** This task's merge commit when main already has it, and the main that has it. */
  const alreadyOnMain = (): { sha: string; main: string } | undefined => {
    if (!git(repository, ["fetch", "--prune", settings.remote]).ok) return undefined;
    const main = revParse(repository, mainRef);
    if (main === undefined) return undefined;
    const found = git(repository, [
      "log",
      "--first-parent",
      "--fixed-strings",
      `--grep=${message}`,
      "--format=%H%x09%s",
      main,
    ]);
    if (!found.ok) return undefined;
    for (const line of found.out.split("\n")) {
      const [sha, subject] = line.split("\t");
      if (sha !== undefined && subject === message) return { sha, main };
    }
    return undefined;
  };

  /** Lands the tasks of a batch with one candidate; undefined means fall back to one by one. */
  const landBatch = async (
    followers: readonly Ticket[],
  ): Promise<PluginStepResult | undefined> => {
    const entries = [
      { task: context.taskId, verified, message },
      ...followers.map((ticket) => ({
        task: ticket.task,
        verified: ticket.verified,
        message: ticket.message,
      })),
    ];
    for (let round = 0; round < MAX_INTEGRATION_ROUNDS; round += 1) {
      const fetched = git(repository, ["fetch", "--prune", settings.remote]);
      if (!fetched.ok) return undefined;
      const base = revParse(repository, mainRef);
      if (base === undefined) return undefined;
      if (recreateGateWorktree(repository, gate, base, settings) !== undefined) {
        return undefined;
      }
      const members: { task: string; sha: string }[] = [];
      let treeBefore = treeOf(gate, "HEAD");
      for (const entry of entries) {
        const built = mergeCandidate(
          gate,
          entry.verified,
          settings.integration.style,
          entry.message,
        );
        if (built.kind === "conflict") clearConflict(gate);
        if (built.kind !== "ok" || built.sha === undefined) return undefined;
        // A member with nothing left to merge is already on main: one by one.
        if (treeOf(gate, built.sha) === treeBefore) return undefined;
        treeBefore = treeOf(gate, built.sha);
        members.push({ task: entry.task, sha: built.sha });
      }
      const batchHead = headOf(gate);
      const own = members[0];
      if (batchHead === undefined || own === undefined) return undefined;

      let checkNote: string | undefined;
      if (keyCommands.length > 0) {
        if ((await runPrepare(ctx, settings, gate)) !== undefined) return undefined;
        if (runStep === undefined) return undefined;
        const steady = await runCheckSteadily({
          run: () =>
            runCheckCommands(
              runStep,
              { cwd: gate },
              keyCommands,
              stepOptions(ctx, gate),
              settings.check.rerun,
              checkPlaces(ctx, context.repository, settings.gate.places, context.taskKey),
            ),
          limit: settings.check.loadLimit,
          signal: ctx.signal,
          log: (text) => ctx.logger.write(text),
        });
        if (steady.cancelled === true) return cancelledStep();
        const { checked } = steady;
        await recordRerunPasses(ctx.store, checked.passedOnRerun);
        if (steady.notCode !== undefined) {
          // The batch's candidate was not accepted: the leader waits for a
          // person, and the tasks it claimed integrate alone.
          const data =
            checked.outcome !== undefined && isRecord(checked.outcome.data)
              ? checked.outcome.data
              : {};
          const command = typeof data.line === "string" ? data.line : undefined;
          const log = typeof data.log === "string" ? data.log : undefined;
          const lineNumber =
            typeof data.lineNumber === "number" ? data.lineNumber : undefined;
          const detail =
            checked.hostError ??
            (typeof data.message === "string"
              ? data.message
              : "the integration checks failed");
          const record: IntegrationRecord = {
            result: "failed",
            run: ctx.runId,
            style: settings.integration.style,
            verified,
            candidate: own.sha,
            base,
            head: head ?? null,
            headMoved,
            ...(command === undefined ? {} : { command }),
            ...(log === undefined ? {} : { log }),
            ...(lineNumber === undefined ? {} : { lineNumber }),
            message: `${steady.notCode.cause}; ${detail}`,
            notCode: steady.notCode.cause,
          };
          queue.fallBack(followers);
          if (
            (await writeIntegration(ctx, context, task, attempt, record, {
              phase: "waiting",
            })) === undefined
          ) {
            return cancelledStep();
          }
          return {
            result: "failed",
            data: integrationData(record, attempt, { message: record.message }),
          };
        }
        if (checked.hostError !== undefined || checked.outcome?.result !== "pass") {
          return undefined;
        }
        const flakyNotice = await reportFlakyTests({
          ctx,
          repository: context.repository,
          taskId: context.taskId,
          threshold: context.settings.check.flakyTask,
          flakyPlan: context.settings.check.flakyPlan,
          check: checked,
          loads: steady.loads,
          loadLimit: settings.check.flakyLoadLimit,
        });
        checkNote =
          flakyNotice === undefined
            ? checked.note
            : [checked.note, flakyNotice].filter((part) => part !== undefined).join("; ");
        flakyReason = flakyNotice;
      }

      const pending: IntegrationRecord = {
        result: "pending",
        run: ctx.runId,
        style: settings.integration.style,
        verified,
        candidate: own.sha,
        base,
        head: head ?? null,
        headMoved,
        pushed: false,
        batchHead,
        batch: members.filter((member) => member.task !== context.taskId).map((member) => member.task),
        ...(checkNote === undefined ? {} : { checkNote }),
      };
      if ((await writeIntegration(ctx, context, task, attempt, pending, {
          integrating: true,
        })) === undefined) {
        return cancelledStep();
      }
      // The result is left before the push, pending: a leader that dies after the
      // push leaves what its followers need to recognise their merges on main.
      const result: BatchResult = {
        base,
        head: batchHead,
        ...(checkNote === undefined ? {} : { note: checkNote }),
        members,
      };
      const land = async (extra: Readonly<Record<string, unknown>>): Promise<PluginStepResult> => {
        batchWith = members.filter((member) => member.task !== context.taskId).map((member) => member.task);
        const merged = await recordMerged({ ...pending, result: "merged", pushed: true }, own.sha, extra, batchHead);
        queue.finish();
        return merged;
      };
      // A claimed task that left (cancelled) is not merged: one by one instead.
      // Checked last, so the window between this and the push is as short as it can be.
      if (queue.stillQueued(followers).length !== followers.length) return undefined;
      queue.publish(result);
      const push = git(gate, ["push", settings.remote, `HEAD:refs/heads/${settings.mainBranch}`]);
      if (push.ok) {
        integrateTestHooks.afterPush?.(batchHead);
        return land({});
      }
      git(repository, ["fetch", "--prune", settings.remote]);
      const now = revParse(repository, mainRef);
      if (now !== undefined && contains(repository, batchHead, now)) {
        return land({ landed: true });
      }
      if (now !== undefined && now !== base) continue;
      return undefined;
    }
    return undefined;
  };

  /** Records the merge a batch's leader made for this task. */
  const recordBatched = async (
    leaderResult: BatchResult,
  ): Promise<PluginStepResult> => {
    const mine = leaderResult.members.find((member) => member.task === context.taskId);
    if (mine === undefined) return fail("the batch that merged this task does not list it");
    batchWith = leaderResult.members
      .filter((member) => member.task !== context.taskId)
      .map((member) => member.task);
    const record: IntegrationRecord = {
      result: "merged",
      run: ctx.runId,
      style: settings.integration.style,
      verified,
      candidate: mine.sha,
      base: leaderResult.base,
      head: head ?? null,
      headMoved,
      pushed: true,
      ...(leaderResult.note === undefined ? {} : { checkNote: leaderResult.note }),
    };
    return recordMerged(record, mine.sha, {}, leaderResult.head);
  };

  try {
    let turn: Turn;
    try {
      turn = await queue.turn();
    } catch (error) {
      if (error instanceof IntegrationQueueCancelled) return cancelledStep();
      throw error;
    }
    if (turn.kind === "batched") return await recordBatched(turn.result);
    await integrateTestHooks.turnTaken?.(context.taskId);

    // A leader that died after its push left this task's merge on main, and the
    // task's own record knows nothing of it: find the merge there instead of
    // merging the same commit again into an empty candidate.
    const landed = alreadyOnMain();
    if (landed !== undefined) {
      // The dead leader's note and batch are gone; main still has the base.
      const landedBase = revParse(repository, `${landed.sha}^1`);
      return recordMerged(
        {
          result: "merged",
          run: ctx.runId,
          style: settings.integration.style,
          verified,
          candidate: landed.sha,
          ...(landedBase === undefined ? {} : { base: landedBase }),
          head: head ?? null,
          headMoved,
          pushed: true,
        },
        landed.sha,
        { replayed: true },
        landed.main,
      );
    }

    // From here the step builds and checks the candidate: the row says integrating.
    if (
      !(await saveTaskGuarded(
        ctx,
        context.taskKey,
        { ...task, attempt: { ...attempt, integrating: ctx.runId } },
        "dev:integrate",
      ))
    ) {
      return cancelledStep();
    }

    const followers = queue.claim(settings.integration.batch);
    if (followers.length > 0) {
      await integrateTestHooks.claimed?.(followers.map((ticket) => ticket.task));
      const landed = await landBatch(followers);
      if (landed !== undefined) return landed;
      queue.fallBack(followers);
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

      const prepared = recreateGateWorktree(repository, gate, base, settings);
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
        const withRework = appendRework(
          task,
          "conflict with main",
          text,
          files.length === 0
            ? "the verified commit conflicts with the latest main"
            : `conflicts with the latest main in ${files.join(", ")}`,
        );
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
        const written = await saveTaskGuarded(
          ctx,
          context.taskKey,
          {
            ...withRework,
            reviewFailed: undefined,
            phase: "running",
            run: ctx.runId,
            attempts: Math.max(task.attempts, attempt.number),
            attempt: { ...attempt, run: ctx.runId, integration: record },
          },
          "dev:integrate",
        );
        if (!written) return cancelledStep();
        return {
          result: "conflict",
          data: integrationData(record, attempt, { files, rework: true }),
        };
      }
      if (candidate.kind === "failed" || candidate.sha === undefined) {
        return fail(candidate.message ?? "cannot build the candidate");
      }
      const sha = candidate.sha;
      integrateTestHooks.at?.("candidate-built");
      // A candidate with main's own tree has nothing left to merge: the change
      // is already there, in whatever commit carries it. Nothing is pushed and
      // no commit is claimed as this task's.
      if (treeOf(gate, sha) === treeOf(repository, base)) {
        const carrier = carrierOnMain(repository, verified, base);
        return recordMerged(
          {
            result: "merged",
            run: ctx.runId,
            style: settings.integration.style,
            verified,
            candidate: carrier ?? base,
            base,
            head: head ?? null,
            headMoved,
            pushed: true,
          },
          carrier ?? base,
          { alreadyOnMain: true },
          base,
          carrier === undefined ? "already on main" : `already on main as ${shortSha(carrier)}`,
        );
      }

      let checkNote: string | undefined;
      if (keyCommands.length > 0) {
        const prepareFailure = await runPrepare(ctx, settings, gate);
        if (prepareFailure !== undefined) {
          return fail(prepareFailure.message, {
            candidate: sha,
            base,
            reason: prepareFailure.reason,
            ...(prepareFailure.log === undefined ? {} : { log: prepareFailure.log }),
          });
        }
        if (runStep === undefined) {
          return fail("the kernel did not offer a way to run the integration checks");
        }
        const steady = await runCheckSteadily({
          run: () =>
            runCheckCommands(
              runStep,
              { cwd: gate },
              keyCommands,
              stepOptions(ctx, gate),
              settings.check.rerun,
              checkPlaces(ctx, context.repository, settings.gate.places, context.taskKey),
            ),
          limit: settings.check.loadLimit,
          signal: ctx.signal,
          log: (text) => ctx.logger.write(text),
        });
        if (steady.cancelled === true) return cancelledStep();
        const { checked } = steady;
        await recordRerunPasses(ctx.store, checked.passedOnRerun);
        const flakyNotice = await reportFlakyTests({
          ctx,
          repository: context.repository,
          taskId: context.taskId,
          threshold: context.settings.check.flakyTask,
          flakyPlan: context.settings.check.flakyPlan,
          check: checked,
          loads: steady.loads,
          loadLimit: settings.check.flakyLoadLimit,
        });
        const { outcome, hostError } = checked;
        checkNote =
          flakyNotice === undefined
            ? checked.note
            : [checked.note, flakyNotice].filter((part) => part !== undefined).join("; ");
        flakyReason = flakyNotice;
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
          if (steady.notCode !== undefined) {
            // Not the code: no rework, a person decides, and the line says why.
            const record: IntegrationRecord = {
              result: "failed",
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
              message: `${steady.notCode.cause}; ${detail}`,
              notCode: steady.notCode.cause,
            };
            if (
              (await writeIntegration(ctx, context, task, attempt, record, {
                phase: "waiting",
              })) === undefined
            ) {
              return cancelledStep();
            }
            return {
              result: "failed",
              data: integrationData(record, attempt, { message: record.message }),
            };
          }
          const pieces = [
            command === undefined
              ? "An integration check failed."
              : `The integration check failed: \`${command}\``,
            ...(log === undefined ? [] : [`Log: \`${log}\``]),
            detail,
            ...(flakyNotice === undefined ? [] : [`Note: ${flakyNotice}`]),
          ];
          const withRework = appendRework(
            task,
            "integration",
            pieces.join("\n\n"),
            command === undefined
              ? detail
              : `the integration check failed: ${command}`,
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
            message: flakyNotice === undefined ? detail : `${detail}; ${flakyNotice}`,
          };
          const written = await saveTaskGuarded(
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
          if (!written) return cancelledStep();
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
        ...(checkNote === undefined ? {} : { checkNote }),
      };
      if ((await writeIntegration(ctx, context, task, attempt, pending, {
          integrating: true,
        })) === undefined) {
        return cancelledStep();
      }
      integrateTestHooks.at?.("pending-saved");

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
        return recordMerged(record, sha);
      }

      lastError = `cannot push "${settings.mainBranch}" to "${settings.remote}": ${push.err || push.out || "git push failed"}`;
      git(repository, ["fetch", "--prune", settings.remote]);
      const now = revParse(repository, mainRef);
      // A push can land on the remote and still report an error (the client lost
      // the answer). The remote's main then contains the candidate: it is
      // merged, and building and pushing a second candidate would be wrong.
      if (now !== undefined && contains(repository, sha, now)) {
        const record: IntegrationRecord = {
          ...pending,
          result: "merged",
          pushed: true,
        };
        return recordMerged(record, sha, { landed: true });
      }
      // Only a main that moved makes the same candidate worth building again; a
      // remote that refused the push for another reason is a failure.
      if (now !== undefined && now !== base) continue;
      return fail(lastError, { candidate: sha, base, head, headMoved });
    }

    return fail(
      `main moved ${MAX_INTEGRATION_ROUNDS} times while the candidate was built; ${lastError}`,
    );
  } finally {
    queue.leave();
  }
}

/** Step `dev/cleanup`: run the after-merge hooks and remove the task's traces. */
export async function runCleanup(
  ctx: StepContext,
): Promise<PluginStepResult> {
  const context = await taskContext(ctx);
  if (!claimAllows(ctx, context.task)) return cancelledStep();
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
      integrateTestHooks.at?.("hook-ran");
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
  if (!(await saveTaskGuarded(ctx, context.taskKey, next, "dev:cleanup"))) {
    return cancelledStep();
  }
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
