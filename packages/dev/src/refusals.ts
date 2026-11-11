/**
 * What an action says when it cannot run, or has nothing to do.
 *
 * One table per object kind maps (action, state) to a line. The states are the
 * words a row already shows (a task's `state`, a plan's `state`) plus the
 * waiting reason a person can see next to the row. A new action or a new
 * state does not compile until its line is here, and a test walks the tables.
 *
 * A line is one of:
 * - `ok`: the action works in this state (optionally with a line for a value
 *   that is already set);
 * - `done`: the result is already true, so the action succeeds with the line
 *   and does nothing;
 * - `refuse`: the action cannot run now; the line says where the object is and
 *   when the action becomes possible.
 */

import {
  planState,
  TASK_PHASES,
  type PlanData,
  type PlanState,
  type TaskData,
} from "./model.ts";
import {
  flowHasReverify,
  inReviewWait,
  waitChoices,
  waitKindOf,
  type WaitAction,
} from "./waits.ts";

export { inReviewWait } from "./waits.ts";

/** What a line may mention besides the object's own id. */
export interface Facts {
  /** The object's id as a person types it. */
  readonly id: string;
  /** A task's plan, when it could be read. */
  readonly plan?: { readonly id: string; readonly state: PlanState } | undefined;
  /** The `level` or `count` argument of a set-a-value action. */
  readonly value?: string | number | undefined;
}

export type Line =
  | { readonly kind: "ok"; readonly same?: (facts: Facts) => string }
  | { readonly kind: "done"; readonly say: (facts: Facts) => string }
  | { readonly kind: "refuse"; readonly say: (facts: Facts) => string };

