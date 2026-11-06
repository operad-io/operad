/** The actions the owner runs on a plan or a task. */

import type { ActionTypeDefinition } from "@operad-io/engine";
import {
  bareId,
  DevError,
  planData,
  PRIORITIES,
  taskData,
} from "./model.ts";
import {
  cancelPlan,
  cancelTask,
  confirmPlan,
  confirmTask,
  getTask,
  rejectTask,
  setAuto,
  setPriority,
} from "./service.ts";

const AUTO_LEVELS = ["off", "run", "merge"] as const;

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
    throw new DevError("note", "a reject needs a note");
  }
  const note = (args as { note: string }).note.trim();
  if (note.length === 0) {
    throw new DevError("note", "must be a non-empty string");
  }
  return note;
}

const mergeTask: ActionTypeDefinition = {
  name: "merge",
  on: "task",
  confirm: true,
  when(state) {
    return taskData(state).phase === "waiting";
  },
  async run(ctx) {
    await waitingTask(ctx.store, ctx.object.id);
    if (ctx.answer === undefined) {
      throw new DevError(
        "wait",
        `task "${bareId(ctx.object.id)}" is not waiting for a run`,
      );
    }
    await ctx.answer("merge");
  },
};

const rejectTaskAction: ActionTypeDefinition = {
  name: "reject",
  on: "task",
  args: {
    type: "object",
    properties: {
      note: {
        type: "string",
        role: "note",
        description: "What the worker should change before the next review.",
      },
    },
    required: ["note"],
    additionalProperties: false,
  },
  when(state) {
    return taskData(state).phase === "waiting";
  },
  async run(ctx, args) {
    await waitingTask(ctx.store, ctx.object.id);
    if (ctx.answer === undefined) {
      throw new DevError(
        "wait",
        `task "${bareId(ctx.object.id)}" is not waiting for a run`,
      );
    }
    const note = noteArgument(args);
    await rejectTask(ctx.store, ctx.object.id, note);
    await ctx.answer("reject", note);
  },
};

export const actions: readonly ActionTypeDefinition[] = [
  {
    name: "confirm",
    on: "plan",
    when(state) {
      return planData(state).status === "draft";
    },
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
    async run(ctx, args) {
      const level = enumArgument(args, "level", AUTO_LEVELS);
      await setAuto(ctx.store, ctx.object.id, level);
    },
  },
  mergeTask,
  rejectTaskAction,
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
    async run(ctx, args) {
      const level = enumArgument(args, "level", PRIORITIES);
      await setPriority(ctx.store, ctx.object.id, level);
    },
  },
];

