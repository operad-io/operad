import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PluginRegistry } from "@operad-io/engine";
import { DEFAULT_MCP } from "@operad-io/engine";
import poolPlugin from "@operad-io/pool";
import { createShellPlugin } from "@operad-io/shell";
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
} from "../src/service.ts";
import { bareId, taskData } from "../src/model.ts";
import { schedulerTestHooks } from "../src/schedule.ts";
import { taskViews } from "../src/views.ts";
import { commitIn, git, gitOrThrow, makeRemote } from "./git-support.ts";
import {
  cleanupTempRoots,
  guardLockHandles,
  storeAt,
  tempRoot,
} from "./support.ts";

afterAll(cleanupTempRoots);
afterEach(() => {
  schedulerTestHooks.write = undefined;
});
guardLockHandles();

const ACTOR = { via: "test", id: "tester" } as const;

async function setup() {
  const root = await tempRoot();
  const remote = await makeRemote(root);
  const store = storeAt(root);
  const cancelled: string[] = [];
  const registry = new PluginRegistry([plugin, poolPlugin, createShellPlugin()], {
    home: root,
    cwd: remote.repository,
    store,
    storeRoot: store.root,
    onCancelRun: (runId) => {
      cancelled.push(runId);
    },
  });
  schedulerTestHooks.write = () => undefined;
  const repository = await addRepository(store, {
    path: remote.repository,
    name: "repository",
  });
  const plan = await addPlan(store, { repository, slug: "plan", title: "Plan" });
  await setAuto(store, plan.id, "run");
  const add = async (slug: string, after: readonly string[] = []) =>
    (await addTask(store, { plan: plan.id, slug, title: slug, after })).id;
  return { root, remote, store, registry, cancelled, plan, add };
}
type Setup = Awaited<ReturnType<typeof setup>>;

async function tick(s: Setup) {
  await s.registry.tick();
  return s.registry.takeStartedRuns().map((request) => request.object?.id);
}

async function task(s: Setup, key: string) {
  return taskData((await getTask(s.store, key)).data);
}

async function act(s: Setup, name: string, key: string) {
  return s.registry.runAction(
    `dev/${name}`,
    {},
    { object: await getTask(s.store, key), actor: ACTOR },
  );
}

/** Runs the worktree step of a task the scheduler just claimed. */
async function runWorktree(s: Setup, key: string, runId: string) {
  const claim = (await task(s, key)).claim;
  return s.registry.runStep("dev/worktree", {}, {
    runId,
    object: { type: "task", id: key, data: {} },
    ...(claim === undefined || claim === null ? {} : { params: { token: claim.token } }),
  });
}

