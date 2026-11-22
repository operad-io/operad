/**
 * The worktree step and the work step of a repository that works in a branch
 * of its own folder (`workIn` `branch`, ADR 0039 D1, D4; T-0718).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createChatPlugin } from "@operad-io/chat";
import { definePlugin, PluginRegistry, type PluginStepResult } from "@operad-io/engine";
import { createPoolPlugin } from "@operad-io/pool";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addPlan,
  addRepository,
  addTask,
  createDevPlugin,
  taskData,
  type RepositoryData,
} from "../../src/index.ts";
import { advanceMain, git, gitOrThrow, makeRemote, silentGit, type RemoteSetup } from "../git-support.ts";
import { cleanupTempRoots, guardLockHandles, storeAt, tempRoot } from "../support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const CRASH_CHILD = fileURLToPath(new URL("../fixtures/worktree-crash-child.ts", import.meta.url));

/** A worker that writes a file and, for the mode `commit`, commits it itself. */
function fakeHarness() {
  return definePlugin({
    name: "fake-harness",
    kind: "harness",
    version: "0.0.0",
    steps: [
      {
        name: "agent",
        results: ["done", "failed", "interrupted"],
        async run(_ctx, params): Promise<PluginStepResult> {
          const input = params as { readonly cwd: string; readonly args?: readonly string[] };
          const mode = input.args?.[0] ?? "leave";
          writeFileSync(join(input.cwd, "worker.txt"), "done\n");
          if (mode === "commit") {
            gitOrThrow(input.cwd, ["add", "worker.txt"]);
            gitOrThrow(input.cwd, [
              "-c",
              "user.name=worker",
              "-c",
              "user.email=worker@example.com",
              "commit",
              "-qm",
              "worker work",
            ]);
          }
          if (mode === "note") {
            writeFileSync(join(input.cwd, ".operad-progress.md"), "a note\n");
          }
          return { result: "done", data: { sessionId: "fake-session" } };
        },
      },
    ],
  });
}

interface Fixture {
  readonly root: string;
  readonly remote: RemoteSetup;
  readonly repository: RepositoryData;
  readonly clone: string;
  readonly taskKey: string;
  readonly taskId: string;
  readonly branch: string;
  readonly registry: PluginRegistry;
  readonly store: ReturnType<typeof storeAt>;
}

async function fixture(mode = "leave"): Promise<Fixture> {
  const root = await tempRoot();
  const remote = await makeRemote(root);
  const clone = remote.repository;
  const store = storeAt(root);
  const repository = await addRepository(store, { path: clone, name: "repository" });
  // dev.json is committed, as in a real project: a clean clone is the start.
  mkdirSync(join(clone, ".operad"), { recursive: true });
  writeFileSync(
    join(clone, ".operad", "dev.json"),
    JSON.stringify({
      name: "repository",
      remote: "origin",
      mainBranch: "main",
      workIn: "branch",
      worker: { use: "fake-harness/agent", args: [mode] },
    }),
  );
  gitOrThrow(clone, ["add", ".operad/dev.json"]);
  gitOrThrow(clone, ["-c", "user.name=test", "-c", "user.email=t@example.com", "commit", "-qm", "settings"]);
  gitOrThrow(clone, ["push", "origin", "main"]);
  gitOrThrow(remote.seed, ["pull", "-q", "origin", "main"]);
  const plan = await addPlan(store, { repository, slug: "plan", title: "Plan", request: "do the work" });
  const task = await addTask(store, { plan: plan.id, slug: "task", title: "Task", brief: "Write the worker file." });
  const taskId = task.id.slice(task.id.indexOf("/") + 1);
  const registry = new PluginRegistry(
    [createChatPlugin(), createDevPlugin(), createPoolPlugin(), fakeHarness()],
    { home: root, cwd: clone, store },
  );
  return { root, remote, repository, clone, taskKey: task.id, taskId, branch: `work/${taskId}`, registry, store };
}

