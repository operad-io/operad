import { createShellPlugin } from "@operad-io/shell";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PluginRegistry } from "@operad-io/engine";
import poolPlugin from "@operad-io/pool";
import plugin from "../src/index.ts";
import {
  addPlan,
  addRepository,
  addTask,
  confirmPlan,
  getPlan,
  getTask,
  setAuto,
  setTaskPhase,
  updateTask,
} from "../src/service.ts";
import { taskViews, planViews } from "../src/views.ts";
import { planData, taskData, type RepositoryData } from "../src/model.ts";
import { schedulerTestHooks } from "../src/schedule.ts";
import { cleanupTempRoots, guardLockHandles, makeGitRepository, storeAt, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);
afterEach(() => {
  schedulerTestHooks.write = undefined;
});
guardLockHandles();

const GATE = [{ stage: "check", commands: ["true"] }, { stage: "human" }];
const FLOWS = {
  default: { stages: [{ stage: "work" }, ...GATE] },
  quick: { stages: [{ stage: "work" }, { stage: "human" }] },
};

async function setup(flows?: Record<string, unknown>) {
  const root = await tempRoot();
  const repositoryPath = await makeGitRepository(root);
  const store = storeAt(root);
  const registry = new PluginRegistry([plugin, poolPlugin, createShellPlugin()], {
    home: root,
    cwd: repositoryPath,
    store,
    storeRoot: store.root,
    onAnswer: async () => {},
    onCancelRun: () => {},
  });
  const repository: RepositoryData = await addRepository(store, { path: repositoryPath });
  const write = (devFlows: Record<string, unknown> | undefined) =>
    writeFileSync(
      join(repositoryPath, ".operad", "dev.json"),
      `${JSON.stringify({
        name: repository.name,
        concurrency: 4,
        ...(devFlows === undefined ? {} : { flows: devFlows }),
      })}\n`,
    );
  write(flows);
  const lines: string[] = [];
  schedulerTestHooks.write = (line) => lines.push(line);
  return { store, registry, repository, lines, write };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function started(fixture: Fixture): Promise<Map<string, string>> {
  await fixture.registry.tick();
  const map = new Map<string, string>();
  for (const request of fixture.registry.takeStartedRuns()) {
    map.set(request.object?.id ?? "", request.flow);
  }
  return map;
}

describe("choosing a flow", () => {
  test("a task takes its own flow, then its plan's, then default", async () => {
    const fixture = await setup(FLOWS);
    const plan = await addPlan(fixture.store, {
      repository: fixture.repository, slug: "p", title: "p", flow: "quick",
    });
    const plain = await addPlan(fixture.store, {
      repository: fixture.repository, slug: "q", title: "q",
    });
    expect(planData(plan.data).flow).toBe("quick");
    expect(planData(plain.data).flow).toBeUndefined();
    const inherits = await addTask(fixture.store, { plan: plan.id, slug: "a", title: "a" });
    const third = await addPlan(fixture.store, {
      repository: fixture.repository, slug: "r", title: "r", flow: "quick",
    });
    const own = await addTask(fixture.store, { plan: third.id, slug: "b", title: "b", flow: "default" });
    const none = await addTask(fixture.store, { plan: plain.id, slug: "c", title: "c" });
    expect(taskData(inherits.data).flow).toBeUndefined();
    expect(taskData(own.data).flow).toBe("default");
    for (const key of [plan.id, plain.id, third.id]) {
      await setAuto(fixture.store, key, "run");
      await confirmPlan(fixture.store, key);
    }
    const runs = await started(fixture);
    const quick = runs.get(inherits.id);
    expect(quick).toContain("/quick/");
    expect(runs.get(own.id)).toContain("/default/");
    expect(runs.get(none.id)).toContain("/default/");
    // Two flows, two graphs: each task runs its own.
    expect(quick).not.toBe(runs.get(own.id));
  });

  test("a flow changes only before the first attempt", async () => {
    const fixture = await setup(FLOWS);
    const plan = await addPlan(fixture.store, { repository: fixture.repository, slug: "p", title: "p" });
    const task = await addTask(fixture.store, { plan: plan.id, slug: "a", title: "a" });
    const changed = await updateTask(fixture.store, task.id, { flow: "quick" });
    expect(taskData(changed.data).flow).toBe("quick");
    await setAuto(fixture.store, plan.id, "run");
    await confirmPlan(fixture.store, plan.id);
    await started(fixture);
    // Back to ready after the attempt: still refused.
    await setTaskPhase(fixture.store, task.id, "ready");
    await expect(updateTask(fixture.store, task.id, { flow: "default" })).rejects.toThrow(
      /first attempt/,
    );
    expect(taskData((await getTask(fixture.store, task.id)).data).flow).toBe("quick");
  });

  test("an undefined flow does not start, and the rows say why", async () => {
    const fixture = await setup(FLOWS);
    const plan = await addPlan(fixture.store, { repository: fixture.repository, slug: "p", title: "p" });
    const task = await addTask(fixture.store, { plan: plan.id, slug: "a", title: "a", flow: "missing" });
    await setAuto(fixture.store, plan.id, "run");
    await confirmPlan(fixture.store, plan.id);
    expect((await started(fixture)).size).toBe(0);
    const reason = "flow missing is not defined in .operad/dev.json";
    const row = taskViews.row(await getTask(fixture.store, task.id));
    expect(row.state).toBe("ready");
    expect(row.note).toContain(reason);
    expect(planViews.row(await getPlan(fixture.store, plan.id)).note).toContain(reason);
    // Defining it releases the task.
    fixture.write({ ...FLOWS, missing: { stages: [{ stage: "work" }, { stage: "human" }] } });
    const runs = await started(fixture);
    expect(runs.get(task.id)).toContain("/missing/");
    const after = taskViews.row(await getTask(fixture.store, task.id));
    expect(after.note).not.toContain(reason);
  });

  test("rows and the brief name the flow only when the repository defines more than one", async () => {
    const many = await setup(FLOWS);
    const plan = await addPlan(many.store, { repository: many.repository, slug: "p", title: "p", flow: "quick" });
    const task = await addTask(many.store, { plan: plan.id, slug: "a", title: "a" });
    await many.registry.tick();
    const object = await getTask(many.store, task.id);
    expect(taskViews.row(object).note).toContain("flow: quick");
    const brief = await taskViews.load({ store: many.store } as never, object, "brief", {} as never);
    expect(brief.markdown).toContain("Flow: quick");

    const single = await setup();
    const one = await addPlan(single.store, { repository: single.repository, slug: "p", title: "p" });
    const lone = await addTask(single.store, { plan: one.id, slug: "a", title: "a" });
    await single.registry.tick();
    expect(taskViews.row(await getTask(single.store, lone.id)).note).not.toContain("flow:");
  });
});
