import { createShellPlugin } from "@operad-io/shell";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PluginRegistry } from "@operad-io/engine";
import poolPlugin from "@operad-io/pool";
import plugin from "../../src/index.ts";
import {
  addPlan,
  addRepository,
  addTask,
  confirmPlan,
  getPlan,
  getTask,
  setAuto,
  setTaskPhase,
} from "../../src/service.ts";
import { taskViews } from "../../src/views.ts";
import { bareId, planData } from "../../src/model.ts";
import { schedulerTestHooks } from "../../src/schedule.ts";
import {
  cleanupTempRoots,
  guardLockHandles,
  makeGitRepository,
  storeAt,
  tempRoot,
} from "../support.ts";

afterAll(cleanupTempRoots);
afterEach(() => {
  schedulerTestHooks.write = undefined;
});
guardLockHandles();

async function setup(concurrency: number, withPool = true) {
  const root = await tempRoot();
  const repositoryPath = await makeGitRepository(root);
  const store = storeAt(root);
  const registry = new PluginRegistry(
    withPool ? [plugin, poolPlugin, createShellPlugin()] : [plugin, createShellPlugin()],
    { home: root, cwd: repositoryPath, store, storeRoot: store.root },
  );
  const repository = await addRepository(store, { path: repositoryPath });
  writeFileSync(
    join(repositoryPath, ".operad", "dev.json"),
    `${JSON.stringify({ name: repository.name, concurrency })}\n`,
  );
  schedulerTestHooks.write = () => undefined;
  return { store, registry, repository };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function plan(fixture: Fixture, slug: string, concurrency: number, tasks: readonly string[]) {
  const made = await addPlan(fixture.store, {
    repository: fixture.repository,
    slug,
    title: slug,
  });
  await setAuto(fixture.store, made.id, "run");
  const data = planData((await getPlan(fixture.store, made.id)).data);
  await fixture.store.put("plan", made.id, { ...data, concurrency }, "test");
  const keys: string[] = [];
  for (const task of tasks) {
    keys.push((await addTask(fixture.store, { plan: made.id, slug: task, title: task })).id);
  }
  await confirmPlan(fixture.store, made.id);
  return Object.assign(keys, { planKey: made.id });
}

async function note(fixture: Fixture, key: string): Promise<string> {
  return taskViews.row(await getTask(fixture.store, key)).note ?? "";
}

describe("a ready task says what holds it back", () => {
  test("the plan's slot names the running task and then how many more", async () => {
    const fixture = await setup(5);
    const [first, second, third] = await plan(fixture, "p", 1, ["a", "b", "c"]);
    if (first === undefined || second === undefined || third === undefined) throw new Error("tasks");
    await fixture.registry.tick();
    expect(await note(fixture, second)).toBe(
      `$0.00 · waiting for the plan's slot (${bareId(first)})`,
    );
    expect(await note(fixture, first)).not.toContain("slot");

    await setTaskPhase(fixture.store, first, "merged");
    await fixture.registry.tick();
    expect(await note(fixture, third)).toBe(
      `$0.00 · waiting for the plan's slot (${bareId(second)})`,
    );
    expect(await note(fixture, second)).not.toContain("slot");
  });

  test("several holders: the first, then and N more", async () => {
    const fixture = await setup(5);
    const [a, b, c] = await plan(fixture, "p", 2, ["a", "b", "c"]);
    if (a === undefined || b === undefined || c === undefined) throw new Error("tasks");
    await fixture.registry.tick();
    expect(await note(fixture, c)).toBe(
      `$0.00 · waiting for the plan's slot (${bareId(a)} and 1 more)`,
    );
  });

  test("the repository's slot is named when the plan has room", async () => {
    const fixture = await setup(1);
    const [first] = await plan(fixture, "one", 3, ["a"]);
    const [second] = await plan(fixture, "two", 3, ["b"]);
    if (first === undefined || second === undefined) throw new Error("tasks");
    await fixture.registry.tick();
    const waiting = (await note(fixture, first)).includes("slot") ? first : second;
    const holder = waiting === first ? second : first;
    expect(await note(fixture, waiting)).toBe(
      `$0.00 · waiting for the repository's slot (${bareId(holder)})`,
    );
    expect(await note(fixture, holder)).not.toContain("slot");
  });

  test("a ready task of a paused plan says the plan is paused", async () => {
    const fixture = await setup(2);
    const keys = await plan(fixture, "p", 2, ["a"]);
    const task = keys[0];
    if (task === undefined) throw new Error("tasks");
    const stored = await getPlan(fixture.store, keys.planKey);
    await fixture.store.put("plan", stored.id, { ...planData(stored.data), status: "paused" }, "test");
    await fixture.registry.tick();
    expect(await note(fixture, task)).toBe("$0.00 · waiting for the plan to resume");
  });

  test("a missing plugin is named", async () => {
    const fixture = await setup(2, false);
    const [task] = await plan(fixture, "p", 2, ["a"]);
    if (task === undefined) throw new Error("tasks");
    await fixture.registry.tick();
    expect(await note(fixture, task)).toBe("$0.00 · waiting for plugin pool");
  });
});
