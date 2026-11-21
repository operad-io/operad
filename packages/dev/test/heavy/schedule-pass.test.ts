import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PluginRegistry,
  SqlitePluginStore,
  type ListOptions,
  type ListPage,
  type ObjectData,
  type StoredObject,
} from "@operad-io/engine";
import poolPlugin from "@operad-io/pool";
import { createChatPlugin } from "@operad-io/chat";
import { createShellPlugin } from "@operad-io/shell";
import plugin from "../../src/index.ts";
import devFlow from "../../flows/dev.flow.ts";
import { compileDevFlow } from "../../src/flow-compiler.ts";
import {
  addPlan,
  addRepository,
  addTask,
  cancelTask,
  confirmPlan,
  getPlan,
  getTask,
} from "../../src/service.ts";
import {
  changeClock,
  planData,
  taskData,
  type RepositoryData,
} from "../../src/model.ts";
import { schedulerTestHooks } from "../../src/schedule.ts";
import { readDevSettings, settingsProblem } from "../../src/settings.ts";
import {
  cleanupTempRoots,
  guardLockHandles,
  makeGitRepository,
  tempRoot,
} from "../support.ts";

afterAll(cleanupTempRoots);
afterEach(() => {
  changeClock.now = () => Date.now();
  schedulerTestHooks.write = undefined;
  schedulerTestHooks.declare = undefined;
});
guardLockHandles();

/** A store that counts what the scheduler asks of it. */
class CountingStore extends SqlitePluginStore {
  readonly calls = {
    list: [] as string[],
    get: [] as string[],
    put: [] as string[],
  };

  override list(type: string, options: ListOptions = {}): ListPage {
    this.calls.list.push(type);
    return super.list(type, options);
  }

  override get(type: string, id: string): StoredObject | undefined {
    this.calls.get.push(type);
    return super.get(type, id);
  }

  override put(
    type: string,
    id: string,
    data: ObjectData,
    cause: string,
  ): StoredObject {
    this.calls.put.push(type);
    return super.put(type, id, data, cause);
  }

  reset(): void {
    this.calls.list.length = 0;
    this.calls.get.length = 0;
    this.calls.put.length = 0;
  }
}

interface Fixture {
  readonly root: string;
  readonly repositoryPath: string;
  readonly store: CountingStore;
  readonly registry: PluginRegistry;
  readonly repository: RepositoryData;
  readonly lines: string[];
}

async function setup(): Promise<Fixture> {
  const root = await tempRoot();
  const repositoryPath = await makeGitRepository(root);
  let now = 1_000_000;
  const store = new CountingStore({
    root: join(root, "store"),
    clock: () => now,
  });
  const registry = new PluginRegistry(
    [createChatPlugin(), plugin, poolPlugin, createShellPlugin()],
    {
      home: root,
      cwd: repositoryPath,
      store,
      storeRoot: store.root,
      onAnswer: async () => {},
      onCancelRun: () => {},
    },
  );
  const repository = await addRepository(store, { path: repositoryPath });
  const lines: string[] = [];
  schedulerTestHooks.write = (line) => lines.push(line);
  changeClock.now = () => now;
  return { root, repositoryPath, store, registry, repository, lines };
}

function writeSettings(path: string, value: Record<string, unknown>): void {
  writeFileSync(join(path, ".operad", "dev.json"), `${JSON.stringify(value)}\n`);
}

async function putTask(
  fixture: Fixture,
  key: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const object = await getTask(fixture.store, key);
  fixture.store.put("task", key, { ...taskData(object.data), ...patch }, "test");
}

async function tick(fixture: Fixture): Promise<void> {
  await fixture.registry.tick();
  fixture.registry.takeStartedRuns();
}

/** A graph as an older dev recorded it: its announcements have no edge for `waiting`. */
function olderGraph(name: string): ReturnType<typeof compileDevFlow> {
  const graph = compileDevFlow(name, [
    { stage: "code" },
    { stage: "test" },
    { stage: "review" },
    { stage: "human" },
  ]);
  return {
    ...graph,
    steps: graph.steps.map((step) => {
      const params = step.params as { readonly use?: unknown } | undefined;
      if (params?.use !== "dev/announce" || step.next === undefined || step.next === null) {
        return step;
      }
      return {
        ...step,
        next: Object.fromEntries(
          Object.entries(step.next).filter(([result]) => result !== "waiting"),
        ),
      };
    }),
  };
}

