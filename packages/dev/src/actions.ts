/** The actions the owner runs on a plan or a task. */

import type {
  ActionEnv,
  ActionTypeDefinition,
  ObjectStore,
  StoredObject,
} from "@operad-io/engine";
import {
  appendChange,
  appendRework,
  bareId,
  DevError,
  DevRefusal,
  planData,
  planState,
  PRIORITIES,
  storeKey,
  taskData,
  type PlanData,
  type TaskData,
} from "./model.ts";
import {
  inReviewWait,
  planLine,
  taskLine,
  type Facts,
  type PlanActionName,
  type TaskActionName,
} from "./refusals.ts";
import {
  cancelPlan,
  cancelTask,
  pauseTask,
  resumeTask,
  claimWaitingTask,
  confirmPlan,
  confirmTask,
  getPlan,
  getTask,
  releaseWaitingClaim,
  setAuto,
  setConcurrency,
  validatePlanConcurrency,
  setPriority,
  MAX_PLAN_CONCURRENCY,
  MIN_PLAN_CONCURRENCY,
} from "./service.ts";

const AUTO_LEVELS = ["off", "run", "merge"] as const;

/** The plan of a task, as the lines name it; undefined when it is gone. */
async function planOfTask(
  store: ObjectStore,
  task: TaskData,
): Promise<Facts["plan"]> {
  const object = await store.get("plan", storeKey(task.repository, task.plan));
  if (object === undefined) return undefined;
  return { id: task.plan, state: planState(planData(object.data)) };
}

/** What a task action's line needs to know about the task. */
async function taskFacts(store: ObjectStore, object: StoredObject): Promise<Facts> {
  const task = taskData(object.data);
  const id = bareId(object.id);
  return task.phase === "proposed"
    ? { id, plan: await planOfTask(store, task) }
    : { id };
}

/**
 * The line a task action refuses with now, or undefined when it can run. A
 * proposed task is confirmed only inside a confirmed plan.
 */
export async function taskRefusal(
  action: TaskActionName,
  store: ObjectStore,
  object: StoredObject,
): Promise<string | undefined> {
  const task = taskData(object.data);
  const facts = await taskFacts(store, object);
  if (action === "confirm" && task.phase === "proposed" && facts.plan?.state === "confirmed") {
    return undefined;
  }
  const said = taskLine(action, task, facts);
  return said?.kind === "refuse" ? said.text : undefined;
}

/** The line a plan action refuses with now, or undefined when it can run. */
export function planRefusal(
  action: PlanActionName,
  object: StoredObject,
): string | undefined {
  const said = planLine(action, planData(object.data), { id: bareId(object.id) });
  return said?.kind === "refuse" ? said.text : undefined;
}

/** Whether a set-a-value action gets the value the plan already has. */
function sameValue(action: PlanActionName, plan: PlanData, args: unknown): string | number | undefined {
  const given =
    typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  if (action === "auto" && given.level === plan.auto) return plan.auto;
  if (action === "priority" && given.level === plan.priority) return plan.priority;
  if (action === "concurrency" && given.count === plan.concurrency) return plan.concurrency;
  return undefined;
}

const taskWhy = (action: TaskActionName) =>
  (object: StoredObject, env: ActionEnv) => taskRefusal(action, env.store, object);

const planWhy = (action: PlanActionName) =>
  (object: StoredObject): string | undefined => planRefusal(action, object);

/** The line for a task action whose result is already true. */
const taskSettled = (action: TaskActionName) =>
  (object: StoredObject): string | undefined => {
    const said = taskLine(action, taskData(object.data), { id: bareId(object.id) });
    return said?.kind === "done" ? said.text : undefined;
  };

/** The line for a plan action whose result is already true or already set. */
const planSettled = (action: PlanActionName) =>
  (object: StoredObject, args: unknown): string | undefined => {
    const plan = planData(object.data);
    const value = sameValue(action, plan, args);
    const said = planLine(action, plan, { id: bareId(object.id), value }, value !== undefined);
    return said?.kind === "done" ? said.text : undefined;
  };

/** A task that waits for a person, as opposed to for a review model. */
function waitsForPerson(state: Parameters<typeof taskData>[0]): boolean {
  const task = taskData(state);
  return task.phase === "waiting" && !inReviewWait(task);
}

/**
 * True when a person can merge the task as it stands: its head is verified and
 * the wait is not the question of a rework that the automatic limit ended in.
 */
