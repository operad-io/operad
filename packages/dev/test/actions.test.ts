import { afterAll, describe, expect, test } from "bun:test";
import { PluginRegistry } from "@operad-io/engine";
import plugin from "../src/index.ts";
import {
  addPlan,
  addRepository,
  addTask,
  getPlan,
  getTask,
  setTaskPhase,
} from "../src/service.ts";
import { planData, taskData } from "../src/model.ts";
import { cleanupTempRoots, guardLockHandles, makeGitRepository, storeAt, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const ACTOR = { via: "test", id: "tester" } as const;

async function setup(
  onCancelRun?: (runId: string) => void,
  onAnswer?: (
    runId: string,
    choice: string,
    note: string | undefined,
  ) => void,
) {
  const root = await tempRoot();
  const repositoryPath = await makeGitRepository(root);
  const store = storeAt(root);
  const registry = new PluginRegistry([plugin], {
    store,
    storeRoot: store.root,
    ...(onCancelRun === undefined ? {} : { onCancelRun }),
    ...(onAnswer === undefined
      ? {}
      : {
          onAnswer: async (runId, choice, note) => {
            onAnswer(runId, choice, note);
          },
        }),
  });
  const repository = await addRepository(store, { path: repositoryPath });
  return { store, registry, repository };
}

describe("dev actions", () => {
  test("confirm is one name on a plan and on a task", async () => {
    const { store, registry, repository } = await setup();
    const plan = await addPlan(store, { repository, slug: "work", title: "Work" });
    const task = await addTask(store, { plan: plan.id, slug: "one", title: "One" });

    await registry.runAction("dev/confirm", {}, { object: await getPlan(store, plan.id), actor: ACTOR });
    expect(planData((await getPlan(store, plan.id)).data).status).toBe(
      "confirmed",
    );
    expect(taskData((await getTask(store, task.id)).data).phase).toBe("ready");
  });

  test("the same action name runs on its own object type", async () => {
    const { store, registry, repository } = await setup();
    const plan = await addPlan(store, { repository, slug: "work", title: "Work" });
    const task = await addTask(store, { plan: plan.id, slug: "one", title: "One" });
    await expect(
      registry.runAction("dev/confirm", {}, { object: await getTask(store, task.id), actor: ACTOR }),
    ).rejects.toThrow(/plan .* is not confirmed/);
    await registry.runAction("dev/confirm", {}, { object: await getPlan(store, plan.id), actor: ACTOR });
    await setTaskPhase(store, task.id, "ready");
    await expect(
      registry.runAction("dev/confirm", {}, { object: await getTask(store, task.id), actor: ACTOR }),
    ).rejects.toThrow(/already ready/);
  });

  test("pending offers the plan's available actions with the default keys", async () => {
    const { store, registry, repository } = await setup();
    const plan = await addPlan(store, { repository, slug: "work", title: "Work" });
    const pending = await registry.pending([
      { runId: "r1", object: { type: "plan", id: plan.id } },
    ]);
    const names = pending[0]?.actions.map((action) => action.action) ?? [];
    expect(names).toContain("confirm");
    expect(names).toContain("cancel");
    expect(names).toContain("auto-run");
    expect(names).toContain("auto-merge");
    expect(names).not.toContain("auto-off");
    expect(names).toContain("priority-up");
    expect(names).toContain("priority-down");

    const keys = new Map(
      registry.keyBindings().map((binding) => [binding.name, binding.key]),
    );
    expect(keys.get("dev:confirm")).toBe("c");
    expect(keys.get("dev:cancel")).toBe("x");

    const cancel = registry
      .actions()
      .find((action) => action.name === "dev:cancel" && action.on === "plan");
    expect(cancel?.confirm).toBe(true);
  });

  test("auto and priority actions move the plan", async () => {
    const { store, registry, repository } = await setup();
    const plan = await addPlan(store, { repository, slug: "work", title: "Work" });
    await registry.runAction("dev/auto-run", {}, { object: await getPlan(store, plan.id), actor: ACTOR });
    expect(planData((await getPlan(store, plan.id)).data).auto).toBe("run");
    await registry.runAction("dev/auto-off", {}, { object: await getPlan(store, plan.id), actor: ACTOR });
    expect(planData((await getPlan(store, plan.id)).data).auto).toBe("off");
    await registry.runAction("dev/priority-up", {}, { object: await getPlan(store, plan.id), actor: ACTOR });
    expect(planData((await getPlan(store, plan.id)).data).priority).toBe("P2");
    await registry.runAction("dev/priority-down", {}, { object: await getPlan(store, plan.id), actor: ACTOR });
    expect(planData((await getPlan(store, plan.id)).data).priority).toBe("P3");
  });

  test("cancel of a plan asks the kernel to cancel a running task's run", async () => {
    const cancelled: string[] = [];
    const { store, registry, repository } = await setup((runId) => {
      cancelled.push(runId);
    });
    const plan = await addPlan(store, { repository, slug: "work", title: "Work" });
    const task = await addTask(store, { plan: plan.id, slug: "one", title: "One" });
    await setTaskPhase(store, task.id, "running", { run: "run-3" });
    await registry.runAction("dev/cancel", {}, { object: await getPlan(store, plan.id), actor: ACTOR });
    expect(cancelled).toEqual(["run-3"]);
    expect(taskData((await getTask(store, task.id)).data).phase).toBe(
      "cancelled",
    );
  });

  test("merge answers the task's wait and is offered only while it waits", async () => {
    const answers: [string, string | undefined][] = [];
    const { store, registry, repository } = await setup(undefined, (_runId, choice, note) => {
      answers.push([choice, note]);
    });
    const plan = await addPlan(store, { repository, slug: "work", title: "Work" });
    const task = await addTask(store, { plan: plan.id, slug: "one", title: "One" });
    await setTaskPhase(store, task.id, "waiting");

    const pending = await registry.pending([
      { runId: "run-1", object: { type: "task", id: task.id } },
    ]);
    const names = pending[0]?.actions.map((action) => action.action) ?? [];
    expect(names).toContain("merge");
    expect(names).toContain("reject");

    await registry.runAction("dev/merge", {}, {
      object: await getTask(store, task.id),
      runId: "run-1",
      actor: ACTOR,
    });
    expect(answers).toEqual([["merge", undefined]]);
  });

  test("reject appends the owner's rework before answering", async () => {
    const answers: [string, string | undefined][] = [];
    const { store, registry, repository } = await setup(undefined, (_runId, choice, note) => {
      answers.push([choice, note]);
    });
    const plan = await addPlan(store, { repository, slug: "work", title: "Work" });
    const task = await addTask(store, { plan: plan.id, slug: "one", title: "One" });
    await setTaskPhase(store, task.id, "waiting");

    await registry.runAction(
      "dev/reject",
      { note: "cover the concurrent writers" },
      {
        object: await getTask(store, task.id),
        runId: "run-1",
        actor: ACTOR,
      },
    );
    expect(answers).toEqual([["reject", "cover the concurrent writers"]]);
    const after = taskData((await getTask(store, task.id)).data);
    expect(after.brief).toContain("## Rework 1 (owner)");
    expect(after.brief).toContain("cover the concurrent writers");
  });

  test("merge and reject refuse a running task", async () => {
    const answers: string[] = [];
    const { store, registry, repository } = await setup(undefined, (_runId, choice) => {
      answers.push(choice);
    });
    const plan = await addPlan(store, { repository, slug: "work", title: "Work" });
    const task = await addTask(store, { plan: plan.id, slug: "one", title: "One" });
    await setTaskPhase(store, task.id, "running");
    const object = await getTask(store, task.id);

    const pending = await registry.pending([
      { runId: "run-1", object: { type: "task", id: task.id } },
    ]);
    const names = pending[0]?.actions.map((action) => action.action) ?? [];
    expect(names).not.toContain("merge");
    expect(names).not.toContain("reject");

    await expect(
      registry.runAction("dev/merge", {}, { object, runId: "run-1", actor: ACTOR }),
    ).rejects.toThrow(/is running, not waiting/);
    await expect(
      registry.runAction(
        "dev/reject",
        { note: "no" },
        { object, runId: "run-1", actor: ACTOR },
      ),
    ).rejects.toThrow(/is running, not waiting/);
    expect(answers).toEqual([]);
  });

  test("merge and reject refuse an unknown task and a wait without a run", async () => {
    const { store, registry, repository } = await setup();
    const plan = await addPlan(store, { repository, slug: "work", title: "Work" });
    const task = await addTask(store, { plan: plan.id, slug: "one", title: "One" });
    await setTaskPhase(store, task.id, "waiting");
    const object = await getTask(store, task.id);

    await expect(
      registry.runAction("dev/merge", {}, { object, actor: ACTOR }),
    ).rejects.toThrow(/not waiting for a run/);
    await expect(
      registry.runAction(
        "dev/reject",
        { note: "no" },
        { object, actor: ACTOR },
      ),
    ).rejects.toThrow(/not waiting for a run/);
    await expect(
      registry.runAction("dev/merge", {}, {
        object: { type: "task", id: "TK9999-nope", data: {} },
        runId: "run-1",
        actor: ACTOR,
      }),
    ).rejects.toThrow(/no task/);
  });
});