function step(state: Fixture, name: "worktree" | "work", runId: string) {
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

function branchOf(path: string): string {
  return gitOrThrow(path, ["symbolic-ref", "--short", "HEAD"]);
}

/** Runs the worktree step in a child process that kills itself at `point`. */
async function crashAt(state: Fixture, runId: string, point: string): Promise<void> {
  const child = Bun.spawn({
    cmd: [process.execPath, CRASH_CHILD, state.store.root, state.clone, state.taskKey, runId, point],
    // Not the repository: see the review crash test in gate.test.ts.
    cwd: dirname(CRASH_CHILD),
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  expect(child.signalCode).toBe("SIGKILL");
}

describe("dev/worktree with workIn branch", () => {
  test("switches the main clone to work/<id> from main and records where it started", async () => {
    const state = await fixture();
    const main = gitOrThrow(state.clone, ["rev-parse", "origin/main"]);
    const result = await step(state, "worktree", "run-1");
    expect(result.result).toBe("ready");
    expect(branchOf(state.clone)).toBe(state.branch);
    expect(gitOrThrow(state.clone, ["rev-parse", "HEAD"])).toBe(main);
    expect(existsSync(join(state.clone, ".operad-worktrees", state.taskId))).toBe(false);
    const task = await taskOf(state);
    expect(task.attempt?.worktree).toBe(state.clone);
    expect(task.attempt?.branch).toBe(state.branch);
    expect(task.attempt?.startBranch).toBe("main");
    expect(task.attempt?.inPlace).toBe(true);
    expect(task.attempt?.base).toBe(main);
  });

  test("a clone on another branch is recorded as the start and left alone otherwise", async () => {
    const state = await fixture();
    gitOrThrow(state.clone, ["switch", "-q", "-c", "feature"]);
    expect((await step(state, "worktree", "run-1")).result).toBe("ready");
    expect(branchOf(state.clone)).toBe(state.branch);
    expect((await taskOf(state)).attempt?.startBranch).toBe("feature");
    expect(git(state.clone, ["rev-parse", "--verify", "main"]).ok).toBe(true);
  });

  test("a clone with uncommitted changes refuses to start and names the files", async () => {
    const state = await fixture();
    writeFileSync(join(state.clone, "README.md"), "edited by the person\n");
    writeFileSync(join(state.clone, "notes.txt"), "mine\n");
    const result = await step(state, "worktree", "run-1");
    expect(result.result).toBe("failed");
    const message = String(result.data?.message);
    expect(message).toContain("uncommitted changes");
    expect(message).toContain("README.md");
    expect(message).toContain("notes.txt");
    expect(result.data?.files).toEqual(["README.md", "notes.txt"]);
    // Nothing moved: no branch, the person's files as they were.
    expect(branchOf(state.clone)).toBe("main");
    expect(git(state.clone, ["rev-parse", "--verify", state.branch]).ok).toBe(false);
    expect(readFileSync(join(state.clone, "README.md"), "utf8")).toBe("edited by the person\n");
    expect((await taskOf(state)).attempt?.startBranch).toBeUndefined();
  });

  test("a clone that is not on a branch refuses to start", async () => {
    const state = await fixture();
    gitOrThrow(state.clone, ["switch", "-q", "--detach"]);
    const result = await step(state, "worktree", "run-1");
    expect(result.result).toBe("failed");
    expect(String(result.data?.message)).toContain("not on a branch");
  });

  test("a branch kept from an earlier attempt is reused and main is merged into it", async () => {
    const state = await fixture();
    gitOrThrow(state.clone, ["switch", "-q", "-c", state.branch]);
    writeFileSync(join(state.clone, "kept.txt"), "kept\n");
    gitOrThrow(state.clone, ["add", "kept.txt"]);
    gitOrThrow(state.clone, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "kept"]);
    gitOrThrow(state.clone, ["switch", "-q", "main"]);
    await advanceMain(state.remote, "main-news.txt", "news\n");

    const result = await step(state, "worktree", "run-1");
    expect(result.result).toBe("ready");
    expect(branchOf(state.clone)).toBe(state.branch);
    expect(existsSync(join(state.clone, "kept.txt"))).toBe(true);
    expect(existsSync(join(state.clone, "main-news.txt"))).toBe(true);
    expect(result.data?.merged).toBeDefined();
    expect((await taskOf(state)).attempt?.startBranch).toBe("main");
  });

  test("a second visit with the clone on the task's branch merges main again and keeps the start", async () => {
    const state = await fixture();
    gitOrThrow(state.clone, ["switch", "-q", "-c", "feature"]);
    await step(state, "worktree", "run-1");
    await advanceMain(state.remote, "main-news.txt", "news\n");
    const again = await step(state, "worktree", "run-2");
    expect(again.result).toBe("ready");
    expect(existsSync(join(state.clone, "main-news.txt"))).toBe(true);
    const task = await taskOf(state);
    expect(task.attempts).toBe(2);
    expect(task.attempt?.startBranch).toBe("feature");
  });

  test("the person moving the clone to another branch between visits is not overridden", async () => {
    const state = await fixture();
    await step(state, "worktree", "run-1");
    gitOrThrow(state.clone, ["switch", "-q", "main"]);
    gitOrThrow(state.clone, ["switch", "-q", "-c", "elsewhere"]);
    // A replay of the first run: its recorded start is main.
    const result = await step(state, "worktree", "run-1");
    expect(result.result).toBe("failed");
    expect(String(result.data?.message)).toContain('started on "main"');
    expect(branchOf(state.clone)).toBe("elsewhere");
  });

  test("a crash before the switch: the same run records the start, then switches", async () => {
    const state = await fixture();
    await crashAt(state, "run-1", "before-switch");
    expect(branchOf(state.clone)).toBe("main");
    // The start was recorded before the clone moved.
    expect((await taskOf(state)).attempt?.startBranch).toBe("main");

    const result = await step(state, "worktree", "run-1");
    expect(result.result).toBe("ready");
    expect(branchOf(state.clone)).toBe(state.branch);
    const task = await taskOf(state);
    expect(task.attempts).toBe(1);
    expect(task.attempt?.startBranch).toBe("main");
  });

  test("a crash after the switch: the clone is on work/<id> and clean, the step goes on", async () => {
    const state = await fixture();
    await crashAt(state, "run-1", "after-switch");
    expect(branchOf(state.clone)).toBe(state.branch);
    expect(gitOrThrow(state.clone, ["status", "--porcelain"])).toBe("");

    const result = await step(state, "worktree", "run-1");
    expect(result.result).toBe("ready");
    expect(branchOf(state.clone)).toBe(state.branch);
    const task = await taskOf(state);
    expect(task.attempts).toBe(1);
    expect(task.attempt?.startBranch).toBe("main");
    expect(task.attempt?.worked).not.toBe(true);
  });

  test("a crash after the switch from another branch remembers that branch, not main", async () => {
    const state = await fixture();
    gitOrThrow(state.clone, ["switch", "-q", "-c", "feature"]);
    await crashAt(state, "run-1", "after-switch");
    const result = await step(state, "worktree", "run-1");
    expect(result.result).toBe("ready");
    expect((await taskOf(state)).attempt?.startBranch).toBe("feature");
  });

  test("a crash before the step saved its result, with edits already in the tree, keeps the edits", async () => {
    const state = await fixture();
    await crashAt(state, "run-1", "before-save");
    // The worker had already started when the process died: the tree is dirty.
    writeFileSync(join(state.clone, "worker.txt"), "half done\n");
    await advanceMain(state.remote, "main-news.txt", "news\n");

    const result = await step(state, "worktree", "run-1");
    expect(result.result).toBe("ready");
    expect(branchOf(state.clone)).toBe(state.branch);
    // The worker's file stays; main is not merged into a dirty tree.
    expect(readFileSync(join(state.clone, "worker.txt"), "utf8")).toBe("half done\n");
    expect(existsSync(join(state.clone, "main-news.txt"))).toBe(false);
    expect((await taskOf(state)).attempt?.startBranch).toBe("main");
  });

  test("a crash that left a merge open is reported as a conflict", async () => {
    const state = await fixture();
    await crashAt(state, "run-1", "after-switch");
    writeFileSync(join(state.clone, "README.md"), "task side\n");
    gitOrThrow(state.clone, ["add", "README.md"]);
    gitOrThrow(state.clone, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "task"]);
    await advanceMain(state.remote, "README.md", "main side\n");
    const merge = step(state, "worktree", "run-2");
    expect((await merge).result).toBe("conflict");
    expect(gitOrThrow(state.clone, ["diff", "--name-only", "--diff-filter=U"])).toBe("README.md");
    // Seen again by a replay: still the same conflict, nothing is lost.
    const replay = await step(state, "worktree", "run-2");
    expect(replay.result).toBe("conflict");
    expect(replay.data?.files).toEqual(["README.md"]);
  });

  test("the progress note never shows in the clone's status", async () => {
    const state = await fixture();
    await step(state, "worktree", "run-1");
    writeFileSync(join(state.clone, ".operad-progress.md"), "a note\n");
    expect(gitOrThrow(state.clone, ["status", "--porcelain"])).toBe("");
  });
});

describe("dev/reverify with workIn branch", () => {
  test("merges the moved main into the task's branch in the clone and keeps the start (T-0718)", async () => {
    const state = await fixture("commit");
    gitOrThrow(state.clone, ["switch", "-q", "-c", "feature"]);
    await step(state, "worktree", "run-1");
    await step(state, "work", "run-1");
    await advanceMain(state.remote, "main-news.txt", "news\n");

    const result = await state.registry.runStep("dev/reverify", {}, {
      runId: "run-2",
      object: { type: "task", id: state.taskKey, data: {} },
    });
    expect(result.result).toBe("ready");
    expect(branchOf(state.clone)).toBe(state.branch);
    expect(existsSync(join(state.clone, "main-news.txt"))).toBe(true);
    expect(existsSync(join(state.clone, ".operad-worktrees", state.taskId))).toBe(false);
    expect(gitOrThrow(state.clone, ["status", "--porcelain"])).toBe("");
    const task = await taskOf(state);
    expect(task.attempt?.worktree).toBe(state.clone);
    expect(task.attempt?.inPlace).toBe(true);
    expect(task.attempt?.startBranch).toBe("feature");
    expect(result.data?.merged).toBeDefined();
  });
});

describe("dev/work with workIn branch", () => {
  test("runs in the main clone on the task branch; dev commits what the worker left", async () => {
    const state = await fixture("leave");
    await step(state, "worktree", "run-1");
    const result = await step(state, "work", "run-1");
    expect(result.result).toBe("done");
    expect(branchOf(state.clone)).toBe(state.branch);
    expect(gitOrThrow(state.clone, ["status", "--porcelain"])).toBe("");
    expect(gitOrThrow(state.clone, ["log", "-1", "--format=%s"])).toContain(state.taskId);
    expect(readFileSync(join(state.clone, "worker.txt"), "utf8")).toBe("done\n");
    // The starting branch has no commit of the task.
    expect(git(state.clone, ["ls-tree", "-r", "--name-only", "main"]).out).not.toContain("worker.txt");
    const task = await taskOf(state);
    // Working in the clone is not reported as a change to the main checkout.
    expect(String(task.attempt?.finalMessage ?? "")).not.toContain("changed the main checkout");
    expect(JSON.stringify(result.data)).not.toContain("changed the main checkout");
  });

  test("the main checkout is not read before and after the worker (T-0718)", async () => {
    const state = await fixture("leave");
    await step(state, "worktree", "run-1");
    // The work step's own status reads: what the worker left, and what is
    // left after dev's commit. A snapshot of the main checkout before the
    // worker, or its comparison after, would each add one.
    const stub = silentGit(state.root, "status --porcelain", 0);
    try {
      expect((await step(state, "work", "run-1")).result).toBe("done");
      expect(stub.calls()).toBe(2);
    } finally {
      stub.restore();
    }
  });

  test("a worker that commits itself is accepted as before", async () => {
    const state = await fixture("commit");
    await step(state, "worktree", "run-1");
    const result = await step(state, "work", "run-1");
    expect(result.result).toBe("done");
    expect(gitOrThrow(state.clone, ["log", "-1", "--format=%s"])).toBe("worker work");
  });

  test("a stage that says the worker commits itself gets no commit from dev", async () => {
    const state = await fixture("leave");
    await step(state, "worktree", "run-1");
    const result = await state.registry.runStep("dev/work", {}, {
      runId: "run-1",
      object: { type: "task", id: state.taskKey, data: {} },
      params: { flowCommit: false },
    });
    expect(result.result).toBe("failed");
    expect(result.data?.reason).toBe("changes");
    expect(gitOrThrow(state.clone, ["status", "--porcelain"])).toContain("worker.txt");
  });

  test("a note the worker leaves is not committed and not a change", async () => {
    const state = await fixture("note");
    await step(state, "worktree", "run-1");
    const result = await step(state, "work", "run-1");
    expect(result.result).toBe("done");
    expect(gitOrThrow(state.clone, ["ls-tree", "-r", "--name-only", "HEAD"])).not.toContain(".operad-progress.md");
    expect(gitOrThrow(state.clone, ["status", "--porcelain"])).toBe("");
  });

  test("the work step refuses when the clone is not on the task's branch", async () => {
    const state = await fixture("leave");
    await step(state, "worktree", "run-1");
    gitOrThrow(state.clone, ["switch", "-q", "main"]);
    const result = await step(state, "work", "run-1");
    expect(result.result).toBe("failed");
    expect(result.data?.reason).toBe("no_worktree");
    expect(String(result.data?.message)).toContain(`not "${state.branch}"`);
    expect(existsSync(join(state.clone, "worker.txt"))).toBe(false);
  });
});
