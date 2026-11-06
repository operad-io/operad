/** The actions the owner runs on a plan or a task. */

import type { ActionTypeDefinition } from "@operad-io/engine";
import {
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
  lowerPriorityOf,
  raisePriority,
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
