import { createShellPlugin } from "@operad-io/shell";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { PluginRegistry } from "@operad-io/engine";
import poolPlugin from "@operad-io/pool";
import plugin from "../../src/index.ts";
import {
  addPlan,
  addRepository,
  addTask,
  confirmPlan,
  removeRepository,
  getTask,
  setAuto,
  setTaskPhase,
  updateTask,
} from "../../src/service.ts";
import { taskViews } from "../../src/views.ts";
import { bareId, taskData, type RepositoryData } from "../../src/model.ts";
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

async function setup() {
  const root = await tempRoot();
  const store = storeAt(root);
  const mainPath = await makeGitRepository(root, "main-repo");
  const otherPath = await makeGitRepository(root, "operad");
  const registry = new PluginRegistry([plugin, poolPlugin, createShellPlugin()], {
    home: root,
    cwd: mainPath,
    store,
    storeRoot: store.root,
    onAnswer: async () => {},
    onCancelRun: () => {},
  });
  const main = await addRepository(store, { path: mainPath });
  const other = await addRepository(store, { path: otherPath });
  schedulerTestHooks.write = () => {};
  const plan = async (repository: RepositoryData, slug: string, auto = true) => {
    const object = await addPlan(store, { repository, slug, title: slug });
    if (auto) await setAuto(store, object.id, "run");
    return object.id;
  };
  const task = async (
    planKey: string,
    slug: string,
    after: readonly string[] = [],
  ) => (await addTask(store, { plan: planKey, slug, title: slug, after })).id;
  const tick = async () => {
    await registry.tick();
    return registry.takeStartedRuns();
  };
  return { store, main, other, plan, task, tick };
}

describe("--after across plans and repositories", () => {
  test("a task of another plan of the repository blocks until it merges", async () => {
    const s = await setup();
    const planA = await s.plan(s.main, "a");
    const planB = await s.plan(s.main, "b");
    const first = await s.task(planA, "first");
    const second = await s.task(planB, "second", [bareId(first)]);
    expect(taskData((await getTask(s.store, second)).data).after).toEqual([first]);
    await confirmPlan(s.store, planA);
    await confirmPlan(s.store, planB);

    await s.tick();
    const blocked = await getTask(s.store, second);
    expect(taskViews.row(blocked).mark).toBe("blocked");
    expect(taskViews.row(blocked).note).toContain(`waiting for ${bareId(first)}`);
    expect(taskViews.row(blocked).after).toEqual([bareId(first)]);

    await setTaskPhase(s.store, first, "merged");
    const started = await s.tick();
    expect(started.map((request) => request.object?.id)).toContain(second);
  });

  test("a task of another repository blocks until it merges and the note names the repository", async () => {
    const s = await setup();
    const planA = await s.plan(s.main, "a");
    const planB = await s.plan(s.other, "b");
    const dependency = await s.task(planB, "chat");
    const key = await s.task(planA, "page", [dependency]);
    expect(taskData((await getTask(s.store, key)).data).after).toEqual([dependency]);
    await confirmPlan(s.store, planA);
    await confirmPlan(s.store, planB);
    await setTaskPhase(s.store, dependency, "running");

    await s.tick();
    const row = taskViews.row(await getTask(s.store, key));
    expect(row.mark).toBe("blocked");
    expect(row.note).toContain(`waiting for ${dependency}`);
    expect(row.note).toContain("operad/");
    expect(row.after).toEqual([dependency]);

    await setTaskPhase(s.store, dependency, "merged");
    const started = await s.tick();
    expect(started.map((request) => request.object?.id)).toContain(key);
  });

  test("a cancelled cross-repository dependency waits for a person; re-pointing releases it", async () => {
    const s = await setup();
    const planA = await s.plan(s.main, "a");
    const planB = await s.plan(s.other, "b", false);
    const dependency = await s.task(planB, "chat");
    const key = await s.task(planA, "page", [dependency]);
    await confirmPlan(s.store, planA);
    await setTaskPhase(s.store, dependency, "cancelled");

    const started = await s.tick();
    const request = started.find((item) => item.object?.id === key);
    expect(request?.params).toEqual({ blockedBy: dependency, token: expect.any(String) });

    await setTaskPhase(s.store, key, "waiting", { run: "run-1" });
    await updateTask(s.store, key, { after: [] });
    const released = taskData((await getTask(s.store, key)).data);
    expect(released.phase).toBe("ready");
    expect(released.after).toEqual([]);
  });

  test("a task cannot follow itself or close a cycle; an unknown task is refused", async () => {
    const s = await setup();
    const planA = await s.plan(s.main, "a");
    const planB = await s.plan(s.other, "b");
    const first = await s.task(planA, "first");
    const second = await s.task(planB, "second", [first]);
    await expect(updateTask(s.store, first, { after: [second] })).rejects.toThrow(/cycle/);
    await expect(updateTask(s.store, first, { after: [first] })).rejects.toThrow(/follow itself/);
    await expect(s.task(planA, "third", ["T-9999"])).rejects.toThrow(/no task/);
    await expect(s.task(planA, "fourth", ["nowhere/T-0001"])).rejects.toThrow(/no task/);
  });
});

describe("--after validation under races and removed repositories", () => {
  test("two cross-repository updates at once cannot close a cycle", async () => {
    const s = await setup();
    const planA = await s.plan(s.main, "a");
    const planB = await s.plan(s.other, "b");
    const first = await s.task(planA, "first");
    const second = await s.task(planB, "second");
    const results = await Promise.allSettled([
      updateTask(s.store, first, { after: [second] }),
      updateTask(s.store, second, { after: [first] }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(String((rejected as PromiseRejectedResult).reason)).toMatch(/cycle/);
  });

  test("a task of a removed repository cannot be named", async () => {
    const s = await setup();
    const planA = await s.plan(s.main, "a");
    const planB = await s.plan(s.other, "b");
    const gone = await s.task(planB, "gone");
    await setTaskPhase(s.store, gone, "cancelled");
    await removeRepository(s.store, "operad");
    await expect(s.task(planA, "late", [gone])).rejects.toThrow(/no task/);
  });
});
