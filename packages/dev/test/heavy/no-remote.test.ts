/**
 * A repository with no git remote (T-0722): add, work, verify, integrate and the
 * replay all use the local main branch as the base and never fetch or push.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createChatPlugin } from "@operad-io/chat";
import { definePlugin, PluginRegistry, type PluginStepResult } from "@operad-io/engine";
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
import { taskViews } from "../../src/views.ts";
import { readDevSettings } from "../../src/settings.ts";
import { commitIn, gitOrThrow, silentGit } from "../git-support.ts";
import { cleanupTempRoots, guardLockHandles, storeAt, tempRoot } from "../support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const CHILD = fileURLToPath(new URL("../fixtures/integrate-child.ts", import.meta.url));

/** A worker that commits one file in its worktree. */
const worker = definePlugin({
  name: "fake-harness",
  kind: "harness",
  version: "0.0.0",
  steps: [
    {
      name: "agent",
      resumable: true,
      results: ["done", "failed", "interrupted", "waiting"],
      async run(_ctx, params): Promise<PluginStepResult> {
        const input = params as { readonly cwd: string };
        writeFileSync(join(input.cwd, "worker.txt"), "done\n");
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
        return { result: "done", data: { sessionId: "fake", cost: { micros: 1 }, usage: {} } };
      },
    },
  ],
});

interface Fixture {
  readonly root: string;
  readonly clone: string;
  readonly taskKey: string;
  readonly taskId: string;
  readonly registry: PluginRegistry;
  readonly store: ReturnType<typeof storeAt>;
}

/** A work tree with one commit on `main` and no remote, registered with a task. */
async function fixture(settings: Readonly<Record<string, unknown>> = {}): Promise<Fixture> {
  const root = await tempRoot();
  const clone = join(root, "repository");
  mkdirSync(clone, { recursive: true });
  gitOrThrow(clone, ["init", "-q", "-b", "main"]);
  await commitIn(clone, "README.md", "# test\n", "start");
  const store = storeAt(root);
  const repository = await addRepository(store, { path: clone, name: "repository" });
  writeFileSync(
    join(clone, ".operad", "dev.json"),
    JSON.stringify({
      name: "repository",
      mainBranch: "main",
      worker: { use: "fake-harness/agent", args: [] },
      gate: { commands: ["true"], commandTimeoutSecs: 60 },
      ...settings,
    }),
  );
  appendFileSync(join(clone, ".git", "info", "exclude"), ".operad/\n.operad-worktrees/\n");
  const plan = await addPlan(store, { repository, slug: "plan", title: "Plan", request: "do it" });
  const task = await addTask(store, { plan: plan.id, slug: "task", title: "Task", brief: "Do it." });
  await confirmPlan(store, plan.id);
  const registry = new PluginRegistry(
    [createChatPlugin(), createDevPlugin(), createPoolPlugin(), createShellPlugin(), worker],
    { home: root, cwd: clone, store },
  );
  return { root, clone, taskKey: task.id, taskId: task.id.slice(task.id.indexOf("/") + 1), registry, store };
}

