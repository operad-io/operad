/**
 * Integrate and the main clone of a repository that works in a branch of its
 * own folder (`workIn` `branch`, ADR 0020 D4, ADR 0039; T-0719).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createChatPlugin } from "@operad-io/chat";
import { PluginRegistry } from "@operad-io/engine";
import { createPoolPlugin } from "@operad-io/pool";
import { createShellPlugin } from "@operad-io/shell";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addPlan,
  addRepository,
  addTask,
  confirmPlan,
  createDevPlugin,
  taskData,
} from "../../src/index.ts";
import { switchBackToStart } from "../../src/mainclone.ts";
import { commitIn, gitOrThrow, makeRemote, type RemoteSetup } from "../git-support.ts";
import { cleanupTempRoots, guardLockHandles, storeAt, tempRoot } from "../support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const CHILD = fileURLToPath(new URL("../fixtures/integrate-child.ts", import.meta.url));

interface Fixture {
  readonly remote: RemoteSetup;
  readonly clone: string;
  readonly taskKey: string;
  readonly branch: string;
  readonly registry: PluginRegistry;
  readonly store: ReturnType<typeof storeAt>;
}

async function fixture(): Promise<Fixture> {
  const root = await tempRoot();
  const remote = await makeRemote(root);
  const clone = remote.repository;
  const store = storeAt(root);
  const repository = await addRepository(store, { path: clone, name: "repository" });
  mkdirSync(join(clone, ".operad"), { recursive: true });
  writeFileSync(
    join(clone, ".operad", "dev.json"),
    JSON.stringify({
      name: "repository",
      remote: "origin",
      mainBranch: "main",
      workIn: "branch",
      gate: { commands: ["true"], commandTimeoutSecs: 60 },
    }),
  );
  appendFileSync(join(clone, ".git", "info", "exclude"), ".operad/\n");
  const plan = await addPlan(store, { repository, slug: "plan", title: "Plan", request: "do it" });
  const task = await addTask(store, { plan: plan.id, slug: "task", title: "Task", brief: "Do it." });
  await confirmPlan(store, plan.id);
  const taskId = task.id.slice(task.id.indexOf("/") + 1);
  const registry = new PluginRegistry(
    [createChatPlugin(), createDevPlugin(), createPoolPlugin(), createShellPlugin()],
    { home: root, cwd: clone, store },
  );
  const run = (name: string, runId: string) =>
    registry.runStep(`dev/${name}`, {}, { runId, object: { type: "task", id: task.id, data: {} } });
  const prepared = await run("worktree", "worktree-run");
  if (prepared.result !== "ready") throw new Error(`worktree: ${JSON.stringify(prepared)}`);
  // The worker's commit on the task branch, in the main clone.
  await commitIn(clone, "code.txt", "line\n", "add code");
  gitOrThrow(clone, ["push", "origin", `HEAD:refs/heads/work/${taskId}`]);
  const verified = await run("verify", "verify-run");
  if (verified.result !== "pass") throw new Error(`verify: ${JSON.stringify(verified)}`);
  return { remote, clone, taskKey: task.id, branch: `work/${taskId}`, registry, store };
}

function stepOf(state: Fixture, name: "integrate" | "cleanup", runId: string) {
  return state.registry.runStep(`dev/${name}`, {}, {
    runId,
    object: { type: "task", id: state.taskKey, data: {} },
  });
}

async function taskOf(state: Fixture) {
  const object = await state.store.get("task", state.taskKey);
  if (object === undefined) throw new Error("task disappeared");
  return taskData(object.data);
}

function head(dir: string): string {
  return gitOrThrow(dir, ["symbolic-ref", "--short", "HEAD"]);
}

function remoteMain(state: Fixture): string {
  return gitOrThrow(state.remote.origin, ["rev-parse", "refs/heads/main"]);
}

async function killedAt(state: Fixture, point: string, step: string, runId: string): Promise<void> {
  const child = Bun.spawn({
    cmd: [process.execPath, CHILD, state.store.root, state.clone, state.taskKey, runId, point, step, "1"],
    cwd: state.clone,
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  expect(child.signalCode).toBe("SIGKILL");
}

describe("integrate in branch mode", () => {
  test("the clone goes back to the starting branch and follows main", async () => {
    const state = await fixture();
    expect(head(state.clone)).toBe(state.branch);
    const result = await stepOf(state, "integrate", "integrate-run");
    expect(result.result).toBe("merged");
    expect(head(state.clone)).toBe("main");
    expect(gitOrThrow(state.clone, ["rev-parse", "HEAD"])).toBe(remoteMain(state));
    expect(gitOrThrow(state.clone, ["status", "--porcelain"])).toBe("");
    expect(existsSync(join(state.clone, "code.txt"))).toBe(true);
    const task = await taskOf(state);
    expect(task.brief).not.toContain("main clone not updated");
  }, 60_000);

  for (const point of [
    "candidate-built",
    "pending-saved",
    "push",
    "switched-back",
    "clone-followed",
    "merged-saved",
  ]) {
    test(`a kill at ${point}, then a rerun, merges once and leaves the clone on main`, async () => {
      const state = await fixture();
      const before = Number(gitOrThrow(state.remote.origin, ["rev-list", "--count", "main"]));
      await killedAt(state, point, "dev/integrate", "integrate-run");
      const result = await stepOf(state, "integrate", "integrate-run");
      expect(result.result).toBe("merged");
      expect(Number(gitOrThrow(state.remote.origin, ["rev-list", "--count", "main"]))).toBe(before + 2);
      expect(head(state.clone)).toBe("main");
      expect(gitOrThrow(state.clone, ["rev-parse", "HEAD"])).toBe(remoteMain(state));
      expect(gitOrThrow(state.clone, ["status", "--porcelain"])).toBe("");
    }, 60_000);
  }

  test("a clone the person moved to another branch is left alone and the note says so", async () => {
    const state = await fixture();
    gitOrThrow(state.clone, ["switch", "-q", "-c", "elsewhere"]);
    const result = await stepOf(state, "integrate", "integrate-run");
    expect(result.result).toBe("merged");
    expect(head(state.clone)).toBe("elsewhere");
    const task = await taskOf(state);
    expect(task.brief).toContain('main clone not updated: the main clone is on "elsewhere"');
    expect(task.brief).toContain(state.branch);
  }, 60_000);

  test("a clone with uncommitted changes stays on the task branch and the note says so", async () => {
    const state = await fixture();
    writeFileSync(join(state.clone, "mine.txt"), "mine\n");
    const result = await stepOf(state, "integrate", "integrate-run");
    expect(result.result).toBe("merged");
    expect(head(state.clone)).toBe(state.branch);
    expect(existsSync(join(state.clone, "mine.txt"))).toBe(true);
    const task = await taskOf(state);
    expect(task.brief).toContain(`uncommitted changes; the main clone stays on "${state.branch}"`);
    // The task branch is checked out: cleanup keeps it instead of failing.
    const cleaned = await stepOf(state, "cleanup", "cleanup-run");
    expect(cleaned.result).toBe("done");
    expect((await taskOf(state)).attempt?.cleanup?.failures).toEqual([]);
    expect(gitOrThrow(state.clone, ["branch", "--list", state.branch])).not.toBe("");
  }, 60_000);

  test("cleanup after the switch back deletes the task branch", async () => {
    const state = await fixture();
    await stepOf(state, "integrate", "integrate-run");
    const cleaned = await stepOf(state, "cleanup", "cleanup-run");
    expect(cleaned.result).toBe("done");
    expect((await taskOf(state)).attempt?.cleanup?.failures).toEqual([]);
    expect(gitOrThrow(state.clone, ["branch", "--list", state.branch])).toBe("");
  }, 60_000);

  test("a cleanup killed after its first hook, then rerun, ends clean", async () => {
    const state = await fixture();
    await stepOf(state, "integrate", "integrate-run");
    await killedAt(state, "hook-ran", "dev/cleanup", "cleanup-run");
    const cleaned = await stepOf(state, "cleanup", "cleanup-run");
    expect(cleaned.result).toBe("done");
    expect(gitOrThrow(state.clone, ["branch", "--list", state.branch])).toBe("");
  }, 60_000);
});

describe("switchBackToStart", () => {
  test("a clone already on the starting branch is fine; a detached one is left alone", async () => {
    const root = await tempRoot();
    const remote = await makeRemote(root);
    const dir = remote.repository;
    expect(switchBackToStart(dir, "main", "work/x")).toEqual({ ok: true });
    gitOrThrow(dir, ["switch", "-q", "--detach"]);
    expect(switchBackToStart(dir, "main", "work/x").ok).toBe(false);
  });

  test("a starting branch that is gone leaves the clone on the task branch", async () => {
    const root = await tempRoot();
    const remote = await makeRemote(root);
    const dir = remote.repository;
    gitOrThrow(dir, ["switch", "-q", "-c", "work/x"]);
    const result = switchBackToStart(dir, "gone", "work/x");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.note).toContain('cannot switch back to "gone"');
    expect(head(dir)).toBe("work/x");
  });
});
