import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { filterShows, typeFilters, type StoredObject } from "@operad-io/engine";
import { createDevPlugin } from "../src/index.ts";
import {
  PLAN_FILTERS,
  PLAN_STATES,
  REPO_FILTERS,
  TASK_FILTERS,
  TASK_FINAL_STATES,
  TASK_PHASES,
  TASK_ROW_STATES,
  planState,
  type PlanData,
  type TaskData,
  type TaskPhase,
} from "../src/model.ts";
import { taskViews } from "../src/views.ts";
import { guardLockHandles } from "./support.ts";

guardLockHandles();

function declared(type: string) {
  const found = createDevPlugin().objects?.find((object) => object.name === type);
  return typeFilters(found);
}

/** The declared task filters that show a row in this state. */
function taskFilterOwners(state: string) {
  return TASK_FILTERS.filter((filter) =>
    (filter.states as readonly string[]).includes(state),
  );
}

test("the task filters come from the row state list", () => {
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
    TASK_ROW_STATES.filter((state) => !TASK_FINAL_STATES.includes(state)),
  );
  // Every row state is shown by exactly one filter.
  for (const state of TASK_ROW_STATES) {
    expect(taskFilterOwners(state)).toHaveLength(1);
  }
});

/** A task object whose row has the given state, without a store. */
function taskObject(phase: TaskPhase, integrating = false): StoredObject {
  const data: TaskData = {
    repository: "repository",
    plan: "P-0001-plan",
    title: "One",
    brief: "b",
    after: [],
    phase,
    attempts: 0,
    run: null,
    ...(integrating
      ? { attempt: { number: 1, integrating: "run-1" } }
      : {}),
  };
  return {
    type: "task",
    id: "repository/T-0001-one",
    data,
    version: 1,
    cause: "test",
    at: 0,
  };
}

test("every state a task row can show is in exactly one declared task filter", () => {
  const states = [
    ...TASK_PHASES.map((phase) => taskViews.row(taskObject(phase)).state),
    // The integrate mark makes the row integrating, whatever the phase.
    taskViews.row(taskObject("waiting", true)).state,
  ];
  expect(new Set(states)).toEqual(new Set(TASK_ROW_STATES));
  for (const state of states) {
    const owners = taskFilterOwners(state);
    const expected: ("active" | "done" | "cancelled")[] =
      state === "merged"
        ? ["done"]
        : state === "cancelled"
          ? ["cancelled"]
          : ["active"];
    expect(owners.map((filter) => filter.name)).toEqual(expected);
    for (const filter of TASK_FILTERS) {
      expect(filterShows(filter, state)).toBe(filter.name === expected[0]);
    }
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

test("docs/user/cli.md lists the dev filters with the states the code declares", () => {
  const manual = readFileSync(join(import.meta.dir, "..", "..", "..", "docs", "user", "cli.md"), "utf8");
  for (const [type, list] of [
    ["task", TASK_FILTERS],
    ["plan", PLAN_FILTERS],
    ["repo", REPO_FILTERS],
  ] as const) {
    for (const filter of list) {
      const name = "default" in filter ? `\`${filter.name}\` (default)` : `\`${filter.name}\``;
      const row = `| ${type} | ${name} | ${filter.states.join(", ")} |`;
      expect(manual).toContain(row);
    }
  }
});
