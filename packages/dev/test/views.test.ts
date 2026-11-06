import { afterAll, describe, expect, test } from "bun:test";
import {
  addPlan,
  addRepository,
  addRework,
  addTask,
  getPlan,
  getTask,
  setTaskPhase,
} from "../src/service.ts";
import { planViews, taskViews } from "../src/views.ts";
import { bareId, taskData } from "../src/model.ts";
import { cleanupTempRoots, guardLockHandles, makeGitRepository, storeAt, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

async function setup() {
  const root = await tempRoot();
  const repositoryPath = await makeGitRepository(root);
  const store = storeAt(root);
  const repository = await addRepository(store, { path: repositoryPath });
  const plan = await addPlan(store, {
    repository,
    slug: "storage",
    title: "Storage",
    request: "# Request\n\nWrite the store.",
  });
  const task = await addTask(store, {
    plan: plan.id,
    slug: "jsonl",
    title: "JSONL",
    brief: "# Brief\n\nUse lines.",
  });
  return { store, plan, task };
}

describe("dev views", () => {
  test("a plan row shows the derived state and merged/total", async () => {
    const { store, plan, task } = await setup();
    const confirmed = await getPlan(store, plan.id);
    expect(planViews.row(confirmed)).toEqual({
      id: "PL0001-storage",
      title: "Storage",
      state: "draft",
      note: "0/1",
    });
    await setTaskPhase(store, task.id, "merged");
    expect(planViews.row(await getPlan(store, plan.id)).note).toBe("1/1");
  });

  test("a task row reads the phase and the cost", async () => {
    const { store, task } = await setup();
    const stored = await getTask(store, task.id);
    expect(taskViews.row(stored)).toEqual({
      id: "TK0001-jsonl",
      title: "JSONL",
      state: "proposed",
    });
    await store.put(
      "task",
      task.id,
      { ...taskData(stored.data), cost: 0.31 },
      "test:cost",
    );
    expect(taskViews.row(await getTask(store, task.id))).toMatchObject({
      note: "$0.31",
    });
  });

  test("a task has brief and changes, and rework only after it has some", async () => {
    const { store, task } = await setup();
    const before = await getTask(store, task.id);
    expect(planViews.sections(before)).toEqual([
      { id: "request", title: "Request" },
      { id: "tasks", title: "Tasks" },
    ]);
    expect(taskViews.sections(before).map((section) => section.id)).toEqual([
      "brief",
      "changes",
    ]);
    expect(taskViews.load({} as never, before, "brief", {})).toEqual({
      markdown: "# Brief\n\nUse lines.",
    });
    expect(
      (taskViews.load({} as never, before, "changes", {}) as { markdown: string })
        .markdown,
    ).toContain("- created");

    await addRework(store, task.id, "review", "Add a test.");
    const after = await getTask(store, task.id);
    expect(taskViews.sections(after).map((section) => section.id)).toEqual([
      "brief",
      "rework",
      "changes",
    ]);
    const rework = taskViews.load({} as never, after, "rework", {}) as {
      markdown: string;
    };
    expect(rework.markdown).toContain("## Rework 1 (review)");
    expect(rework.markdown).not.toContain("## Changes");
  });

  test("a plan loads its request and a table of tasks", async () => {
    const { store, plan, task } = await setup();
    const stored = await getPlan(store, plan.id);
    expect(await planViews.load({ store } as never, stored, "request", {})).toEqual({
      markdown: "# Request\n\nWrite the store.",
    });
    const table = (await planViews.load(
      { store } as never,
      stored,
      "tasks",
      {},
    )) as { markdown: string };
    expect(table.markdown).toContain("| id | title | phase | after |");
    expect(table.markdown).toContain(
      `| ${bareId(task.id)} | JSONL | proposed | - |`,
    );
  });
});