/** The states of a task: its phases, and the wait for the review model. */
export const TASK_STATES = [...TASK_PHASES, "waiting-review"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_ACTIONS = [
  "confirm",
  "cancel",
  "pause",
  "resume",
  "merge",
  "reject",
  "rework",
  "reverify",
] as const;
export type TaskActionName = (typeof TASK_ACTIONS)[number];

export const PLAN_ACTIONS = [
  "confirm",
  "cancel",
  "auto",
  "priority",
  "concurrency",
] as const;
export type PlanActionName = (typeof PLAN_ACTIONS)[number];

const ok: Line = { kind: "ok" };
const okSame = (same: (facts: Facts) => string): Line => ({ kind: "ok", same });
const done = (say: (facts: Facts) => string): Line => ({ kind: "done", say });
const refuse = (say: (facts: Facts) => string): Line => ({ kind: "refuse", say });

/** The lines of an action that answers the wait for a person. */
function personWait(
  action: string,
  participle: string,
  settled: boolean,
): Record<TaskState, Line> {
  const once = (where: string) =>
    refuse(({ id }) => `${id} is ${where}; dev:${action} works once it waits for you`);
  return {
    proposed: refuse(
      ({ id }) => `${id} is proposed; dev:${action} works once it has run and waits for you`,
    ),
    ready: refuse(
      ({ id }) => `${id} is ready; dev:${action} works once it has run and waits for you`,
    ),
    running: once("running"),
    review: once("running (review)"),
    waiting: ok,
    "waiting-review": refuse(
      ({ id }) =>
        `${id} is waiting for the review model to come back; dev:${action} works once it needs you`,
    ),
    paused: once("paused"),
    merged: settled
      ? done(({ id }) => `${id} is already merged; nothing to do`)
      : refuse(({ id }) => `${id} was merged; nothing can be ${participle}`),
    cancelled: refuse(({ id }) => `${id} was cancelled; nothing can be ${participle}`),
  };
}

const started = (where: string) =>
  refuse(({ id }) => `${id} is ${where}; nothing to confirm`);

/** `resume` works on a paused task only; anywhere else it says where the task is. */
function resumeLines(): Record<TaskState, Line> {
  const not = (where: string) =>
    refuse(({ id }) => `${id} is ${where}; dev:resume works on a paused task`);
  return {
    proposed: not("proposed"),
    ready: done(({ id }) => `${id} is already ready; nothing to do`),
    running: not("running"),
    review: not("running (review)"),
    waiting: not("waiting"),
    "waiting-review": not("waiting"),
    paused: ok,
    merged: refuse(({ id }) => `${id} was merged; nothing can be resumed`),
    cancelled: refuse(({ id }) => `${id} was cancelled; nothing can be resumed`),
  };
}

export const TASK_LINES: Record<TaskActionName, Record<TaskState, Line>> = {
  confirm: {
    proposed: refuse(({ id, plan }) => {
      if (plan === undefined) return `${id} is proposed; its plan cannot be found`;
      const at = `${id} is in ${plan.state} plan ${plan.id}`;
      switch (plan.state) {
        case "draft":
          return `${at}; confirm the plan first (dev:confirm ${plan.id})`;
        case "paused":
          return `${at}; dev:confirm works once the plan is confirmed`;
        default:
          return `${at}; nothing can be confirmed`;
      }
    }),
    ready: done(({ id }) => `${id} is already ready; nothing to do`),
    running: started("running"),
    review: started("running (review)"),
    waiting: started("waiting"),
    "waiting-review": started("waiting"),
    paused: started("paused"),
    merged: refuse(({ id }) => `${id} was merged; nothing to confirm`),
    cancelled: refuse(({ id }) => `${id} was cancelled; nothing can be confirmed`),
  },
  cancel: {
    proposed: ok,
    ready: ok,
    running: ok,
    review: ok,
    waiting: ok,
    "waiting-review": ok,
    paused: ok,
    merged: refuse(({ id }) => `${id} was merged; nothing can be cancelled`),
    cancelled: done(({ id }) => `${id} is already cancelled; nothing to do`),
  },
  pause: {
    proposed: refuse(({ id }) => `${id} is proposed; dev:pause works once it is ready or running`),
    ready: ok,
    running: ok,
    review: ok,
    waiting: refuse(
      ({ id }) => `${id} is waiting for you; answer it, or dev:cancel it`,
    ),
    "waiting-review": refuse(
      ({ id }) => `${id} is waiting for the review model to come back; dev:pause works once it is ready or running`,
    ),
    paused: done(({ id }) => `${id} is already paused; nothing to do`),
    merged: refuse(({ id }) => `${id} was merged; nothing can be paused`),
    cancelled: refuse(({ id }) => `${id} was cancelled; nothing can be paused`),
  },
  resume: resumeLines(),
  merge: personWait("merge", "merged", true),
  reject: personWait("reject", "rejected", false),
  rework: personWait("rework", "reworked", false),
  reverify: personWait("reverify", "reverified", false),
};

const planClosed = (id: string) => `${id} was cancelled; nothing can be changed`;
const planFinished = (id: string) => `${id} is finished; nothing can be changed`;

/** The lines of an action that sets one value of a plan. */
function setting(
  what: string,
  finishedRefuses: boolean,
): Record<PlanState, Line> {
  const same = okSame(({ id, value }) => `${id} already has ${what} ${value}; nothing to do`);
  return {
    draft: same,
    confirmed: same,
    paused: same,
    finished: finishedRefuses ? refuse(({ id }) => planFinished(id)) : same,
    cancelled: refuse(({ id }) => planClosed(id)),
  };
}

export const PLAN_LINES: Record<PlanActionName, Record<PlanState, Line>> = {
  confirm: {
    draft: ok,
    confirmed: done(({ id }) => `${id} is already confirmed; nothing to do`),
    paused: refuse(({ id }) => `${id} is paused; only a draft can be confirmed`),
    finished: refuse(({ id }) => `${id} is finished; nothing can be confirmed`),
    cancelled: refuse(({ id }) => `${id} was cancelled; nothing can be confirmed`),
  },
  cancel: {
    draft: ok,
    confirmed: ok,
    paused: ok,
    finished: ok,
    cancelled: done(({ id }) => `${id} is already cancelled; nothing to do`),
  },
  auto: setting("auto", false),
  priority: setting("priority", false),
  concurrency: setting("concurrency", true),
};

/** The state a task row shows, with the review-model wait told apart. */
export function taskStateOf(task: TaskData): TaskState {
  if (task.phase === "waiting" && inReviewWait(task)) return "waiting-review";
  return task.phase;
}

/** A task a person has to act on: proposed, or stopped and asking (not a review model's wait). */
export function needsPerson(task: TaskData): boolean {
  return task.phase === "proposed" || (task.phase === "waiting" && !inReviewWait(task));
}

/** What a line says for a value that is set again, or `undefined`. */
export interface Said {
  readonly kind: "done" | "refuse";
  readonly text: string;
}

function sayLine(line: Line, facts: Facts, sameValue: boolean): Said | undefined {
  if (line.kind === "ok") {
    return sameValue && line.same !== undefined
      ? { kind: "done", text: line.same(facts) }
      : undefined;
  }
  return { kind: line.kind, text: line.say(facts) };
}

function isWaitAction(action: TaskActionName): action is WaitAction {
  return (
    action === "merge" ||
    action === "reject" ||
    action === "rework" ||
    action === "reverify"
  );
}

/** What a wait action can do, and what it does, in the wait's own words. */
const WAIT_WORDS: Readonly<
  Record<WaitAction, { readonly cannot: string; readonly can: string }>
> = {
  merge: { cannot: "cannot be merged", can: "merged" },
  reject: { cannot: "cannot be rejected", can: "rejected" },
  rework: { cannot: "cannot be reworked", can: "reworked" },
  reverify: { cannot: "cannot be verified again", can: "verified again" },
};

/** A list as a person says it: `a`, `a or b`, `a, b or c`. */
function orList(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

/** The line an action gets when the task's wait does not take it. */
function waitLine(
  action: WaitAction,
  task: TaskData,
  id: string,
): Said | undefined {
  const wait = waitKindOf(task);
  if (wait === undefined) return undefined;
  const choices = waitChoices(wait, flowHasReverify(task));
  if (choices.includes(action)) return undefined;
  const can = choices.map((choice) => WAIT_WORDS[choice].can);
  return {
    kind: "refuse",
    text: `${id} ${WAIT_WORDS[action].cannot} now; it can be ${orList(can)}`,
  };
}

/** A task action's line for a task's state; undefined when it works. */
export function taskLine(
  action: TaskActionName,
  task: TaskData,
  facts: Facts,
): Said | undefined {
  if (isWaitAction(action)) {
    const refused = waitLine(action, task, facts.id);
    if (refused !== undefined) return refused;
  }
  return sayLine(TASK_LINES[action][taskStateOf(task)], facts, false);
}

/** A draft with no task has nothing to confirm yet. */
export const EMPTY_DRAFT: Line = refuse(
  ({ id }) => `${id} is a draft with no tasks; dev:confirm works once it has a task`,
);

/** A plan action's line for a plan's state; undefined when it works. */
export function planLine(
  action: PlanActionName,
  plan: PlanData,
  facts: Facts,
  sameValue = false,
): Said | undefined {
  const state = planState(plan);
  const line =
    action === "confirm" && state === "draft" && plan.taskCount === 0
      ? EMPTY_DRAFT
      : PLAN_LINES[action][state];
  return sayLine(line, facts, sameValue);
}
