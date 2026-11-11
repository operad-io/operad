/**
 * Steps `dev/retry` and `dev/retry_due`: a step that stopped because of operad
 * or the machine, not because of the task's own work, runs once more without a
 * person. The flow runs `retry` in front of every announcement of such a stop.
 * A second stop of that kind in the same attempt, or a wait that ran out, goes
 * to a person with the cause in the waiting line.
 */

import type { PluginStepResult, StepContext } from "@operad-io/engine";
import { reviewTestHooks, waitFor } from "./gate.ts";
import type { RetryRecord, TaskData } from "./model.ts";
import { DEFAULT_DEV_SETTINGS, readDevSettings } from "./settings.ts";
import { classifyStop } from "./stops.ts";
import {
  cancelledStep,
  claimAllows,
  looseTaskContext,
  saveTaskGuarded,
} from "./steps.ts";

/** How often a retry looks again at what it waits for. */
export const RETRY_POLL_MS = 5_000;

/** The edge a task took into the retry step, as the flow names it in its params. */
export interface RetryParams {
  readonly from: string;
  /** `failed`, `interrupted`, or `waited` after the wait for what was missing. */
  readonly result: string;
}

function paramsOf(params: unknown): RetryParams {
  const record =
    typeof params === "object" && params !== null && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  return {
    from: typeof record.from === "string" ? record.from : "",
    result: typeof record.result === "string" ? record.result : "",
  };
}

function attemptNumber(task: TaskData): number {
  return task.attempt?.number ?? task.attempts;
}

/** The retry this attempt already used, if any. */
function usedRetry(task: TaskData): RetryRecord | undefined {
  const retry = task.retry;
  return retry !== undefined && retry !== null && retry.attempt === attemptNumber(task)
    ? retry
    : undefined;
}

function now(): number {
  return reviewTestHooks.now?.() ?? Date.now();
}

/** Step `dev/retry`. */
export async function runRetry(
  ctx: StepContext,
  stepParams: unknown,
): Promise<PluginStepResult> {
  const context = await looseTaskContext(ctx);
  const task = context.task;
  if (!claimAllows(ctx, task)) return cancelledStep();
  const edge = paramsOf(stepParams);
  const used = usedRetry(task);

  const write = async (
    patch: Partial<Pick<TaskData, "stop" | "retry" | "phase">>,
  ): Promise<boolean> =>
    saveTaskGuarded(
      ctx,
      context.taskKey,
      { ...task, ...patch },
      "dev:retry",
    );

  if (edge.result === "waited") {
    // The wait for what was missing is over: it ended well, or it ran out.
    if (used?.state === "ready") {
      return (await write({ stop: null }))
        ? { result: "again", data: { reason: "retry", cause: used.cause } }
        : cancelledStep();
    }
    const cause = used?.cause ?? `run stopped during ${edge.from}`;
    const asked: RetryRecord | undefined =
      used === undefined ? undefined : { ...used, state: "asked" };
    const written = await write({
      stop: null,
      phase: "waiting",
      ...(asked === undefined ? {} : { retry: asked }),
    });
    return written
      ? { result: "give_up", data: { reason: "wait_expired", cause } }
      : cancelledStep();
  }

  const stop = task.stop;
  const classified = classifyStop({
    step: edge.from,
    result: edge.result,
    reason: stop?.step === edge.from ? stop.reason : undefined,
    use: stop?.use,
  });
  // A stopped run whose settings still cannot be read would only fail again:
  // wait for the settings first, within the same bound.
  const verdict =
    classified.kind === "environment" &&
    classified.waitFor === undefined &&
    context.settingsError !== undefined
      ? classifyStop({ step: edge.from, result: "failed", reason: "settings_unreadable" })
      : classified;
  if (verdict.kind === "task") {
    if (stop !== undefined && stop !== null && !(await write({ stop: null }))) {
      return cancelledStep();
    }
    return { result: "ask", data: { reason: "task" } };
  }
  const cause = verdict.cause ?? `run stopped during ${edge.from}`;

  if (used !== undefined) {
    // The one retry of this attempt is spent: a person decides now.
    const written = await write({
      stop: null,
      retry: { ...used, cause, state: "asked" },
      // A person decides now: the task says it waits, however the step ended.
      phase: "waiting" as const,
    });
    return written
      ? { result: "give_up", data: { reason: "retry_failed", cause } }
      : cancelledStep();
  }

  const waits = verdict.waitFor !== undefined;
  const retry: RetryRecord = {
    attempt: attemptNumber(task),
    step: edge.from,
    cause,
    at: now(),
    ...(verdict.waitFor === undefined ? {} : { waitFor: verdict.waitFor }),
    ...(verdict.use === undefined ? {} : { use: verdict.use }),
    state: waits ? "waiting" : "retrying",
  };
  const written = await write({ stop: null, retry, phase: "running" });
  if (!written) return cancelledStep();
  return {
    result: waits ? "hold" : "again",
    data: { reason: "retry", cause },
  };
}

/** True when what the retry waited for is there now. */
async function causeGone(
  ctx: StepContext,
  retry: RetryRecord,
  repositoryPath: string,
): Promise<boolean> {
  if (retry.waitFor === "step") {
    return retry.use === undefined || ctx.stepLoaded?.(retry.use) !== false;
  }
  try {
    await readDevSettings(repositoryPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Step `dev/retry_due`: the wait in front of a retry whose cause must go first.
 * It lets the flow carry on when the step is loaded or the settings can be
 * read, or when the bound from `retry.environmentWaitMinutes` has passed; the
 * retry step after it tells the two apart.
 */
export async function runRetryDue(ctx: StepContext): Promise<PluginStepResult> {
  const context = await looseTaskContext(ctx);
  if (!claimAllows(ctx, context.task)) {
    return { result: "interrupted", data: { reason: "cancelled" } };
  }
  const retry = usedRetry(context.task);
  if (retry === undefined || retry.state !== "waiting") {
    return { result: "ready", data: { at: now() } };
  }
  const minutes =
    context.settings?.retry.environmentWaitMinutes ??
    DEFAULT_DEV_SETTINGS.retry.environmentWaitMinutes;
  const deadline = retry.at + minutes * 60_000;
  const finish = async (state: "ready" | "expired"): Promise<PluginStepResult> => {
    const written = await saveTaskGuarded(
      ctx,
      context.taskKey,
      { ...context.task, retry: { ...retry, state } },
      "dev:retry",
    );
    return written
      ? { result: "ready", data: { state } }
      : { result: "interrupted", data: { reason: "cancelled" } };
  };
  if (await causeGone(ctx, retry, context.repository.path)) {
    return finish("ready");
  }
  if (now() >= deadline) return finish("expired");
  const wait = reviewTestHooks.wait ?? waitFor;
  const waited = await wait(
    Math.max(0, Math.min(RETRY_POLL_MS, deadline - now())),
    ctx.signal,
  );
  if (!waited) return { result: "interrupted", data: { reason: "cancelled" } };
  // Not over: the flow's wait asks again.
  return { result: "waiting", data: { cause: retry.cause } };
}
