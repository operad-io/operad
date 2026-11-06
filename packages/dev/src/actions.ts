/** The actions the owner runs on a plan or a task. */

import type { ActionTypeDefinition } from "@operad-io/engine";
import {
  bareId,
  DevError,
  planData,
  priorityIndex,
  taskData,
  type AutoMode,
  type Priority,
} from "./model.ts";
import {
  cancelPlan,
  cancelTask,
  confirmPlan,
  confirmTask,
  getTask,
  lowerPriorityOf,
  raisePriority,
  rejectTask,
  setAuto,
} from "./service.ts";

function planAuto(name: string, auto: AutoMode): ActionTypeDefinition {
  return {
    name,
    on: "plan",
    when(state) {
      const plan = planData(state);
      return plan.status !== "cancelled" && plan.auto !== auto;
    },
    async run(ctx) {
      await setAuto(ctx.store, ctx.object.id, auto);
    },
  };
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
  planAuto("auto-off", "off"),
  planAuto("auto-run", "run"),
  planAuto("auto-merge", "merge"),
  mergeTask,
  rejectTaskAction,
  {
    name: "priority-up",
    on: "plan",
    when(state) {
      const plan = planData(state);
      return plan.status !== "cancelled" && priorityIndex(plan.priority) > 0;
    },
    async run(ctx) {
      await raisePriority(ctx.store, ctx.object.id);
    },
  },
  {
    name: "priority-down",
    on: "plan",
    when(state) {
      const plan = planData(state);
      const index = priorityIndex(plan.priority);
      return plan.status !== "cancelled" && index >= 0 && index < 5;
    },
    async run(ctx) {
      await lowerPriorityOf(ctx.store, ctx.object.id);
    },
  },
];

/** The priorities the actions can reach, for a caller that wants to check. */
export function nextPriority(
  priority: Priority,
  direction: "up" | "down",
): Priority | undefined {
  const index = priorityIndex(priority);
  const offset = direction === "up" ? -1 : 1;
  return ["P0", "P1", "P2", "P3", "P4", "P5"][index + offset] as
    | Priority
    | undefined;
}