function readyToMerge(state: Parameters<typeof taskData>[0]): boolean {
  const task = taskData(state);
  const verified = task.attempt?.verified;
  return (
    typeof verified === "string" &&
    verified.length > 0 &&
    task.attempt?.rework?.result !== "ask"
  );
}

/**
 * The order of a task's actions: what a person most likely wants next first,
 * what ends the task last. Lower comes first; `merge` and `rework` swap places
 * by what the wait asks.
 */
export const TASK_RANKS: Record<TaskActionName, (state: Parameters<typeof taskData>[0]) => number> = {
  confirm: () => 0,
  resume: () => 1,
  merge: (state) => (readyToMerge(state) ? 1 : 4),
  rework: (state) => (readyToMerge(state) ? 4 : 1),
  reverify: () => 5,
  reject: () => 6,
  pause: () => 7,
  cancel: () => 9,
};

/**
 * The order of a plan's actions. With auto off the next step is to turn it on;
 * with auto on it is the priority, since the level is already chosen.
 */
export const PLAN_RANKS: Record<PlanActionName, (state: Parameters<typeof planData>[0]) => number> = {
  confirm: () => 0,
  auto: (state) => (planData(state).auto === "off" ? 1 : 2),
  priority: (state) => (planData(state).auto === "off" ? 2 : 1),
  concurrency: () => 3,
  cancel: () => 9,
};

/** Reads a required enum argument; the kernel checks it first, this is for types. */
function enumArgument<T extends string>(
  args: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof args !== "object" || args === null) {
    throw new DevError(field, `must be one of ${allowed.join(", ")}`);
  }
  const raw = (args as Record<string, unknown>)[field];
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
    throw new DevError(field, `must be one of ${allowed.join(", ")}`);
  }
  return raw as T;
}

/**
 * The merge, reject, rework and reverify actions answer the task's wait, so they
 * refuse unless the task waits for a person; the line is the table's.
 */
async function waitingTask(
  store: Parameters<typeof getTask>[0],
  id: string,
  action: TaskActionName,
) {
  const object = await getTask(store, id);
  const line = await taskRefusal(action, store, object);
  if (line !== undefined) throw new DevRefusal(line);
  return object;
}

function noteArgument(args: unknown): string {
  if (
    typeof args !== "object" ||
    args === null ||
    typeof (args as { note?: unknown }).note !== "string"
  ) {
    throw new DevError("note", "needs a note");
  }
  const note = (args as { note: string }).note.trim();
  if (note.length === 0) {
    throw new DevError("note", "must be a non-empty string");
  }
  return note;
}

type Answer = NonNullable<Parameters<ActionTypeDefinition["run"]>[0]["answer"]>;

/**
 * Answers the task's wait after claiming the task's next transition at the
 * version the action saw. The claim goes first so that a concurrent action on
 * the same version loses before it records anything; an answer that then fails
 * gives the claim back.
 */
async function claimAndAnswer(
  ctx: {
    readonly store: Parameters<typeof getTask>[0];
    readonly object: { readonly id: string; readonly version?: number | undefined };
    readonly answer?: Answer | undefined;
  },
  action: TaskActionName,
  choice: string,
  change: (latest: TaskData) => TaskData,
  note?: string,
): Promise<string | undefined> {
  const object = await waitingTask(ctx.store, ctx.object.id, action);
  // Claim at the version the action was offered on, not one read here: an
  // action that starts after a competing one wrote must still lose.
  const seen = ctx.object.version ?? object.version;
  if (ctx.answer === undefined) {
    throw new DevRefusal(`${bareId(ctx.object.id)} is not waiting for an answer now`);
  }
  const claim = await claimWaitingTask(
    ctx.store,
    ctx.object.id,
    seen,
    action,
    change,
  );
  // Another action already made the result true: succeed with its line.
  if (claim.settled !== undefined) return claim.settled;
  const { claimed, before } = claim;
  try {
    await ctx.answer(choice, note);
  } catch (error) {
    await releaseWaitingClaim(ctx.store, ctx.object.id, claimed, before);
    throw error;
  }
  return undefined;
}

