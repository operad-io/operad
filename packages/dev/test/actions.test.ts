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
import { planViews } from "../src/views.ts";
import { cleanupTempRoots, guardLockHandles, makeGitRepository, storeAt, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const ACTOR = { via: "test", id: "tester" } as const;

/** Gives a waiting task the verified commit a merge needs. */
async function verifiedHead(
  store: ReturnType<typeof storeAt>,
  id: string,
): Promise<void> {
  const current = taskData((await getTask(store, id)).data);
  await store.put(
    "task",
    id,
    { ...current, attempt: { number: 1, run: "run-1", verified: "abc123" } },
    "test:verified",
  );
}

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
    expect(names).toContain("auto");
    expect(names).toContain("priority");
    expect(names).not.toContain("auto-off");
    expect(names).not.toContain("auto-run");
    expect(names).not.toContain("auto-merge");
    expect(names).not.toContain("priority-up");
    expect(names).not.toContain("priority-down");

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
    const object = async () => getPlan(store, plan.id);

    for (const level of ["off", "run", "merge"] as const) {
      await registry.runAction("dev/auto", { level }, { object: await object(), actor: ACTOR });
      expect(planData((await object()).data).auto).toBe(level);
    }

    for (const level of ["P0", "P1", "P2", "P3", "P4", "P5"] as const) {
      await registry.runAction("dev/priority", { level }, { object: await object(), actor: ACTOR });
      expect(planData((await object()).data).priority).toBe(level);
    }
  });

  test("auto and priority refuse a bad value with the allowed ones", async () => {
    const { store, registry, repository } = await setup();
    const plan = await addPlan(store, { repository, slug: "work", title: "Work" });
    const object = await getPlan(store, plan.id);

    await expect(
      registry.runAction("dev/auto", { level: "sometimes" }, { object, actor: ACTOR }),
    ).rejects.toThrow(/"off", "run", "merge"/);
    await expect(
      registry.runAction("dev/priority", { level: "P9" }, { object, actor: ACTOR }),
    ).rejects.toThrow(/"P0", "P1", "P2", "P3", "P4", "P5"/);
  });

  test("auto and priority need their level argument", async () => {
    const { store, registry, repository } = await setup();
    const plan = await addPlan(store, { repository, slug: "work", title: "Work" });
    const object = await getPlan(store, plan.id);

    await expect(
      registry.runAction("dev/auto", {}, { object, actor: ACTOR }),
    ).rejects.toThrow(/args\.level: is required/);
    await expect(
      registry.runAction("dev/priority", {}, { object, actor: ACTOR }),
    ).rejects.toThrow(/args\.level: is required/);
  });

  test("the old auto and priority action names are unknown", async () => {
    const { store, registry, repository } = await setup();
    const plan = await addPlan(store, { repository, slug: "work", title: "Work" });
    const object = await getPlan(store, plan.id);

    for (const name of [
      "dev/auto-off",
      "dev/auto-run",
      "dev/auto-merge",
      "dev/priority-up",
      "dev/priority-down",
    ]) {
      await expect(
        registry.runAction(name, {}, { object, actor: ACTOR }),
      ).rejects.toThrow(/no loaded plugin declares it/);
    }
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
    await verifiedHead(store, task.id);

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

  test("merge refuses a task whose head was never verified, and says why", async () => {
    const answers: string[] = [];
    const { store, registry, repository } = await setup(undefined, (_runId, choice) => {
      answers.push(choice);
    });
    const plan = await addPlan(store, { repository, slug: "work", title: "Work" });
    const task = await addTask(store, { plan: plan.id, slug: "one", title: "One" });
    await setTaskPhase(store, task.id, "waiting");
    const before = await getTask(store, task.id);
    await expect(
      registry.runAction("dev/merge", {}, {
        object: before,
        runId: "run-1",
        actor: ACTOR,
      }),
    ).rejects.toThrow(/has no verified commit; run operad dev:reverify T-0001-one first/);
    expect(answers).toEqual([]);
    expect((await getTask(store, task.id)).version).toBe(before.version);
  });

  test("a refused action names the state and the state it needs", async () => {
    const { store, registry, repository } = await setup();
    const plan = await addPlan(store, { repository, slug: "work", title: "Work" });
    const task = await addTask(store, { plan: plan.id, slug: "one", title: "One" });
    await setTaskPhase(store, task.id, "ready");
    const why = (name: string, object: Awaited<ReturnType<typeof getTask>>) =>
      registry
        .actionDefinition("dev", name, object.type)
        ?.why?.(object);
    expect(why("confirm", await getTask(store, task.id))).toBe(
      "T-0001-one is ready; dev:confirm needs proposed",
    );
    expect(why("merge", await getTask(store, task.id))).toBe(
      "T-0001-one is ready; dev:merge needs waiting",
    );
  });

  test("priority on a plan whose auto level is off says the scheduler will not start it", async () => {
    const { store, registry, repository } = await setup();
    const plan = await addPlan(store, { repository, slug: "work", title: "Work" });
    const run = await registry.runAction("dev/priority", { level: "P1" }, {
      object: await getPlan(store, plan.id),
      actor: ACTOR,
    });
    expect(run.value).toBe(
      "P-0001-work has auto off: the scheduler does not start its tasks; run operad dev:auto P-0001-work --level merge",
    );
    await registry.runAction("dev/auto", { level: "merge" }, {
      object: await getPlan(store, plan.id),
      actor: ACTOR,
    });
    const quiet = await registry.runAction("dev/priority", { level: "P2" }, {
      object: await getPlan(store, plan.id),
      actor: ACTOR,
    });
    expect(quiet.value).toBeUndefined();
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
        object: { type: "task", id: "T-9999-nope", data: {} },
        runId: "run-1",
        actor: ACTOR,
      }),
    ).rejects.toThrow(/no task/);
  });

  test("concurrency sets the plan's count and the view shows it", async () => {
    const { store, registry, repository } = await setup();
    const plan = await addPlan(store, { repository, slug: "work", title: "Work" });
    for (const count of [1, 2, 16]) {
      await registry.runAction(
        "dev/concurrency",
        { count },
        { object: await getPlan(store, plan.id), actor: ACTOR },
      );
      expect(planData((await getPlan(store, plan.id)).data).concurrency).toBe(count);
    }
    expect(planViews.row(await getPlan(store, plan.id)).note).toContain("concurrency: 16");
  });

  test("concurrency refuses 0, 17, a fraction and a string and leaves the plan alone", async () => {
    const { store, registry, repository } = await setup();
    const plan = await addPlan(store, { repository, slug: "work", title: "Work" });
    const object = await getPlan(store, plan.id);
    await expect(
      registry.runAction("dev/concurrency", { count: 0 }, { object, actor: ACTOR }),
    ).rejects.toThrow(/count: must be at least 1/);
    await expect(
      registry.runAction("dev/concurrency", { count: 17 }, { object, actor: ACTOR }),
    ).rejects.toThrow(/count: must be at most 16/);
    await expect(
      registry.runAction("dev/concurrency", { count: 1.5 }, { object, actor: ACTOR }),
    ).rejects.toThrow(/count/);
    await expect(
      registry.runAction("dev/concurrency", { count: "3" }, { object, actor: ACTOR }),
    ).rejects.toThrow(/count/);
    await expect(
      registry.runAction("dev/concurrency", {}, { object, actor: ACTOR }),
    ).rejects.toThrow(/args\.count: is required/);
    expect(planData((await getPlan(store, plan.id)).data).concurrency).toBe(1);
    const action = registry
      .actions()
      .find((candidate) => candidate.name === "dev:concurrency");
    expect(JSON.stringify(action?.args)).toContain("16");
  });

  test("concurrency is refused on a cancelled plan", async () => {
    const { store, registry, repository } = await setup();
    const plan = await addPlan(store, { repository, slug: "work", title: "Work" });
    await registry.runAction("dev/cancel", {}, { object: await getPlan(store, plan.id), actor: ACTOR });
    const object = await getPlan(store, plan.id);
    await expect(
      registry.runAction("dev/concurrency", { count: 2 }, { object, actor: ACTOR }),
    ).rejects.toThrow(/cancelled|not cancelled/);
    expect(planData((await getPlan(store, plan.id)).data).concurrency).toBe(1);
  });

  test("addPlan takes a concurrency and refuses one out of range", async () => {
    const { store, repository } = await setup();
    const plan = await addPlan(store, { repository, slug: "wide", title: "Wide", concurrency: 4 });
    expect(planData(plan.data).concurrency).toBe(4);
    await expect(
      addPlan(store, { repository, slug: "bad", title: "Bad", concurrency: 17 }),
    ).rejects.toThrow(/1 to 16/);
  });
});