describe("dev:hold and dev:release", () => {
  test("hold stops the running step, keeps the branch and commits, and frees the slot", async () => {
    const s = await setup();
    const first = await s.add("first");
    const second = await s.add("second");
    await confirmPlan(s.store, s.plan.id);
    expect(await tick(s)).toEqual([first]);
    expect((await runWorktree(s, first, "run-1")).result).toBe("ready");
    const before = await task(s, first);
    const worktree = before.attempt?.worktree ?? "";
    await commitIn(worktree, "work.txt", "done so far\n", "partial work");
    const claimToken = before.claim?.token;

    await act(s, "hold", first);

    expect(s.cancelled).toEqual(["run-1"]);
    const held = await task(s, first);
    expect(held.phase).toBe("held");
    expect(held.run).toBeNull();
    expect(held.claim).toBeNull();
    expect(held.attempts).toBe(1);
    expect(held.attempt?.branch).toBe(`work/${bareId(first)}`);
    expect(existsSync(worktree)).toBe(true);
    expect(git(worktree, ["log", "--format=%s", "-n", "1"]).out).toBe("partial work");
    expect(taskViews.row(await getTask(s.store, first)).mark).toBe("paused");

    // The step that was running cannot write the task again.
    const stale = await s.registry.runStep("dev/worktree", {}, {
      runId: "run-1",
      object: { type: "task", id: first, data: {} },
      params: { token: claimToken ?? "" },
    });
    expect(stale.result).toBe("cancelled");
    expect((await task(s, first)).phase).toBe("held");

    // The slot is free: the next task starts, the held one does not.
    expect(await tick(s)).toEqual([second]);
    expect((await task(s, first)).phase).toBe("held");
  });

  test("a held ready task is not started, and its dependent stays queued", async () => {
    const s = await setup();
    const first = await s.add("first");
    const second = await s.add("second", [bareId(first)]);
    await confirmPlan(s.store, s.plan.id);
    await act(s, "hold", first);
    expect((await task(s, first)).phase).toBe("held");

    expect(await tick(s)).toEqual([]);
    const dependent = await task(s, second);
    expect(dependent.phase).toBe("ready");
    expect(dependent.dependencyHeld).toBe(true);
    expect(taskViews.row(await getTask(s.store, second)).mark).toBe("blocked");
  });

  test("release makes the task ready and the next run continues on its branch", async () => {
    const s = await setup();
    const first = await s.add("first");
    await confirmPlan(s.store, s.plan.id);
    await tick(s);
    await runWorktree(s, first, "run-1");
    const worktree = (await task(s, first)).attempt?.worktree ?? "";
    await commitIn(worktree, "work.txt", "kept\n", "partial work");
    await act(s, "hold", first);
    expect(await tick(s)).toEqual([]);

    await act(s, "release", first);
    expect((await task(s, first)).phase).toBe("ready");
    expect(await tick(s)).toEqual([first]);
    const result = await runWorktree(s, first, "run-2");
    expect(result.result).toBe("ready");

    const next = await task(s, first);
    expect(next.phase).toBe("running");
    expect(next.attempts).toBe(2);
    expect(next.attempt?.number).toBe(2);
    expect(next.attempt?.worktree).toBe(worktree);
    expect(gitOrThrow(worktree, ["log", "--format=%s", "-n", "1"])).toBe("partial work");
  });

  test("hold and release refuse where they cannot work, and stay with the owner", async () => {
    const s = await setup();
    const first = await s.add("first");
    await expect(act(s, "release", first)).rejects.toThrow();
    await setTaskPhase(s.store, first, "waiting", { run: "run-9" });
    await expect(act(s, "hold", first)).rejects.toThrow(/waiting for you/);
    await setTaskPhase(s.store, first, "cancelled");
    await expect(act(s, "hold", first)).rejects.toThrow(/cancelled/);

    const names = s.registry
      .actions()
      .filter((action) => action.on === "task")
      .map((action) => action.name);
    expect(names).toContain("dev:hold");
    expect(names).toContain("dev:release");
    for (const name of ["dev:hold", "dev:release"]) {
      expect(s.registry.actions().find((action) => action.name === name)?.confirm).toBe(true);
      expect(DEFAULT_MCP.actions).not.toContain(name);
    }
  });

  test("task update --after releases a task waiting on a cancelled dependency", async () => {
    const s = await setup();
    const first = await s.add("first");
    const other = await s.add("other");
    const second = await s.add("second", [bareId(first)]);
    await confirmPlan(s.store, s.plan.id);
    await setTaskPhase(s.store, first, "cancelled");
    await setTaskPhase(s.store, other, "merged");

    // The scheduler parks the task in a person wait.
    expect(await tick(s)).toEqual([second]);
    const claim = (await task(s, second)).claim;
    const blocked = await s.registry.runStep("dev/worktree", {}, {
      runId: "run-blocked",
      object: { type: "task", id: second, data: {} },
      params: { blockedBy: bareId(first), token: claim?.token ?? "" },
    });
    expect(blocked.result).toBe("blocked");
    expect((await task(s, second)).phase).toBe("waiting");

    await s.registry.runCommand(["dev", "task", "update", bareId(second), "--after", bareId(other)]);

    expect(s.cancelled).toEqual(["run-blocked"]);
    const released = await task(s, second);
    expect(released.phase).toBe("ready");
    expect(released.run).toBeNull();
    expect(released.after).toEqual([bareId(other)]);
    expect(await tick(s)).toEqual([second]);
    expect((await getPlan(s.store, s.plan.id)).id).toBe(s.plan.id);
  });

  test("task update --after \"\" clears the dependencies and releases the wait", async () => {
    const s = await setup();
    const first = await s.add("first");
    const second = await s.add("second", [bareId(first)]);
    await confirmPlan(s.store, s.plan.id);
    await setTaskPhase(s.store, first, "cancelled");
    await tick(s);
    await s.registry.runStep("dev/worktree", {}, {
      runId: "run-blocked",
      object: { type: "task", id: second, data: {} },
      params: {
        blockedBy: bareId(first),
        token: (await task(s, second)).claim?.token ?? "",
      },
    });

    await s.registry.runCommand(["dev", "task", "update", bareId(second), "--after", ""]);

    const released = await task(s, second);
    expect(released.phase).toBe("ready");
    expect(released.after).toEqual([]);
    expect(await tick(s)).toEqual([second]);
  });

  test("task update refuses a waiting task whose dependency was not cancelled", async () => {
    const s = await setup();
    const first = await s.add("first");
    await setTaskPhase(s.store, first, "waiting", { run: "run-5" });
    await expect(
      s.registry.runCommand(["dev", "task", "update", bareId(first), "--after", ""]),
    ).rejects.toThrow(/only proposed or ready/);
  });
});