const mergeTask: ActionTypeDefinition = {
  name: "merge",
  on: "task",
  rank: TASK_RANKS.merge,
  confirm: true,
  when(state) {
    return waitsForPerson(state);
  },
  why: taskWhy("merge"),
  settled: taskSettled("merge"),
  async run(ctx) {
    return claimAndAnswer(ctx, "merge", "merge", (latest) => {
      const verified = latest.attempt?.verified;
      if (typeof verified !== "string" || verified.length === 0) {
        // The merge step would refuse later, in the background; say so now.
        throw new DevError(
          "merge",
          `${bareId(ctx.object.id)} has no verified commit; run operad dev:reverify ${bareId(ctx.object.id)} first`,
        );
      }
      return { ...latest, brief: appendChange(latest.brief, "merge requested") };
    });
  },
};

const NOTE_ARGS = (description: string) =>
  ({
    type: "object",
    properties: { note: { type: "string", role: "note", description } },
    required: ["note"],
    additionalProperties: false,
  }) as const;

const rejectTaskAction: ActionTypeDefinition = {
  name: "reject",
  on: "task",
  rank: TASK_RANKS.reject,
  args: NOTE_ARGS("What the worker should change before the next review."),
  when(state) {
    return waitsForPerson(state);
  },
  why: taskWhy("reject"),
  settled: taskSettled("reject"),
  async run(ctx, args) {
    const note = noteArgument(args);
    return claimAndAnswer(
      ctx,
      "reject",
      "reject",
      (latest) => ({
        ...latest,
        brief: appendRework(latest.brief, "owner", note),
        reviewFailed: undefined,
      }),
      note,
    );
  },
};

/**
 * The lead's own rework: it goes into the brief as `## Rework <n> (lead)`, the
 * worker runs again, and the count of automatic reworks in a row starts over.
 */
const reworkTaskAction: ActionTypeDefinition = {
  name: "rework",
  on: "task",
  rank: TASK_RANKS.rework,
  args: NOTE_ARGS("What the worker should do in this rework."),
  when(state) {
    return waitsForPerson(state);
  },
  why: taskWhy("rework"),
  settled: taskSettled("rework"),
  async run(ctx, args) {
    const note = noteArgument(args);
    return claimAndAnswer(
      ctx,
      "rework",
      "rework",
      (latest) => ({
        ...appendRework(latest, "lead", note),
        phase: "running",
        reworkStreak: 0,
        reviewFailed: undefined,
      }),
      note,
    );
  },
};

/** Runs verify and review again on the task's current head, with no worker. */
const reverifyTaskAction: ActionTypeDefinition = {
  name: "reverify",
  on: "task",
  rank: TASK_RANKS.reverify,
  when(state) {
    return waitsForPerson(state);
  },
  why: taskWhy("reverify"),
  settled: taskSettled("reverify"),
  async run(ctx) {
    return claimAndAnswer(ctx, "reverify", "reverify", (latest) => {
      if (latest.attempt === undefined) {
        throw new DevError(
          "reverify",
          "the task has no work to verify yet; rework it instead",
        );
      }
      return {
        ...latest,
        phase: "running",
        brief: appendChange(latest.brief, "reverify"),
        // A fresh gate result: the verify step replays a result its own run
        // recorded, so the old ones must go before the step enters again.
        attempt: {
          ...latest.attempt,
          verified: null,
          verify: null,
          review: null,
          reviews: 0,
          // Round 1 starts again: the old round's runs and pending run must
          // not be read back as this round's.
          reviewRuns: [],
          reviewPending: null,
          rework: null,
          integration: null,
        },
      };
    });
  },
};

