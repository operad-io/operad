import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createViews, PluginRegistry } from "@operad-io/engine";
import { createDevPlugin } from "../src/index.ts";
import {
  addPlan,
  confirmPlan,
  refreshPlanCounts,
  getPlan,
  addRepository,
  addTask,
  cancelPlan,
  removeRepository,
  setTaskPhase,
} from "../src/service.ts";
import { cleanupTempRoots, guardLockHandles, makeGitRepository, storeAt, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const opened: ReturnType<typeof createViews>[] = [];
afterEach(() => {
  for (const views of opened.splice(0)) views.close();
});

async function setup() {
  const root = await tempRoot();
  const store = storeAt(root);
  const registry = new PluginRegistry([createDevPlugin()], { store, storeRoot: store.root });
  const views = createViews({ registry, store, onLog: () => undefined });
  opened.push(views);
  const alphaPath = await makeGitRepository(root, "alpha");
  const betaPath = await makeGitRepository(root, "beta");
  const alpha = await addRepository(store, { path: alphaPath });
  const beta = await addRepository(store, { path: betaPath });
  return { root, store, views, alpha, beta, alphaPath };
}

const ids = (page: { rows: readonly { id: string }[] }) => page.rows.map((row) => row.id);

describe("the repo type", () => {
  test("repo add makes a repo object with a row", async () => {
    const { views } = await setup();
    const page = await views.list("repo");
    expect(page.rows.map((row) => ({ ...row, waiting: undefined, running: undefined }))).toEqual([
      {
        id: "alpha",
        title: "alpha",
        state: "active",
        note: "plans: 0 · tasks: 0",
        mark: "done",
        waiting: undefined,
        running: undefined,
      },
      {
        id: "beta",
        title: "beta",
        state: "active",
        note: "plans: 0 · tasks: 0",
        mark: "done",
        waiting: undefined,
        running: undefined,
      },
    ]);
  });

  test("root lists the repos only, and a repo has no parent", async () => {
    const { views, store, alpha } = await setup();
    const plan = await addPlan(store, { repository: alpha, slug: "work", title: "Work" });
    await addTask(store, { plan: plan.id, slug: "one", title: "One" });
    const root = await views.listTree(undefined, { root: true });
    expect(ids(root)).toEqual(["alpha", "beta"]);
    expect(root.rows.every((row) => row.parent === undefined)).toBe(true);
  });

  test("parent=<repo> lists its plans with the default filter and counts the hidden ones", async () => {
    const { views, store, alpha, beta } = await setup();
    const open = await addPlan(store, { repository: alpha, slug: "open", title: "Open" });
    const done = await addPlan(store, { repository: alpha, slug: "done", title: "Done" });
    const other = await addPlan(store, { repository: beta, slug: "other", title: "Other" });
    await cancelPlan(store, done.id);
    const page = await views.listTree(undefined, { parent: "repo:alpha" });
    expect(ids(page)).toEqual([bare(open.id)]);
    expect(page.hidden).toBe(1);
    expect(page.rows[0]?.parent).toBe("repo:alpha");
    expect(ids(await views.listTree(undefined, { parent: "repo:beta" }))).toEqual([bare(other.id)]);
    // A bare repo name resolves the same way.
    expect(ids(await views.listTree(undefined, { parent: "alpha" }))).toEqual([bare(open.id)]);
  });

  test("parent=<plan> lists its tasks, and another repository's plan with the same id does not leak", async () => {
    const { views, store, alpha, beta } = await setup();
    const one = await addPlan(store, { repository: alpha, slug: "work", title: "Work" });
    const two = await addPlan(store, { repository: beta, slug: "work", title: "Work" });
    expect(bare(one.id)).toBe(bare(two.id));
    const mine = await addTask(store, { plan: one.id, slug: "mine", title: "Mine" });
    const theirs = await addTask(store, { plan: two.id, slug: "theirs", title: "Theirs" });
    const tasks = await views.listTree(undefined, { parent: `plan:${one.id}` });
    expect(ids(tasks)).toEqual([bare(mine.id)]);
    expect(tasks.rows[0]?.parent).toBe(`plan:${one.id}`);
    expect(ids(await views.listTree(undefined, { parent: `plan:${two.id}` }))).toEqual([
      bare(theirs.id),
    ]);
  });

  test("the row counts open plans and open tasks as they change", async () => {
    const { views, store, alpha } = await setup();
    const plan = await addPlan(store, { repository: alpha, slug: "work", title: "Work" });
    const task = await addTask(store, { plan: plan.id, slug: "one", title: "One" });
    const note = async () => (await views.get("repo:alpha")).row.note;
    expect(await note()).toBe("plans: 1 · tasks: 1");
    await confirmPlan(store, plan.id);
    await setTaskPhase(store, task.id, "merged");
    await refreshPlanCounts(store, await getPlan(store, plan.id));
    expect(await note()).toBe("plans: 0 · tasks: 0");
  });

  describe("the row mark follows the repository's work", () => {
    const mark = async (views: ReturnType<typeof createViews>) =>
      (await views.get("repo:alpha")).row.mark;

    test("running while a task has a run in progress", async () => {
      const { views, store, alpha } = await setup();
      const plan = await addPlan(store, { repository: alpha, slug: "work", title: "Work" });
      const task = await addTask(store, { plan: plan.id, slug: "one", title: "One" });
      await setTaskPhase(store, task.id, "running", { run: "r1" });
      expect(await mark(views)).toBe("running");
    });

    test("todo while plans or tasks are not yet ended", async () => {
      const { views, store, alpha } = await setup();
      const plan = await addPlan(store, { repository: alpha, slug: "work", title: "Work" });
      await addTask(store, { plan: plan.id, slug: "one", title: "One" });
      expect(await mark(views)).toBe("todo");
    });

    test("done when every plan and task has ended", async () => {
      const { views, store, alpha } = await setup();
      const plan = await addPlan(store, { repository: alpha, slug: "work", title: "Work" });
      const task = await addTask(store, { plan: plan.id, slug: "one", title: "One" });
      await confirmPlan(store, plan.id);
      await setTaskPhase(store, task.id, "merged");
      expect(await mark(views)).toBe("done");
    });

    test("a removed repository reads as cancelled", async () => {
      const { views, store } = await setup();
      await removeRepository(store, "alpha");
      expect(await mark(views)).toBe("cancelled");
    });

    test("a task starting and ending its run changes the mark", async () => {
      const { views, store, alpha } = await setup();
      const plan = await addPlan(store, { repository: alpha, slug: "work", title: "Work" });
      const task = await addTask(store, { plan: plan.id, slug: "one", title: "One" });
      expect(await mark(views)).toBe("todo");
      await setTaskPhase(store, task.id, "running", { run: "r1" });
      expect(await mark(views)).toBe("running");
      await setTaskPhase(store, task.id, "ready");
      expect(await mark(views)).toBe("todo");
    });
  });

  test("a repository stored without a running-task count shows running for a task already running", async () => {
    const { root, store, alpha } = await setup();
    const plan = await addPlan(store, { repository: alpha, slug: "work", title: "Work" });
    const task = await addTask(store, { plan: plan.id, slug: "one", title: "One" });
    await setTaskPhase(store, task.id, "running", { run: "r1" });
    const stored = await store.get("repo", "alpha");
    if (stored === undefined) throw new Error("alpha is missing");
    const { activeTasks: _dropped, ...old } = stored.data;
    await store.put("repo", "alpha", old, "test:old-repo");
    const again = storeAt(root);
    const registry = new PluginRegistry([createDevPlugin()], { store: again, storeRoot: again.root });
    const fresh = createViews({ registry, store: again, onLog: () => undefined });
    opened.push(fresh);
    expect((await fresh.get("repo:alpha")).row.mark).toBe("running");
  });

  test("the Overview names the path, the default branch, dev.json, worker and reviewer", async () => {
    const { views, alphaPath } = await setup();
    const object = await views.get("repo:alpha");
    expect(object.sections.map((section) => section.id)).toEqual(["overview", "history"]);
    const defaults = (await views.section("repo:alpha", "overview")).markdown;
    expect(defaults).toContain(`- Path: \`${alphaPath}\``);
    expect(defaults).toContain("- Default branch: `main` on `origin`");
    expect(defaults).toContain("in force");
    expect(defaults).toContain("- Worker: `");
    expect(defaults).toContain("- Reviewer: `");
    mkdirSync(join(alphaPath, ".operad"), { recursive: true });
    writeFileSync(join(alphaPath, ".operad", "dev.json"), JSON.stringify({ mainBranch: "trunk" }));
    const written = (await views.section("repo:alpha", "overview")).markdown;
    expect(written).toContain("- Default branch: `trunk` on `origin`");
  });

  test("a repository added or removed after start fires an event and appears or disappears", async () => {
    const { root, store, views } = await setup();
    const events = views.events()[Symbol.asyncIterator]();
    const gammaPath = await makeGitRepository(root, "gamma");
    await addRepository(store, { path: gammaPath });
    await waitFor(events, "gamma");
    expect(ids(await views.list("repo"))).toContain("gamma");
    await removeRepository(store, "gamma");
    await waitFor(events, "gamma");
    const page = await views.list("repo", { filter: views.defaultFilterOf("repo") ?? "" });
    expect(ids(page)).not.toContain("gamma");
    expect(page.hidden).toBe(1);
    expect(ids(await views.list("repo", { filter: "removed" }))).toEqual(["gamma"]);
  });

  test("a repository stored before dev declared repo shows up as a repo object", async () => {
    const { root, store, views } = await setup();
    await store.put("repository", "legacy", {
      name: "legacy",
      path: await makeGitRepository(root, "legacy"),
      removed: false,
    }, "test:legacy");
    // A fresh store handle has not migrated yet.
    const again = storeAt(root);
    const registry = new PluginRegistry([createDevPlugin()], { store: again, storeRoot: again.root });
    const fresh = createViews({ registry, store: again, onLog: () => undefined });
    opened.push(fresh);
    // No dev command runs first: the list itself carries the repository over.
    expect(ids(await fresh.list("repo"))).toContain("legacy");
    void views;
  });
});

function bare(key: string): string {
  return key.slice(key.indexOf("/") + 1);
}

async function waitFor(
  events: AsyncIterator<{ readonly id: string }>,
  id: string,
): Promise<void> {
  for (;;) {
    const next = await events.next();
    if (next.done === true) throw new Error(`the event stream ended before ${id}`);
    if (next.value.id === id || next.value.id === `repo:${id}`) return;
  }
}
