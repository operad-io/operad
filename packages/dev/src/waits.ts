/**
 * What each of dev's person waits accepts.
 *
 * The flow's wait steps take their choices from here, and a task's actions
 * offer exactly the choices of the wait the task is in, so the two cannot
 * drift apart.
 */

import type { ChoiceInfo } from "@operad-io/engine";
import { isIntegrating, type ReviewRecord, type TaskData } from "./model.ts";

/** The actions a person wait answers. */
export const WAIT_ACTIONS = ["merge", "reject", "rework", "reverify"] as const;
export type WaitAction = (typeof WAIT_ACTIONS)[number];

/** The waits dev's flows have, and the step id the first of each is named. */
export const WAIT_STEPS = {
  person: "wait",
  "review-timeout": "wait_review_timeout",
  "review-unavailable": "wait_review_unavailable",
  "review-out-of-time": "wait_review_out_of_time",
  // A worker's own question, such as a permission ask from its harness.
  "work-question": "wait_work_question",
} as const;
export type WaitKind = keyof typeof WAIT_STEPS;

/** The answers a worker's harness may ask for when its question outlives its grace. */
export const WORK_QUESTION_CHOICES = ["allow_once", "reject_once"] as const;
export const WORK_QUESTION_LATE_CHOICES = ["allow_always"] as const;

/** True for the wait a worker's own question goes to (one per code stage). */
export function isWorkQuestionWait(id: string): boolean {
  const base = WAIT_STEPS["work-question"];
  return id === base || id.startsWith(`${base}_`);
}

const WAIT_ACCEPTS: Readonly<Record<WaitKind, readonly WaitAction[]>> = {
  person: WAIT_ACTIONS,
  // A timed-out or out-of-time review is the reviewer's business: a person can
  // land it or send it back to the worker, not spend another round on it.
  "review-timeout": ["merge", "reject", "rework"],
  "review-out-of-time": ["merge", "reject", "rework"],
  // The reviewer may be back: the same commit can be checked again.
  "review-unavailable": ["merge", "reject", "rework", "reverify"],
  // The worker's own question is not one of dev's task actions.
  "work-question": [],
};

/** The choices of a wait; a flow with no check or review has nothing to reverify. */
export function waitChoices(
  wait: WaitKind,
  hasReverify: boolean,
): readonly WaitAction[] {
  const accepts = WAIT_ACCEPTS[wait];
  return hasReverify ? accepts : accepts.filter((action) => action !== "reverify");
}

/** What each task wait choice is, apart from whether merge is the recommended one. */
const WAIT_CHOICE_INFO: Readonly<Record<WaitAction, ChoiceInfo>> = {
  merge: {
    label: "Merge",
    hint: "Merge the task's changes into main.",
  },
  rework: {
    label: "Rework",
    hint: "Send the task back to the agent with your note.",
    // dev:rework refuses an empty note, so a client must ask for one.
    note: "required",
  },
  reverify: {
    label: "Check again",
    hint: "Run the checks and the review again.",
  },
  reject: {
    label: "Reject",
    hint: "Discard the task's changes.",
    role: "destructive",
  },
};

/**
 * What the offered choices say. `primary` marks merge as the recommended answer;
 * a wait after a failed check, failed work or no change leaves it out.
 */
export function waitChoiceInfo(
  choices: readonly string[],
  primary: boolean,
): Readonly<Record<string, ChoiceInfo>> {
  const info: Record<string, ChoiceInfo> = {};
  for (const choice of choices) {
    if (!(WAIT_ACTIONS as readonly string[]).includes(choice)) continue;
    const action = choice as WaitAction;
    const copy = WAIT_CHOICE_INFO[action];
    info[choice] =
      action === "merge" && primary
        ? { ...copy, role: "primary" }
        : copy;
  }
  return info;
}

/**
 * True while a review waits for its model to come back. The flow is not asking
 * a person anything then, so no wait action is offered.
 */
export function inReviewWait(task: TaskData): boolean {
  const review = task.attempt?.review;
  return (
    typeof task.retryAt === "number" &&
    review !== undefined &&
    review !== null &&
    review.decision === "unavailable" &&
    review.reason !== "exhausted" &&
    review.reason !== "out_of_time"
  );
}

/** The wait a finished review leaves, when it leaves the task waiting for a person. */
export function reviewWaitKind(review: ReviewRecord): WaitKind | undefined {
  if (review.reason === "timed_out") return "review-timeout";
  if (review.reason === "exhausted") return "review-unavailable";
  if (review.reason === "out_of_time") return "review-out-of-time";
  if (review.decision === "findings" || review.result === "fail") return undefined;
  if (review.decision === "unavailable" && typeof review.retryAt === "number") {
    return undefined;
  }
  return "person";
}

/** The wait a task is in, or undefined when it is not waiting for a person. */
export function waitKindOf(task: TaskData): WaitKind | undefined {
  // While integrate works the task is not asking a person anything.
  if (task.phase !== "waiting" || isIntegrating(task) || inReviewWait(task)) {
    return undefined;
  }
  if (task.waitKind !== undefined) return task.waitKind;
  // A task from before the kind was written: the review record is the best it
  // has, though a later ordinary wait may still carry that older record. An
  // integrate result means the review wait is behind the task.
  const attempt = task.attempt;
  if (attempt?.integration !== undefined && attempt.integration !== null) {
    return "person";
  }
  const reason = attempt?.review?.reason;
  if (reason === "timed_out") return "review-timeout";
  if (reason === "exhausted") return "review-unavailable";
  if (reason === "out_of_time") return "review-out-of-time";
  return "person";
}

/** True when the task's flow runs the reverify step, so its waits can take it. */
export function flowHasReverify(task: TaskData): boolean {
  const graph = task.flowGraph;
  // A task from before flows had graphs ran the built-in flow, which has one.
  if (graph === undefined) return true;
  return graph.steps.some((step) => step.id === "reverify");
}

/** True when the task's current wait takes this action. */
export function waitAccepts(task: TaskData, action: WaitAction): boolean {
  const wait = waitKindOf(task);
  if (wait === undefined) return false;
  return waitChoices(wait, flowHasReverify(task)).includes(action);
}