describe("the dev scheduler's repeated pass", () => {
  test("a second pass with nothing changed writes no plan, gets no task and lists tasks once", async () => {
    const fixture = await setup();
    const plan = await addPlan(fixture.store, {
      repository: fixture.repository,
      slug: "plan",
      title: "plan",
    });
    const task = await addTask(fixture.store, {
      plan: plan.id,
      slug: "task",
      title: "task",
    });
    await confirmPlan(fixture.store, plan.id);
    await cancelTask(fixture.store, task.id);

    // The first pass reports the plan finished and records its counts.
    await tick(fixture);
    const finished = planData((await getPlan(fixture.store, plan.id)).data);
    expect(finished.finishedReported).toBe(true);

    // A finished plan whose tasks did not change is not recounted, even if a
    // crash left its cached cost total behind.
    fixture.store.put(
      "plan",
      plan.id,
      {
        ...finished,
        costTotals: {
          exactMicros: 99,
          estimatedMicros: 0,
          incompleteMicros: 0,
          exactTasks: 99,
          estimatedTasks: 0,
          incompleteTasks: 0,
        },
      },
      "test",
    );
    fixture.store.reset();
    await tick(fixture);

    expect(fixture.store.calls.list.filter((type) => type === "task")).toHaveLength(1);
    expect(fixture.store.calls.get.filter((type) => type === "task")).toEqual([]);
    expect(fixture.store.calls.put.filter((type) => type === "plan")).toEqual([]);
    expect(planData((await getPlan(fixture.store, plan.id)).data).costTotals?.exactTasks).toBe(99);
  });

  test("an unchanged settings file is not read again", async () => {
    const fixture = await setup();
    writeSettings(fixture.repositoryPath, {
      name: fixture.repository.name,
      concurrency: 1,
    });
    await readDevSettings(fixture.repositoryPath);
    const spy = spyOn(fs, "readFileSync");
    try {
      await readDevSettings(fixture.repositoryPath);
      const settingsReads = spy.mock.calls.filter(([path]) =>
        String(path).endsWith("dev.json"),
      );
      expect(settingsReads).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("a settings read does not hand out the cached object to be changed", async () => {
    const fixture = await setup();
    writeSettings(fixture.repositoryPath, {
      name: fixture.repository.name,
      concurrency: 1,
    });
    const first = await readDevSettings(fixture.repositoryPath);
    const second = await readDevSettings(fixture.repositoryPath);
    expect(first).not.toBe(second);
    (first as unknown as { concurrency: number }).concurrency = 9;
    expect(second.concurrency).toBe(1);
  });

  test("a changed dev.json is picked up on the next pass", async () => {
    const fixture = await setup();
    writeSettings(fixture.repositoryPath, {
      name: fixture.repository.name,
      concurrency: 1,
    });
    const plan = await addPlan(fixture.store, {
      repository: fixture.repository,
      slug: "plan",
      title: "plan",
      auto: "run",
      concurrency: 2,
    });
    const first = await addTask(fixture.store, {
      plan: plan.id,
      slug: "first",
      title: "first",
    });
    await addTask(fixture.store, {
      plan: plan.id,
      slug: "second",
      title: "second",
    });
    await confirmPlan(fixture.store, plan.id);

    await tick(fixture);
    expect(taskData((await getTask(fixture.store, first.id)).data).phase).toBe("running");
    await putTask(fixture, first.id, { run: "run-1" });

    writeSettings(fixture.repositoryPath, {
      name: fixture.repository.name,
      concurrency: 2,
    });
    await tick(fixture);

    const tasks = await fixture.store.list("task");
    expect(
      tasks.objects.filter((object) => taskData(object.data).phase === "running"),
    ).toHaveLength(2);
  });

  test("a plan whose task changed is recounted", async () => {
    const fixture = await setup();
    const plan = await addPlan(fixture.store, {
      repository: fixture.repository,
      slug: "plan",
      title: "plan",
    });
    const task = await addTask(fixture.store, {
      plan: plan.id,
      slug: "task",
      title: "task",
    });
    await confirmPlan(fixture.store, plan.id);
    await cancelTask(fixture.store, task.id);
    await tick(fixture);
    expect(planData((await getPlan(fixture.store, plan.id)).data).costTotals?.exactTasks).toBe(0);

    await putTask(fixture, task.id, { cost: 2, costQuality: "exact" });
    fixture.store.reset();
    await tick(fixture);

    const counted = planData((await getPlan(fixture.store, plan.id)).data);
    expect(counted.costTotals).toMatchObject({
      exactMicros: 2_000_000,
      exactTasks: 1,
    });
    expect(fixture.store.calls.put.filter((type) => type === "plan").length).toBeGreaterThan(0);
  });

  test("a content-addressed flow is declared once, while dev and a refused graph are tried each pass", async () => {
    const fixture = await setup();
    writeSettings(fixture.repositoryPath, {
      name: fixture.repository.name,
      flows: {
        custom: { stages: [{ stage: "code" }, { stage: "human" }] },
      },
    });
    const plan = await addPlan(fixture.store, {
      repository: fixture.repository,
      slug: "plan",
      title: "plan",
    });
    const builtIn = await addTask(fixture.store, {
      plan: plan.id,
      slug: "built-in",
      title: "built-in",
    });
    await putTask(fixture, builtIn.id, { flowName: "dev", flowGraph: devFlow });
    const refused = await addTask(fixture.store, {
      plan: plan.id,
      slug: "refused",
      title: "refused",
    });
    const refusedName = "dev/repository/default/0123456789ab";
    await putTask(fixture, refused.id, {
      flowName: refusedName,
      flowGraph: olderGraph(refusedName),
    });

    const declared: string[] = [];
    schedulerTestHooks.declare = (flow) => declared.push(flow.name);
    await tick(fixture);
    const first = [...declared];
    declared.length = 0;
    await tick(fixture);
    const second = [...declared];

    const custom = first.find((name) => name.startsWith("dev/repository/custom/"));
    expect(custom).toBeString();
    // The content-addressed flow was declared on the first pass only.
    expect(second).not.toContain(custom);
    // The built-in flow's name has no hash, so it is declared again.
    expect(first).toContain("dev");
    expect(second).toContain("dev");
    // A graph today's steps refuse is not remembered as declared.
    expect(first).toContain(refusedName);
    expect(second).toContain(refusedName);
    expect(
      fixture.lines.filter((line) => line.includes("keeps no recorded flow")),
    ).toHaveLength(1);
  });

  test("an in-memory store declares a content-addressed flow once too", async () => {
    const fixture = await setup();
    Object.defineProperty(fixture.store, "kind", { value: "memory" });
    writeSettings(fixture.repositoryPath, {
      name: fixture.repository.name,
      flows: {
        custom: { stages: [{ stage: "code" }, { stage: "human" }] },
      },
    });
    const declared: string[] = [];
    schedulerTestHooks.declare = (flow) => declared.push(flow.name);
    await tick(fixture);
    const first = [...declared];
    declared.length = 0;
    await tick(fixture);
    const second = [...declared];

    const custom = first.find((name) => name.startsWith("dev/repository/custom/"));
    expect(custom).toBeString();
    expect(second).not.toContain(custom);
  });

  test("an unchanged settings text still checks a referenced workerBrief file", async () => {
    const fixture = await setup();
    const brief = join(fixture.repositoryPath, ".operad", "worker-brief.md");
    writeFileSync(brief, "brief\n");
    writeSettings(fixture.repositoryPath, {
      name: fixture.repository.name,
      flows: {
        image: {
          stages: [
            { stage: "code", workerBrief: ".operad/worker-brief.md" },
            { stage: "human" },
          ],
        },
      },
    });
    expect((await readDevSettings(fixture.repositoryPath)).flows.image).toBeDefined();
    expect(settingsProblem(fixture.repositoryPath)).toBeUndefined();

    rmSync(brief);
    expect(settingsProblem(fixture.repositoryPath)).toContain("does not exist");
  });
});
