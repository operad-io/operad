/**
 * How a repository that works in a branch of its own folder holds its main
 * clone, ends a task, and reads dev.json (`workIn` `branch`, ADR 0039 D3, D5,
 * D6; T-0720).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createChatPlugin } from "@operad-io/chat";
import { PluginRegistry } from "@operad-io/engine";
import { createPoolPlugin } from "@operad-io/pool";
import { createShellPlugin } from "@operad-io/shell";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addPlan,
  addRepository,
  addTask,
  cancelPlan,
  cancelTask,
  confirmPlan,
  createDevPlugin,
  taskData,
} from "../../src/index.ts";
import { DEV_PROJECT_SETTINGS } from "../../src/project-settings.ts";
import { schedulerTestHooks } from "../../src/schedule.ts";
import { git, gitOrThrow, makeRemote } from "../git-support.ts";
import { cleanupTempRoots, guardLockHandles, storeAt, tempRoot } from "../support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const IDENT = ["-c", "user.name=test", "-c", "user.email=t@example.com"];

interface Fixture {
  readonly clone: string;
  readonly store: ReturnType<typeof storeAt>;
  readonly registry: PluginRegistry;
  readonly plan: string;
  readonly first: string;
  readonly second: string;
}

function devJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "repository",
    remote: "origin",
    mainBranch: "main",
    workIn: "branch",
    gate: { commands: ["true"], commandTimeoutSecs: 60 },
    ...extra,
  });
}

/** Two ready tasks of one plan; the first has run its worktree step, so the clone is on its branch. */
async function fixture(): Promise<Fixture> {
  const root = await tempRoot();
  const remote = await makeRemote(root);
  const clone = remote.repository;
  const store = storeAt(root);
  const repository = await addRepository(store, { path: clone, name: "repository" });
  mkdirSync(join(clone, ".operad"), { recursive: true });
  writeFileSync(join(clone, ".operad", "dev.json"), devJson());
  gitOrThrow(clone, ["add", ".operad/dev.json"]);
  gitOrThrow(clone, [...IDENT, "commit", "-qm", "settings"]);
  gitOrThrow(clone, ["push", "origin", "main"]);
  const plan = await addPlan(store, { repository, slug: "plan", title: "Plan", request: "do it" });
  const one = await addTask(store, { plan: plan.id, slug: "one", title: "One", brief: "Do one." });
  const two = await addTask(store, { plan: plan.id, slug: "two", title: "Two", brief: "Do two." });
  await confirmPlan(store, plan.id);
  const registry = new PluginRegistry(
    [createChatPlugin(), createDevPlugin(), createPoolPlugin(), createShellPlugin()],
    { home: root, cwd: clone, store },
  );
  const state = { clone, store, registry, plan: plan.id, first: one.id, second: two.id };
  const prepared = await step(state, state.first, "worktree", "run-1");
  if (prepared.result !== "ready") throw new Error(`worktree: ${JSON.stringify(prepared)}`);
  return state;
}

function step(
  state: Pick<Fixture, "registry">,
  task: string,
  name: "worktree",
  runId: string,
) {
  return state.registry.runStep(`dev/${name}`, {}, {
    runId,
    object: { type: "task", id: task, data: {} },
  });
}

async function taskOf(state: Fixture, key: string) {
  const object = await state.store.get("task", key);
  if (object === undefined) throw new Error("task disappeared");
  return taskData(object.data);
}

async function patch(state: Fixture, key: string, change: Record<string, unknown>): Promise<void> {
  const object = await state.store.get("task", key);
  if (object === undefined) throw new Error("task disappeared");
  state.store.put("task", key, { ...taskData(object.data), ...change }, "test");
}

function head(dir: string): string {
  return gitOrThrow(dir, ["symbolic-ref", "--short", "HEAD"]);
}

async function tick(state: Fixture): Promise<readonly string[]> {
  const lines: string[] = [];
  schedulerTestHooks.write = (line) => lines.push(line);
  try {
    await state.registry.tick();
    state.registry.takeStartedRuns();
  } finally {
    schedulerTestHooks.write = undefined;
  }
  return lines;
}

