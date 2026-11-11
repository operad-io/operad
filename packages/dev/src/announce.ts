/**
 * Step `dev/announce`: the flow runs it in front of every person wait. It tells
 * the outside world that a task now needs a person, once, and says the task
 * waits (a task still running or in review is not one a person can act on).
 * The reason comes from the edge that led here and from what the
 * task recorded, so the gate steps stay as they are.
 */

import type { PluginStepResult, StepContext } from "@operad-io/engine";
import { messageOf } from "@operad-io/engine";
import type { TaskData } from "./model.ts";
import {
  cancelledStep,
  claimAllows,
  mergeInProgress,
  saveTaskGuarded,
  taskContext,
} from "./steps.ts";

/** The event type a waiting task emits. */
export const WAITING_EVENT = "dev.waiting";

/** The edge a task took into the wait, as the flow names it in its params. */
export interface AnnounceParams {
  readonly from: string;
  readonly result: string;
}

/** Why a task waits: the short reason for the key, and what to add to the line. */
export interface WaitingReason {
  readonly reason: string;
  readonly detail?: string | undefined;
  /** The step that stopped, when the run did not reach an edge. */
  readonly step?: string | undefined;
}

function paramsOf(params: unknown): AnnounceParams {
  const record =
    typeof params === "object" && params !== null && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  const from = typeof record.from === "string" ? record.from : "";
  const result = typeof record.result === "string" ? record.result : "";
  return { from, result };
}

/** The step a repair run says stopped, from the line the worktree step wrote. */
function stoppedStep(task: TaskData, fallback: string): string {
  const lines = task.brief.replace(/\r\n/g, "\n").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^- (?:\[[^\]]*\] )?waiting: (\S+) stopped$/.exec(lines[index] ?? "");
    if (match !== null) return match[1] ?? fallback;
  }
  return fallback;
}

function nonEmpty(text: string | null | undefined): string | undefined {
  return typeof text === "string" && text.trim().length > 0
    ? text.trim()
    : undefined;
}

/**
 * The reason a task waits after an edge. `maxAutoRework` tells a rework that
 * ran out of automatic passes from one that was never allowed any.
 */
export function waitingReason(
  edge: AnnounceParams,
  task: TaskData,
  maxAutoRework: number,
  conflicted: boolean,
): WaitingReason {
  const attempt = task.attempt;
  if (edge.result === "environment") {
    // The one automatic retry did not help: the line says what was wrong.
    const cause = task.retry?.cause ?? `run stopped during ${edge.from}`;
    return { reason: cause, step: edge.from };
  }
  if (edge.result === "not_code") {
    // A check that was not the code twice: the line says what and under which load.
    const verify = attempt?.verify;
    const said = typeof verify?.notCode === "string" ? verify.notCode : undefined;
    return { reason: said ?? "check was not the code" };
  }
  switch (edge.from) {
    case "worktree":
      if (edge.result === "blocked") {
        return { reason: "dependency cancelled" };
      }
      {
        const step = stoppedStep(task, "worktree");
        return { reason: `run stopped during ${step}`, step };
      }
    case "work":
      if (edge.result === "interrupted") {
        return { reason: "run stopped during work", step: "work" };
      }
      if (conflicted) return { reason: "conflict" };
      if (edge.result === "nothing") return { reason: "work did nothing" };
      if (attempt?.workTimedOut === true) {
        return { reason: "work timed out", detail: nonEmpty(attempt.workNote) };
      }
      return {
        reason: "work failed",
        detail: nonEmpty(attempt?.workNote),
      };
    case "review":
      if (edge.result === "pass") {
        return { reason: "ready to merge" };
      }
      {
        const review = attempt?.review;
        const said = `${review?.reason ?? ""} ${review?.message ?? ""}`;
        if (/wall|stall|time/i.test(said)) {
          return { reason: "review timed out twice" };
        }
        return { reason: "review did not finish", detail: nonEmpty(review?.message) };
      }
    case "rework": {
      const rework = attempt?.rework;
      if (rework?.twice === true) {
        return { reason: "review failed twice in a row" };
      }
      if (maxAutoRework > 0) return { reason: "rework limit" };
      return {
        reason: rework?.source === "review" ? "review findings" : "gate failed",
      };
    }
    case "integrate": {
      const integration = attempt?.integration;
      const verified = attempt?.verified;
      if (typeof verified !== "string" || verified.length === 0) {
        return { reason: "no verified commit" };
      }
      if (typeof integration?.notCode === "string") {
        return { reason: integration.notCode };
      }
      return {
        reason: "merge refused",
        detail: nonEmpty(integration?.message),
      };
    }
    default:
      return { reason: "waiting" };
  }
}

/** One line a person reads: the task, why it waits, and the detail if any. */
export function waitingSummary(taskId: string, found: WaitingReason): string {
  const detail = found.detail === undefined ? "" : ` (${found.detail})`;
  return `${taskId} waiting: ${found.reason}${detail}`;
}

/** Step `dev/announce`. */
export async function runAnnounce(
  ctx: StepContext,
  stepParams: unknown,
): Promise<PluginStepResult> {
  const context = await taskContext(ctx);
  if (!claimAllows(ctx, context.task)) return cancelledStep();
  const edge = paramsOf(stepParams);
  const path = context.task.attempt?.worktree;
  const conflicted =
    edge.from === "work" &&
    edge.result !== "interrupted" &&
    edge.result !== "environment" &&
    typeof path === "string" &&
    mergeInProgress(path);
  const found = waitingReason(
    edge,
    context.task,
    context.settings.maxAutoRework,
    conflicted,
  );
  const attempt = Math.max(
    context.task.attempts,
    context.task.attempt?.number ?? 0,
  );
  const summary = waitingSummary(context.taskId, found);
  try {
    await ctx.emit({
      type: WAITING_EVENT,
      key: `${context.taskId}:${attempt}:${found.reason}`,
      summary,
      data: {
        task: context.taskId,
        attempt,
        reason: found.reason,
        ...(found.detail === undefined ? {} : { detail: found.detail }),
      },
    });
  } catch (error) {
    // The task still waits for a person; a lost notice must not stop that.
    await ctx.logger.write(`could not announce: ${messageOf(error)}`);
  }
  // The wait this step leads to is a person's: the phase says so. A failed
  // write leaves the scheduler to repair the phase on its next tick.
  if (context.task.phase === "running" || context.task.phase === "review") {
    try {
      await saveTaskGuarded(
        ctx,
        context.taskKey,
        { ...context.task, phase: "waiting" },
        "dev:announce-waiting",
      );
    } catch (error) {
      await ctx.logger.write(`could not mark the task waiting: ${messageOf(error)}`);
    }
  }
  // A stopped run keeps its result, so the wait can say which step stopped.
  return {
    result: found.step === undefined ? "done" : "interrupted",
    data: {
      reason: found.reason,
      summary,
      ...(found.step === undefined ? {} : { step: found.step }),
    },
  };
}