function run(state: Fixture, name: string, runId: string) {
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

/** Worktree, work and verify, each of which names no remote. */
async function verified(state: Fixture): Promise<void> {
  const prepared = await run(state, "worktree", "worktree-run");
  if (prepared.result !== "ready") throw new Error(`worktree: ${JSON.stringify(prepared)}`);
  const worked = await run(state, "work", "work-run");
  if (worked.result !== "done") throw new Error(`work: ${JSON.stringify(worked)}`);
  const checked = await run(state, "verify", "verify-run");
  if (checked.result !== "pass") throw new Error(`verify: ${JSON.stringify(checked)}`);
}

function mainCommit(state: Fixture): string {
  return gitOrThrow(state.clone, ["rev-parse", "refs/heads/main"]);
}

describe("a repository with no remote", () => {
  test("add writes settings that name no remote, and the settings read as none", async () => {
    const state = await fixture();
    expect((await readDevSettings(state.clone)).remote).toBeUndefined();
    // The file the fixture replaced was the one add wrote: no `remote` key in it.
    const added = await readDevSettings(state.clone);
    expect(added.mainBranch).toBe("main");
  });

  test("a file that names no remote still means origin when the repository has one", async () => {
    const state = await fixture();
    expect((await readDevSettings(state.clone)).remote).toBeUndefined();
    gitOrThrow(state.clone, ["remote", "add", "origin", join(state.root, "elsewhere.git")]);
    // The settings are read again from the file: a new text key is not needed, the
    // remote's presence is checked on each read of a file that names none.
    writeFileSync(join(state.clone, ".operad", "dev.json"), JSON.stringify({ name: "repository", mainBranch: "main" }));
    expect((await readDevSettings(state.clone)).remote).toBe("origin");
    gitOrThrow(state.clone, ["remote", "remove", "origin"]);
    writeFileSync(join(state.clone, ".operad", "dev.json"), JSON.stringify({ name: "repository", mainBranch: "main", prepare: [] }));
    expect((await readDevSettings(state.clone)).remote).toBeUndefined();
    // A remote the file names stays, whether or not the repository has it.
    writeFileSync(join(state.clone, ".operad", "dev.json"), JSON.stringify({ name: "repository", remote: "upstream" }));
    expect((await readDevSettings(state.clone)).remote).toBe("upstream");
  });

  test("the init check passes when main exists locally and fails when it does not", async () => {
    const state = await fixture();
    const [passed] = await state.registry.checks();
    expect(passed).toEqual({ plugin: "dev", ok: true, message: "1 repositories checked" });
    writeFileSync(join(state.clone, ".operad", "dev.json"), JSON.stringify({ name: "repository", mainBranch: "trunk" }));
    const [failed] = await state.registry.checks();
    expect(failed?.ok).toBe(false);
    expect(failed?.message).toContain('no branch "trunk"');
  });

  test("worktree, work and verify never fetch or push, and the branch stays local", async () => {
    const state = await fixture();
    const fetches = silentGit(state.root, "fetch", 0);
    const pushes = silentGit(state.root, "push", 0);
    try {
      await verified(state);
    } finally {
      pushes.restore();
      fetches.restore();
    }
    expect(fetches.calls()).toBe(0);
    expect(pushes.calls()).toBe(0);
    expect(gitOrThrow(state.clone, ["branch", "--list", `work/${state.taskId}`])).not.toBe("");
    expect(gitOrThrow(state.clone, ["for-each-ref", "refs/remotes"])).toBe("");
    const task = await taskOf(state);
    expect(task.attempt?.verify?.result).toBe("pass");
  }, 60_000);

  test("the diff of a task is read against the local main branch", async () => {
    const state = await fixture();
    await verified(state);
    const object = await state.store.get("task", state.taskKey);
    if (object === undefined) throw new Error("task disappeared");
    const section = (await taskViews.load({ store: state.store } as never, object, "diff", {})) as {
      readonly markdown: string;
    };
    expect(section.markdown).toContain("worker.txt");
    expect(section.markdown).not.toContain("no diff to show");
  }, 60_000);

  test("integrate moves the local main branch and the clone on it follows", async () => {
    const state = await fixture();
    await verified(state);
    const result = await run(state, "integrate", "integrate-run");
    expect(result.result).toBe("merged");
    const merged = mainCommit(state);
    expect(gitOrThrow(state.clone, ["rev-parse", "HEAD"])).toBe(merged);
    expect(existsSync(join(state.clone, "worker.txt"))).toBe(true);
    expect(gitOrThrow(state.clone, ["status", "--porcelain"])).toBe("");
    const cleaned = await run(state, "cleanup", "cleanup-run");
    expect(cleaned.result).toBe("done");
    expect((await taskOf(state)).attempt?.cleanup?.failures).toEqual([]);
    expect(gitOrThrow(state.clone, ["branch", "--list", `work/${state.taskId}`])).toBe("");
  }, 60_000);

  test("a scheduled integrate asks nothing: no push leaves the machine", async () => {
    const state = await fixture();
    await verified(state);
    const asked: string[] = [];
    const result = await state.registry.runStep("dev/integrate", {}, {
      runId: "integrate-scheduled",
      object: { type: "task", id: state.taskKey, data: {} },
      trigger: { source: "cron", type: "tick", key: "t-scheduled", hops: 0 },
      asker: {
        ask: (request) => {
          asked.push(request.prompt);
          return Promise.resolve({ kind: "answered", answer: { choice: "reject_once" } });
        },
        useGrant: () => Promise.resolve(false),
      },
    });
    expect(result.result).toBe("merged");
    expect(asked).toEqual([]);
  }, 60_000);

  test("integrate with the clone on another branch moves main and leaves the clone alone", async () => {
    const state = await fixture();
    await verified(state);
    gitOrThrow(state.clone, ["switch", "-q", "-c", "elsewhere"]);
    const before = mainCommit(state);
    const result = await run(state, "integrate", "integrate-run");
    expect(result.result).toBe("merged");
    expect(mainCommit(state)).not.toBe(before);
    expect(gitOrThrow(state.clone, ["symbolic-ref", "--short", "HEAD"])).toBe("elsewhere");
    expect(
      gitOrThrow(state.clone, ["show", "refs/heads/main:worker.txt"]),
    ).toBe("done");
  }, 60_000);

  test("a main that does not fast-forward is refused, not overwritten", async () => {
    const state = await fixture();
    await verified(state);
    // A change in the clone that the merge would overwrite stops the move.
    writeFileSync(join(state.clone, "worker.txt"), "mine\n");
    const before = mainCommit(state);
    const result = await run(state, "integrate", "integrate-run");
    expect(result.result).toBe("failed");
    expect(mainCommit(state)).toBe(before);
    expect((await taskOf(state)).attempt?.integration?.message).toContain('cannot move "main"');
  }, 60_000);

  for (const point of ["pending-saved", "push", "merged-saved"]) {
    test(`a kill at ${point}, then a rerun, merges once`, async () => {
      const state = await fixture();
      await verified(state);
      const before = Number(gitOrThrow(state.clone, ["rev-list", "--count", "main"]));
      const child = Bun.spawn({
        cmd: [process.execPath, CHILD, state.store.root, state.clone, state.taskKey, "integrate-run", point, "dev/integrate", "1"],
        cwd: state.clone,
        stdout: "ignore",
        stderr: "ignore",
      });
      await child.exited;
      expect(child.signalCode).toBe("SIGKILL");
      const result = await run(state, "integrate", "integrate-run");
      expect(result.result).toBe("merged");
      // The worker's commit and the merge commit; a second merge would add more.
      expect(Number(gitOrThrow(state.clone, ["rev-list", "--count", "main"]))).toBe(before + 2);
      expect(gitOrThrow(state.clone, ["rev-parse", "HEAD"])).toBe(mainCommit(state));
      expect(gitOrThrow(state.clone, ["status", "--porcelain"])).toBe("");
    }, 60_000);
  }
});