describe("a branch-mode task holds the main clone until it ends", () => {
  for (const phase of ["waiting", "paused", "ready"] as const) {
    test(`a ${phase} task keeps a second task from starting`, async () => {
      const state = await fixture();
      await patch(state, state.first, { phase, run: null, claim: null });
      await patch(state, state.second, { startRequested: true });
      await tick(state);
      expect((await taskOf(state, state.second)).phase).toBe("ready");
      expect(head(state.clone)).toBe(`work/${state.first.slice(state.first.indexOf("/") + 1)}`);
    }, 60_000);
  }

  test("a ready task that already holds the clone is not held by itself", async () => {
    const state = await fixture();
    await patch(state, state.first, { phase: "ready", run: null, claim: null, startRequested: true });
    await tick(state);
    expect((await taskOf(state, state.first)).phase).not.toBe("ready");
  }, 60_000);

  test("a waiting task of a worktree repository holds nothing", async () => {
    const state = await fixture();
    // The attempt did not put the clone on its branch: no slot beyond the run.
    const attempt = (await taskOf(state, state.first)).attempt;
    await patch(state, state.first, {
      phase: "waiting",
      run: null,
      claim: null,
      attempt: { ...attempt, inPlace: false },
    });
    await patch(state, state.second, { startRequested: true });
    await tick(state);
    expect((await taskOf(state, state.second)).phase).not.toBe("ready");
  }, 60_000);

  test("cancelling the holder frees the slot", async () => {
    const state = await fixture();
    await patch(state, state.first, { phase: "waiting", run: null, claim: null });
    await patch(state, state.second, { startRequested: true });
    await cancelTask(state.store, state.first);
    await tick(state);
    expect((await taskOf(state, state.second)).phase).not.toBe("ready");
  }, 60_000);
});

describe("cancel in branch mode", () => {
  test("switches the clone back to the starting branch and keeps the task branch", async () => {
    const state = await fixture();
    const branch = `work/${state.first.slice(state.first.indexOf("/") + 1)}`;
    const cancelled = await cancelTask(state.store, state.first);
    expect(cancelled.note).toBeUndefined();
    expect(head(state.clone)).toBe("main");
    expect(git(state.clone, ["rev-parse", "--verify", branch]).ok).toBe(true);
    expect((await taskOf(state, state.first)).phase).toBe("cancelled");
  }, 60_000);

  test("a dirty clone stays where it is and the task says so", async () => {
    const state = await fixture();
    const branch = `work/${state.first.slice(state.first.indexOf("/") + 1)}`;
    writeFileSync(join(state.clone, "mine.txt"), "mine\n");
    const cancelled = await cancelTask(state.store, state.first);
    expect(cancelled.note).toContain("uncommitted changes");
    expect(cancelled.note).toContain(branch);
    expect(head(state.clone)).toBe(branch);
    const task = await taskOf(state, state.first);
    expect(task.phase).toBe("cancelled");
    expect(task.brief).toContain("uncommitted changes");
    expect(git(state.clone, ["status", "--porcelain"]).out).toContain("mine.txt");
  }, 60_000);

  test("a plan's cancel switches the clone back and says what it could not", async () => {
    const state = await fixture();
    const cancelled = await cancelPlan(state.store, state.plan);
    expect(cancelled.notes).toEqual([]);
    expect(head(state.clone)).toBe("main");
  }, 60_000);

  test("a task that never held the clone leaves the clone alone", async () => {
    const state = await fixture();
    gitOrThrow(state.clone, ["switch", "-q", "-c", "elsewhere"]);
    const cancelled = await cancelTask(state.store, state.second);
    expect(cancelled.note).toBeUndefined();
    expect(head(state.clone)).toBe("elsewhere");
  }, 60_000);
});

describe("dev.json in branch mode", () => {
  test("a save is refused while a task holds the clone, and allowed once it ends", async () => {
    const state = await fixture();
    const file = DEV_PROJECT_SETTINGS.files[0];
    if (file?.check === undefined) throw new Error("dev.json has no check");
    const [repository] = await DEV_PROJECT_SETTINGS.repositories({ store: state.store });
    if (repository === undefined) throw new Error("no repository");
    const check = () => file.check?.({ repository, value: {}, name: "dev.checks" });
    const holder = state.first.slice(state.first.indexOf("/") + 1);
    const refused = await check();
    expect(refused).toContain("cannot be saved");
    expect(refused).toContain(holder);
    await cancelTask(state.store, state.first);
    expect(await check()).toBeUndefined();
  }, 60_000);

  test("the next attempt reads the starting branch's dev.json, not the task branch's", async () => {
    const state = await fixture();
    const before = (await taskOf(state, state.first)).attempt?.settingsText ?? "";
    expect(JSON.parse(before)).toHaveProperty("gate.commands", ["true"]);
    // The task's own commit edits the file.
    writeFileSync(join(state.clone, ".operad", "dev.json"), devJson({ gate: { commands: ["false"], commandTimeoutSecs: 5 } }));
    gitOrThrow(state.clone, ["add", ".operad/dev.json"]);
    gitOrThrow(state.clone, [...IDENT, "commit", "-qm", "task edits dev.json"]);
    const again = await step(state, state.first, "worktree", "run-2");
    expect(again.result).toBe("ready");
    const attempt = (await taskOf(state, state.first)).attempt;
    expect(attempt?.number).toBe(2);
    expect(JSON.parse(attempt?.settingsText ?? "")).toHaveProperty("gate.commands", ["true"]);
  }, 60_000);
});
