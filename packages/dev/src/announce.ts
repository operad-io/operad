/**
 * Step `dev/announce`: the flow runs it in front of every person wait. It tells
 * the outside world that a task now needs a person, once, and says the task
 * waits (a task still running or in review is not one a person can act on).
 * The reason comes from the edge that led here and from what the
 * task recorded, so the gate steps stay as they are.
 */

import type { PluginStepResult, StepContext } from "@operad-io/engine";
import { messageOf } from "@operad-io/engine";
import type { ReviewFinding, TaskData } from "./model.ts";
import { severityRank } from "./rework.ts";
import { edgeParamsOf, type EdgeParams } from "./step-edge.ts";
import { WAIT_ACTIONS, waitChoiceInfo, type WaitAction } from "./waits.ts";
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
export type AnnounceParams = EdgeParams;

/** Why a task waits: the short reason for the key, and what to add to the line. */
export interface WaitingReason {
  readonly reason: string;
  readonly detail?: string | undefined;
  /** The step that stopped, when the run did not reach an edge. */
  readonly step?: string | undefined;
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

/** The most serious finding of the review that is at or above the fix level. */
function highestFinding(
  task: TaskData,
  fixLevel: string | undefined,
): ReviewFinding | undefined {
  const findings = (task.attempt?.review?.findings ?? []).filter(
    (finding) =>
      finding.preExisting !== true &&
      finding.pre_existing !== true &&
      (fixLevel === undefined ||
        severityRank(finding.severity) >= severityRank(fixLevel)),
  );
  return [...findings].sort(
    (left, right) =>
      severityRank(right.severity) - severityRank(left.severity) ||
      left.file.localeCompare(right.file) ||
      left.line - right.line,
  )[0];
}

function findingSentence(finding: ReviewFinding): string {
  const trigger = finding.trigger.trim();
  return `${finding.severity} finding at ${finding.file}:${finding.line}: ${finding.summary}${
    trigger.length === 0 ? "" : ` (${trigger})`
  }`;
}

/**
 * Why the task waits, in one or two plain sentences. It reads the task's own
 * record for the review's highest finding, the failed check's command and the
 * integration's reason; the choice list is never part of a prompt.
 */
export function waitingPrompt(
  found: WaitingReason,
  task: TaskData,
  fixLevel: string | undefined,
): string {
  const attempt = task.attempt;
  const finding = highestFinding(task, fixLevel);
  if (found.reason === "ready to merge") {
    return "The checks and the review passed; the task is ready to merge.";
  }
  if (found.reason === "work did nothing") {
    return "The worker changed nothing.";
  }
  if (found.reason === "work timed out") {
    return `The worker timed out.${found.detail === undefined ? "" : ` ${found.detail}.`}`;
  }
  if (found.reason === "work failed") {
    return `The worker failed${found.detail === undefined ? "" : `: ${found.detail}`}.`;
  }
  if (found.reason === "conflict") {
    return "The worker's changes conflict with main.";
  }
  if (found.reason === "review timed out twice") {
    return "review timed out twice";
  }
  if (found.reason === "review did not finish") {
    return `review did not finish${found.detail === undefined ? "" : ` (${found.detail})`}`;
  }
  if (found.reason === "review failed twice in a row") {
    return `The review failed twice in a row.${
      finding === undefined ? "" : ` Highest finding: ${findingSentence(finding)}.`
    }`;
  }
  if (found.reason === "review findings" || found.reason === "rework limit") {
    const source = attempt?.rework?.source;
    if (source === "review" || (source === undefined && attempt?.review !== undefined)) {
      return finding === undefined
        ? "The review failed."
        : `The review failed: ${findingSentence(finding)}.`;
    }
    const command = attempt?.verify?.command;
    return typeof command !== "string" || command.length === 0
      ? `The check failed${attempt?.verify?.message === undefined ? "." : `: ${attempt.verify.message}.`}`
      : `The check failed: \`${command}\`.`;
  }
  if (found.reason === "gate failed") {
    const command = attempt?.verify?.command;
    return typeof command !== "string" || command.length === 0
      ? `The check failed${attempt?.verify?.message === undefined ? "." : `: ${attempt.verify.message}.`}`
      : `The check failed: \`${command}\`.`;
  }
  if (found.reason === "merge refused") {
    return `The merge failed${found.detail === undefined ? "" : `: ${found.detail}`}.`;
  }
  if (found.reason === "no verified commit") {
    return "The task has no verified commit to merge.";
  }
  if (found.reason === "dependency cancelled") {
    return "A task this one waits for was cancelled.";
  }
  if (found.reason.startsWith("run stopped during ")) {
    return `The run stopped during ${found.reason.slice("run stopped during ".length)}.`;
  }
  return `${found.reason.charAt(0).toUpperCase()}${found.reason.slice(1)}.`;
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
  const edge = edgeParamsOf(stepParams);
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
  // The wait this step leads to is a person's: the phase and the wait say so.
  // An older review wait's kind is replaced even when the phase is already
  // waiting, so a later wait for a person takes every action it offers. A
  // failed write leaves the scheduler to repair the phase on its next tick.
  if (
    context.task.phase === "running" ||
    context.task.phase === "review" ||
    context.task.waitKind !== "person"
  ) {
    try {
      await saveTaskGuarded(
        ctx,
        context.taskKey,
        { ...context.task, phase: "waiting", waitKind: "person" },
        "dev:announce-waiting",
      );
    } catch (error) {
      await ctx.logger.write(`could not mark the task waiting: ${messageOf(error)}`);
    }
  }
  // The wait that follows asks the person. It carries this task's own reason
  // and choice information; asking with no grace hands the question over to
  // the wait step at once, keeping one item and one wait id.
  const choices = edge.choices;
  if (choices !== undefined && choices.length > 0) {
    const actions = choices.filter((choice): choice is WaitAction =>
      (WAIT_ACTIONS as readonly string[]).includes(choice),
    );
    await ctx.ask({
      prompt: waitingPrompt(
        found,
        context.task,
        context.settings.reviewer.fixLevel,
      ),
      choices,
      choiceInfo: waitChoiceInfo(
        actions,
        found.reason === "ready to merge",
      ),
      graceSecs: 0,
      onTimeout: "waiting",
      resume: null,
    });
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
