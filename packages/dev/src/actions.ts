/** The actions the owner runs on a plan or a task. */

import type { ActionTypeDefinition, StoredObject } from "@operad-io/engine";
import {
  appendChange,
  appendRework,
  bareId,
  DevError,
  planData,
  planState,
  PRIORITIES,
  taskData,
  type TaskData,
} from "./model.ts";
import {
  cancelPlan,
  cancelTask,
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

/** The line a refused action prints: where the object is and where it must be. */
function needs(
  object: StoredObject,
  current: string,
  action: string,
  wanted: string,
): string {
  return `${bareId(object.id)} is ${current}; dev:${action} needs ${wanted}`;
}

const planStateWhy = (action: string, wanted: string) =>
  (object: StoredObject): string =>
    needs(object, planState(planData(object.data)), action, wanted);

const taskPhaseWhy = (action: string, wanted: string) =>
  (object: StoredObject): string => {
    const task = taskData(object.data);
    if (wanted === "waiting" && task.phase === "waiting" && inReviewWait(task)) {
      return `${bareId(object.id)} is waiting for the review model to come back; dev:${action} works once it needs you`;
    }
    return needs(object, task.phase, action, wanted);
  };

/**
 * True while a review waits for its model to come back. The flow is not asking
 * a person anything then, so merge, reject, rework and reverify are not offered.
 */
function inReviewWait(task: TaskData): boolean {
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

/** A task that waits for a person, as opposed to for a review model. */
function waitsForPerson(state: Parameters<typeof taskData>[0]): boolean {
  const task = taskData(state);
  return task.phase === "waiting" && !inReviewWait(task);
}

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
 * The merge and reject actions answer the task's wait, so they refuse unless the
 * task is in the waiting phase that sends the flow to its person wait.
 */
async function waitingTask(store: Parameters<typeof getTask>[0], id: string) {
  const object = await getTask(store, id);
  const phase = taskData(object.data).phase;
  if (phase !== "waiting") {
    throw new DevError(
      "wait",
      `task "${bareId(id)}" is ${phase}, not waiting; only a waiting task takes merge or reject`,
    );
  }
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
  action: string,
  choice: string,
  change: (latest: TaskData) => TaskData,
  note?: string,
): Promise<void> {
  const object = await waitingTask(ctx.store, ctx.object.id);
  // Claim at the version the action was offered on, not one read here: an
  // action that starts after a competing one wrote must still lose.
  const seen = ctx.object.version ?? object.version;
  if (ctx.answer === undefined) {
    throw new DevError(
      "wait",
      `task "${bareId(ctx.object.id)}" is not waiting for a run`,
    );
  }
  const { claimed, before } = await claimWaitingTask(
    ctx.store,
    ctx.object.id,
    seen,
    action,
    change,
  );
  try {
    await ctx.answer(choice, note);
  } catch (error) {
    await releaseWaitingClaim(ctx.store, ctx.object.id, claimed, before);
    throw error;
  }
}

const mergeTask: ActionTypeDefinition = {
  name: "merge",
  on: "task",
  confirm: true,
  when(state) {
    return waitsForPerson(state);
  },
  why: taskPhaseWhy("merge", "waiting"),
  async run(ctx) {
    await claimAndAnswer(ctx, "merge", "merge", (latest) => {
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
  args: NOTE_ARGS("What the worker should change before the next review."),
  when(state) {
    return waitsForPerson(state);
  },
  why: taskPhaseWhy("reject", "waiting"),
  async run(ctx, args) {
    const note = noteArgument(args);
    await claimAndAnswer(
      ctx,
      "reject",
      "reject",
      (latest) => ({ ...latest, brief: appendRework(latest.brief, "owner", note) }),
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
  args: NOTE_ARGS("What the worker should do in this rework."),
  when(state) {
    return waitsForPerson(state);
  },
  why: taskPhaseWhy("rework", "waiting"),
  async run(ctx, args) {
    const note = noteArgument(args);
    await claimAndAnswer(
      ctx,
      "rework",
      "reject",
      (latest) => ({
        ...appendRework(latest, "lead", note),
        phase: "running",
        reworkStreak: 0,
      }),
      note,
    );
  },
};

/** Runs verify and review again on the task's current head, with no worker. */
const reverifyTaskAction: ActionTypeDefinition = {
  name: "reverify",
  on: "task",
  when(state) {
    return waitsForPerson(state);
  },
  why: taskPhaseWhy("reverify", "waiting"),
  async run(ctx) {
    await claimAndAnswer(ctx, "reverify", "reverify", (latest) => {
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
    when(state) {
      return planData(state).status === "draft";
    },
    why: planStateWhy("confirm", "draft"),
    async run(ctx) {
      await confirmPlan(ctx.store, ctx.object.id);
    },
  },
  {
    name: "confirm",
    on: "task",
    when(state) {
      return taskData(state).phase === "proposed";
    },
    why: taskPhaseWhy("confirm", "proposed"),
    async run(ctx) {
      await confirmTask(ctx.store, ctx.object.id);
    },
  },
  {
    name: "cancel",
    on: "plan",
    confirm: true,
    when(state) {
      return planData(state).status !== "cancelled";
    },
    why: planStateWhy("cancel", "a plan that is not cancelled"),
    async run(ctx) {
      await cancelPlan(ctx.store, ctx.object.id, { runs: ctx.runs });
    },
  },
  {
    name: "cancel",
    on: "task",
    confirm: true,
    when(state) {
      const phase = taskData(state).phase;
      return phase !== "merged" && phase !== "cancelled";
    },
    why: taskPhaseWhy("cancel", "a task that is not merged or cancelled"),
    async run(ctx) {
      await cancelTask(ctx.store, ctx.object.id, { runs: ctx.runs });
    },
  },
  {
    name: "auto",
    on: "plan",
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
    why: planStateWhy("auto", "a plan that is not cancelled"),
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
    why: planStateWhy("priority", "a plan that is not cancelled"),
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
      return planData(state).status !== "cancelled";
    },
    why: planStateWhy("concurrency", "a plan that is not cancelled"),
    async run(ctx, args) {
      const count =
        typeof args === "object" && args !== null
          ? (args as Record<string, unknown>).count
          : undefined;
      await setConcurrency(ctx.store, ctx.object.id, validatePlanConcurrency(count));
    },
  },
];

