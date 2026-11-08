import { describe, expect, test } from "bun:test";
import { ROW_MARKS, type RowMark } from "@operad-io/engine";
import { taskBadge, taskMark, planMark } from "../src/marks.ts";
import {
  PLAN_STATES,
  TASK_PHASES,
  type PlanData,
  type TaskAttempt,
  type TaskData,
} from "../src/model.ts";
import { planViews, taskViews } from "../src/views.ts";

function task(patch: Partial<TaskData> = {}): TaskData {
  return {
    repository: "r",
    plan: "P-0001-x",
    title: "T",
    brief: "",
    after: [],
    phase: "ready",
    attempts: 0,
    run: null,
    ...patch,
  };
}

function plan(patch: Partial<PlanData> = {}): PlanData {
  return {
    repository: "r",
    title: "P",
    request: "",
    status: "confirmed",
    auto: "off",
    priority: "P3",
    concurrency: 1,
    taskCount: 2,
    mergedCount: 0,
    cancelledCount: 0,
    ...patch,
  };
}

const attempt = (patch: Partial<TaskAttempt> = {}): TaskAttempt => ({
  number: 1,
  worktree: "/w",
  ...patch,
});

describe("task marks", () => {
  const cases: readonly [string, TaskData, RowMark][] = [
    ["proposed", task({ phase: "proposed" }), "proposed"],
    ["ready", task(), "todo"],
    ["ready behind a prior task", task({ dependencyHeld: true }), "blocked"],
    ["ready behind its area", task({ areaHeldBy: "T-0002-y" }), "blocked"],
    ["running, no worktree yet", task({ phase: "running" }), "starting"],
    [
      "running, attempt without worktree",
      task({ phase: "running", attempt: { number: 1 } }),
      "starting",
    ],
    ["running, worker at work", task({ phase: "running", attempt: attempt() }), "running"],
    [
      "running, model unavailable with a retry time",
      task({ phase: "running", attempt: attempt({ worked: true, workRetryAt: 5 }) }),
      "retry_wait",
    ],
    [
      "running, work done, verify next",
      task({ phase: "running", attempt: attempt({ worked: true }) }),
      "checking",
    ],
    [
      "running, integrating",
      task({
        phase: "running",
        attempt: attempt({ worked: true, integrating: "run-1", integration: { result: "pending" } }),
      }),
      "integrating",
    ],
    [
      "waiting while integrate builds the candidate",
      task({
        phase: "waiting",
        attempt: attempt({
          review: { result: "pass", decision: "passed" },
          integrating: "run-1",
        }),
      }),
      "integrating",
    ],
    [
      "running again after a conflict, the flow is back at the worker",
      task({
        phase: "running",
        attempt: attempt({ worked: true, integration: { result: "conflict" } }),
      }),
      "checking",
    ],
    ["review", task({ phase: "review", attempt: attempt() }), "checking"],
    ["review, unavailable with a retry time", task({ phase: "review", retryAt: 9 }), "retry_wait"],
    [
      "waiting after a passed gate",
      task({ phase: "waiting", attempt: attempt({ review: { result: "pass", decision: "passed" } }) }),
      "ready_to_merge",
    ],
    [
      "waiting, merge refused",
      task({
        phase: "waiting",
        attempt: attempt({
          review: { result: "pass", decision: "passed" },
          integration: { result: "failed" },
        }),
      }),
      "waiting",
    ],
    [
      "waiting, asked to rework",
      task({ phase: "waiting", attempt: attempt({ rework: { source: "review", streak: 1, result: "ask" } }) }),
      "rework_pending",
    ],
    [
      "waiting, given up after the auto rework limit",
      task({ phase: "waiting", attempt: attempt({ rework: { source: "review", streak: 3, limit: 2, result: "ask" } }) }),
      "failed",
    ],
    [
      "waiting, given up with a limit of 0",
      task({ phase: "waiting", attempt: attempt({ rework: { source: "gate", streak: 1, limit: 0, result: "ask" } }) }),
      "failed",
    ],
    ["waiting for another reason", task({ phase: "waiting", attempt: attempt() }), "waiting"],
    ["merged", task({ phase: "merged" }), "done"],
    ["cancelled", task({ phase: "cancelled" }), "cancelled"],
  ];
  for (const [name, data, expected] of cases) {
    test(name, () => expect(taskMark(data)).toBe(expected));
  }

  test("every phase and every mark it yields is a valid row mark", () => {
    for (const phase of TASK_PHASES) {
      expect(ROW_MARKS).toContain(taskMark(task({ phase })));
    }
  });
});

describe("plan marks", () => {
  test("each plan state maps", () => {
    expect(planMark(plan({ status: "draft" }))).toBe("proposed");
    expect(planMark(plan())).toBe("todo");
    expect(planMark(plan({ activeCount: 1 }))).toBe("running");
    expect(planMark(plan({ mergedCount: 1, cancelledCount: 1 }))).toBe("done");
    expect(planMark(plan({ status: "cancelled" }))).toBe("cancelled");
    expect(planMark(plan({ status: "paused" }))).toBe("paused");
    for (const state of PLAN_STATES) {
      expect(ROW_MARKS).toContain(planMark(plan({ status: state === "finished" ? "confirmed" : state })));
    }
  });
});

describe("task badge", () => {
  test("follows the attempt", () => {
    expect(taskBadge(task())).toBe("#0");
    expect(taskBadge(task({ attempts: 1, attempt: attempt() }))).toBe("#1");
    expect(taskBadge(task({ attempts: 2, attempt: attempt({ number: 2 }) }))).toBe("#2");
    // A fresh attempt is counted before the task's own count catches up.
    expect(taskBadge(task({ attempts: 1, attempt: attempt({ number: 2 }) }))).toBe("#2");
  });

  test("rows carry mark and badge", () => {
    const object = { type: "task", id: "T-0001-a", data: task({ phase: "merged", attempts: 2 }) as never };
    const row = taskViews.row(object as never);
    expect(row.mark).toBe("done");
    expect(row.badge).toBe("#2");
    const planRow = planViews.row({ type: "plan", id: "P-0001-x", data: plan() as never } as never);
    expect(planRow.mark).toBe("todo");
  });
});
