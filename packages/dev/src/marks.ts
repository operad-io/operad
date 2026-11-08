/**
 * The mark and badge a dev row carries (presentation decision 10). The marks
 * are read from the same task and plan data the views read: the phase, what
 * the attempt has recorded so far, and the holds the scheduler keeps.
 */

import type { RowMark } from "@operad-io/engine";
import {
  planState,
  type PlanData,
  type PlanState,
  type TaskData,
  type TaskPhase,
} from "./model.ts";

/** A review that passed, as the scheduler's auto merge reads it. */
function reviewPassed(task: TaskData): boolean {
  const review = task.attempt?.review;
  return (
    review?.decision === "passed" ||
    review?.result === "pass" ||
    review?.result === "passed"
  );
}

/** A task that waits: for a merge, a rework answer, or something else. */
function waitingMark(task: TaskData): RowMark {
  const attempt = task.attempt;
  const integration = attempt?.integration;
  if (integration !== undefined && integration !== null) return "waiting";
  const rework = attempt?.rework;
  if (rework?.result === "ask") {
    // The first automatic pass is `streak` 1; a limit of 0 asks at once and a
    // higher limit asks only after the passes ran out, which is giving up.
    return rework.streak > 1 ? "failed" : "rework_pending";
  }
  return reviewPassed(task) ? "ready_to_merge" : "waiting";
}

/** A task that runs: the step is told by what the attempt has recorded. */
function runningMark(task: TaskData): RowMark {
  const attempt = task.attempt;
  if (attempt?.integration !== undefined && attempt.integration !== null) {
    return "integrating";
  }
  if (typeof attempt?.workRetryAt === "number") return "retry_wait";
  if (attempt === undefined || typeof attempt.worktree !== "string") {
    return "starting";
  }
  return attempt.worked === true ? "checking" : "running";
}

/** A task in review: the gate and the review model check it. */
function reviewMark(task: TaskData): RowMark {
  return typeof task.retryAt === "number" ? "retry_wait" : "checking";
}

const TASK_MARKS: Readonly<Record<TaskPhase, (task: TaskData) => RowMark>> = {
  proposed: () => "proposed",
  ready: (task) =>
    task.dependencyHeld === true || task.areaHeldBy !== undefined
      ? "blocked"
      : "todo",
  running: runningMark,
  review: reviewMark,
  waiting: waitingMark,
  merged: () => "done",
  cancelled: () => "cancelled",
};

/** The mark of a task row. */
export function taskMark(task: TaskData): RowMark {
  return TASK_MARKS[task.phase](task);
}

/** `#<attempt>` as history counts it; `#0` before the first. */
export function taskBadge(task: TaskData): string {
  return `#${Math.max(task.attempts, task.attempt?.number ?? 0)}`;
}

const PLAN_MARKS: Readonly<Record<PlanState, (plan: PlanData) => RowMark>> = {
  draft: () => "proposed",
  confirmed: (plan) => ((plan.activeCount ?? 0) > 0 ? "running" : "todo"),
  cancelled: () => "cancelled",
  finished: () => "done",
};

/** The mark of a plan row. */
export function planMark(plan: PlanData): RowMark {
  return PLAN_MARKS[planState(plan)](plan);
}