export const actions: readonly ActionTypeDefinition[] = [
  {
    name: "confirm",
    on: "plan",
    rank: PLAN_RANKS.confirm,
    when(state) {
      const plan = planData(state);
      return plan.status === "draft" && plan.taskCount > 0;
    },
    why: planWhy("confirm"),
    settled: planSettled("confirm"),
    async run(ctx) {
      await confirmPlan(ctx.store, ctx.object.id);
    },
  },
  {
    name: "confirm",
    on: "task",
    rank: TASK_RANKS.confirm,
    async when(state, env) {
      const task = taskData(state);
      if (task.phase !== "proposed") return false;
      // Only a confirmed plan takes a proposed task into work; a draft plan is
      // confirmed as a whole.
      return (await planOfTask(env.store, task))?.state === "confirmed";
    },
    why: taskWhy("confirm"),
    settled: taskSettled("confirm"),
    async run(ctx) {
      await confirmTask(ctx.store, ctx.object.id);
    },
  },
  {
    name: "cancel",
    on: "plan",
    rank: PLAN_RANKS.cancel,
    confirm: true,
    when(state) {
      return planData(state).status !== "cancelled";
    },
    why: planWhy("cancel"),
    settled: planSettled("cancel"),
    async run(ctx) {
      await cancelPlan(ctx.store, ctx.object.id, { runs: ctx.runs });
    },
  },
  {
    name: "cancel",
    on: "task",
    rank: TASK_RANKS.cancel,
    confirm: true,
    when(state) {
      const phase = taskData(state).phase;
      return phase !== "merged" && phase !== "cancelled";
    },
    why: taskWhy("cancel"),
    settled: taskSettled("cancel"),
    async run(ctx) {
      await cancelTask(ctx.store, ctx.object.id, { runs: ctx.runs });
    },
  },
  {
    name: "pause",
    on: "task",
    rank: TASK_RANKS.pause,
    confirm: true,
    when(state) {
      const phase = taskData(state).phase;
      return phase === "ready" || phase === "running" || phase === "review";
    },
    why: taskWhy("pause"),
    settled: taskSettled("pause"),
    async run(ctx) {
      await pauseTask(ctx.store, ctx.object.id, { runs: ctx.runs });
    },
  },
  {
    name: "resume",
    on: "task",
    rank: TASK_RANKS.resume,
    confirm: true,
    when(state) {
      return taskData(state).phase === "paused";
    },
    why: taskWhy("resume"),
    settled: taskSettled("resume"),
    async run(ctx) {
      await resumeTask(ctx.store, ctx.object.id);
    },
  },
  {
    name: "auto",
    on: "plan",
    rank: PLAN_RANKS.auto,
    args: {
      type: "object",
      properties: {
        level: {
          type: "string",
          enum: [...AUTO_LEVELS],
          description: "How far the plan may run without a person.",
        },
      },
      required: ["level"],
      additionalProperties: false,
    },
    when(state) {
      return planData(state).status !== "cancelled";
    },
    why: planWhy("auto"),
    settled: planSettled("auto"),
    async run(ctx, args) {
      const level = enumArgument(args, "level", AUTO_LEVELS);
      await setAuto(ctx.store, ctx.object.id, level);
    },
  },
  mergeTask,
  rejectTaskAction,
  reworkTaskAction,
  reverifyTaskAction,
  {
    name: "priority",
    on: "plan",
    rank: PLAN_RANKS.priority,
    args: {
      type: "object",
      properties: {
        level: {
          type: "string",
          enum: [...PRIORITIES],
          description: "The plan's priority, P0 (most urgent) to P5.",
        },
      },
      required: ["level"],
      additionalProperties: false,
    },
    when(state) {
      return planData(state).status !== "cancelled";
    },
    why: planWhy("priority"),
    settled: planSettled("priority"),
    async run(ctx, args) {
      const level = enumArgument(args, "level", PRIORITIES);
      await setPriority(ctx.store, ctx.object.id, level);
      const id = bareId(ctx.object.id);
      if (planData((await getPlan(ctx.store, ctx.object.id)).data).auto === "off") {
        return `${id} has auto off: the scheduler does not start its tasks; run operad dev:auto ${id} --level merge`;
      }
      return undefined;
    },
  },
  {
    name: "concurrency",
    on: "plan",
    rank: PLAN_RANKS.concurrency,
    args: {
      type: "object",
      properties: {
        count: {
          type: "integer",
          minimum: MIN_PLAN_CONCURRENCY,
          maximum: MAX_PLAN_CONCURRENCY,
          description: `How many of the plan's tasks may run at once, from ${MIN_PLAN_CONCURRENCY} to ${MAX_PLAN_CONCURRENCY} (a fixed upper bound). Takes effect at the next scheduler tick; running tasks are not stopped.`,
        },
      },
      required: ["count"],
      additionalProperties: false,
    },
    when(state) {
      const plan = planData(state);
      return plan.status !== "cancelled" && planState(plan) !== "finished";
    },
    why: planWhy("concurrency"),
    settled: planSettled("concurrency"),
    async run(ctx, args) {
      const count =
        typeof args === "object" && args !== null
          ? (args as Record<string, unknown>).count
          : undefined;
      await setConcurrency(ctx.store, ctx.object.id, validatePlanConcurrency(count));
    },
  },
];

