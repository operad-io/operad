/**
 * The mark and badge a dev row carries (presentation decision 10). The marks
 * are read from the same task and plan data the views read: the phase, what
 * the attempt has recorded so far, and the holds the scheduler keeps.
 */

import type { RowMark } from "@operad-io/engine";
import {
  isIntegrating,
  planState,
  type PlanData,
  type PlanState,
  type RepositoryData,
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
  if (isIntegrating(task)) return "integrating";
  const integration = attempt?.integration;
  if (integration !== undefined && integration !== null) return "waiting";
  const rework = attempt?.rework;
  if (rework?.result === "ask") {
    // An ask is written when the streak passed the configured limit (a limit
    // of 0 included): the automatic passes ran out, which is giving up.
    return rework.limit !== undefined && rework.streak > rework.limit
      ? "failed"
      : "rework_pending";
  }
  return reviewPassed(task) ? "ready_to_merge" : "waiting";
}

/** A task that runs: the step is told by what the attempt has recorded. */
function runningMark(task: TaskData): RowMark {
  const attempt = task.attempt;
  // A conflict or failed check sent the flow back to the worktree step; the
  // record stays, but the step is no longer integrate.
  if (isIntegrating(task)) return "integrating";
  if (typeof attempt?.workRetryAt === "number") return "retry_wait";
  // The work step waits for a worker another task holds.
  if (typeof attempt?.workerWait === "string" && attempt.workerWait.length > 0) return "blocked";
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
  paused: () => "paused",
  merged: () => "done",
  cancelled: () => "cancelled",
};

/** The mark of a task row. */
export function taskMark(task: TaskData): RowMark {
  // A step that waits for a check place is not running or checking yet.
  const placeWait = task.attempt?.placeWait;
  if (
    placeWait !== undefined &&
    placeWait !== null &&
    (task.phase === "running" || task.phase === "review" || task.phase === "waiting")
  ) {
    return "blocked";
  }
  return TASK_MARKS[task.phase](task);
}

/** `#<attempt>` as history counts it; `#0` before the first. */
export function taskBadge(task: TaskData): string {
  return `#${Math.max(task.attempts, task.attempt?.number ?? 0)}`;
}

const PLAN_MARKS: Readonly<Record<PlanState, (plan: PlanData) => RowMark>> = {
  draft: () => "proposed",
  // A task waiting for a person wins over running: the owner has something to do.
  confirmed: (plan) =>
    (plan.waitingCount ?? 0) > 0
      ? "waiting"
      : (plan.activeCount ?? 0) > 0
        ? "running"
        : "todo",
  paused: () => "paused",
  cancelled: () => "cancelled",
  finished: () => "done",
};

/** The mark of a plan row. */
export function planMark(plan: PlanData): RowMark {
  return PLAN_MARKS[planState(plan)](plan);
}

/**
 * The mark of a repository row: it follows the repository's work. A removed
 * repository reads as `cancelled`.
 */
export function repositoryMark(repository: RepositoryData): RowMark {
  if (repository.removed) return "cancelled";
  if ((repository.activeTasks ?? 0) > 0) return "running";
  if ((repository.openPlans ?? 0) + (repository.openTasks ?? 0) > 0) return "todo";
  return "done";
}
