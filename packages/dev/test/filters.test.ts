import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { typeFilters } from "@operad-io/engine";
import { createDevPlugin } from "../src/index.ts";
import {
  PLAN_FILTERS,
  PLAN_STATES,
  TASK_FILTERS,
  TASK_PHASES,
  planState,
  type PlanData,
} from "../src/model.ts";
import { guardLockHandles } from "./support.ts";

guardLockHandles();

function declared(type: string) {
  const found = createDevPlugin().objects?.find((object) => object.name === type);
  return typeFilters(found);
}

test("the task filters come from the phase list", () => {
  const filters = declared("task");
  expect(filters?.default).toBe("active");
  expect(filters?.filters.map((filter) => filter.name)).toEqual([
    "active",
    "all",
    "done",
    "cancelled",
  ]);
  const states = (name: string) => filters?.filters.find((f) => f.name === name)?.states;
  expect(states("done")).toEqual(["merged"]);
  expect(states("cancelled")).toEqual(["cancelled"]);
  expect(states("active")).toEqual(
    TASK_PHASES.filter((phase) => phase !== "merged" && phase !== "cancelled"),
  );
  // Every phase is shown by exactly one filter.
  for (const phase of TASK_PHASES) {
    const owners = TASK_FILTERS.filter((filter) =>
      (filter.states as readonly string[]).includes(phase),
    );
    expect(owners).toHaveLength(1);
  }
});

test("the plan filters cover every state a plan row shows", () => {
  const filters = declared("plan");
  expect(filters?.default).toBe("active");
  for (const state of PLAN_STATES) {
    const owners = PLAN_FILTERS.filter((filter) =>
      (filter.states as readonly string[]).includes(state),
    );
    expect(owners).toHaveLength(1);
  }
  const plan: PlanData = {
    repository: "r",
    title: "t",
    request: "q",
    status: "confirmed",
    auto: "off",
    priority: "P3",
    concurrency: 1,
    taskCount: 1,
    mergedCount: 1,
    cancelledCount: 0,
  };
  expect(PLAN_STATES).toContain(planState(plan));
  expect(PLAN_STATES).toContain(planState({ ...plan, status: "draft" }));
  expect(PLAN_STATES).toContain(planState({ ...plan, status: "cancelled" }));
});

test("docs/manual.md lists the dev filters with the states the code declares", () => {
  const manual = readFileSync(join(import.meta.dir, "..", "..", "..", "docs", "manual.md"), "utf8");
  for (const [type, list] of [
    ["task", TASK_FILTERS],
    ["plan", PLAN_FILTERS],
  ] as const) {
    for (const filter of list) {
      const name = "default" in filter ? `\`${filter.name}\` (default)` : `\`${filter.name}\``;
      const row = `| ${type} | ${name} | ${filter.states.join(", ")} |`;
      expect(manual).toContain(row);
    }
  }
});
