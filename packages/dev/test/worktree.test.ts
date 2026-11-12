import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PluginRegistry } from "@operad-io/engine";
import { createShellPlugin } from "@operad-io/shell";
import {
  addPlan,
  addRepository,
  addTask,
  createDevPlugin,
  mergeInProgress,
  stepTestHooks,
  storeKey,
  taskData,
  validateDevSettings,
  type RepositoryData,
} from "../src/index.ts";
import {
  advanceMain,
  commitIn,
  git,
  gitOrThrow,
  makeRemote,
  type RemoteSetup,
} from "./git-support.ts";
import {
  cleanupTempRoots,
  guardLockHandles,
  storeAt,
  tempRoot,
} from "./support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const CANCEL_CHILD = fileURLToPath(
  new URL("./fixtures/schedule-cancel-child.ts", import.meta.url),
);

interface Fixture {
  readonly root: string;
  readonly remote: RemoteSetup;
  readonly repository: RepositoryData;
  readonly taskKey: string;
  readonly taskId: string;
  readonly registry: PluginRegistry;
  readonly store: ReturnType<typeof storeAt>;
}

async function fixture(): Promise<Fixture> {
  const root = await tempRoot();
  const remote = await makeRemote(root);
  const store = storeAt(root);
  const repository = await addRepository(store, {
    path: remote.repository,
    name: "repository",
  });
  const plan = await addPlan(store, {
    repository,
    slug: "plan",
    title: "Plan",
    request: "do the work",
  });
  const task = await addTask(store, {
    plan: plan.id,
    slug: "task",
    title: "Task",
    brief: "Change the README.",
  });
  const registry = new PluginRegistry([createDevPlugin(), createShellPlugin()], {
    home: root,
    cwd: remote.repository,
    store,
  });
  return {
    root,
    remote,
    repository,
    taskKey: task.id,
    taskId: task.id.slice(task.id.indexOf("/") + 1),
    registry,
    store,
  };
}

function worktreeOf(state: Fixture): string {
  return join(state.remote.repository, ".operad-worktrees", state.taskId);
}

function runWorktree(state: Fixture, runId: string) {
  return state.registry.runStep("dev/worktree", {}, {
    runId,
    object: { type: "task", id: state.taskKey, data: {} },
  });
}

async function taskDataOf(state: Fixture) {
  const object = await state.store.get("task", state.taskKey);
  if (object === undefined) throw new Error("task disappeared");
  return taskData(object.data);
}

async function markReviewFailed(state: Fixture) {
  const current = await taskDataOf(state);
  await state.store.put(
    "task",
    state.taskKey,
    { ...current, reviewFailed: "- `a.ts:1` major: x" },
    "test",
  );
}

describe("dev/worktree", () => {
  test("creates a worktree from origin/main and records the attempt", async () => {
    const state = await fixture();
    const result = await runWorktree(state, "run-1");
    expect(result.result).toBe("ready");
    const path = worktreeOf(state);
    expect(existsSync(path)).toBe(true);
    expect(git(path, ["rev-parse", "--abbrev-ref", "HEAD"]).out).toBe(
      `work/${state.taskId}`,
    );

    const task = await taskDataOf(state);
    expect(task.phase).toBe("running");
    expect(task.attempts).toBe(1);
    expect(task.attempt?.worktree).toBe(path);
    expect(task.attempt?.branch).toBe(`work/${state.taskId}`);
    expect(task.attempt?.base).toBe(gitOrThrow(path, ["rev-parse", "HEAD"]));
    expect(result.data?.base).toBe(task.attempt?.base);
  });

  test("the run records itself and clears the manual start request", async () => {
    const state = await fixture();
    const current = await taskDataOf(state);
    await state.store.put(
      "task",
      state.taskKey,
      {
        ...current,
        phase: "running",
        run: null,
        startRequested: true,
        claim: { token: "claim-token", phase: "running" },
      },
      "test",
    );

    const result = await state.registry.runStep("dev/worktree", {}, {
      runId: "run-1",
      object: { type: "task", id: state.taskKey, data: {} },
      params: { token: "claim-token" },
    });
    expect(result.result).toBe("ready");
    const task = await taskDataOf(state);
    expect(task.run).toBe("run-1");
    expect(task.startRequested).toBe(false);
  });

  test("a run whose token does not match the claim writes nothing", async () => {
    const state = await fixture();
    const current = await taskDataOf(state);
    await state.store.put(
      "task",
      state.taskKey,
      {
        ...current,
        phase: "running",
        run: null,
        claim: { token: "current-token", phase: "running" },
      },
      "test",
    );

    const result = await state.registry.runStep("dev/worktree", {}, {
      runId: "run-stale",
      object: { type: "task", id: state.taskKey, data: {} },
      params: { token: "stale-token" },
    });
    expect(result.result).toBe("cancelled");
    expect((await taskDataOf(state)).phase).toBe("running");
    expect(existsSync(worktreeOf(state))).toBe(false);
  });

  test("a cancel that lands between the guard and the write is not overwritten", async () => {
    const state = await fixture();
    const current = await taskDataOf(state);
    await state.store.put(
      "task",
      state.taskKey,
      {
        ...current,
        phase: "running",
        run: null,
        claim: { token: "claim-token", phase: "running" },
      },
      "test",
    );

    // The step already passed its own claim check when the other process
    // cancels; the guarded write must re-read the task under the lock and
    // refuse instead of writing the stale `running` data back.
    stepTestHooks.beforeGuardedWrite = async () => {
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          CANCEL_CHILD,
          state.store.root,
          state.remote.repository,
          state.taskKey,
        ],
        cwd: state.remote.repository,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(0);
    };
    try {
      const result = await state.registry.runStep("dev/worktree", {}, {
        runId: "run-1",
        object: { type: "task", id: state.taskKey, data: {} },
        params: { token: "claim-token" },
      });
      expect(result.result).toBe("cancelled");
    } finally {
      stepTestHooks.beforeGuardedWrite = undefined;
    }

    const task = await taskDataOf(state);
    expect(task.phase).toBe("cancelled");
    expect(task.run).toBeNull();
  });

  test("reuses the worktree and merges the latest main into it", async () => {
    const state = await fixture();
    await runWorktree(state, "run-1");
    await advanceMain(state.remote, "main.txt", "moved\n");

    const result = await runWorktree(state, "run-2");
    expect(result.result).toBe("ready");
    const path = worktreeOf(state);
    expect(readFileSync(join(path, "main.txt"), "utf8")).toBe("moved\n");
    const task = await taskDataOf(state);
    expect(task.attempts).toBe(2);
  });

  test("a replay of the same run reuses the attempt number", async () => {
    const state = await fixture();
    await runWorktree(state, "run-1");
    const again = await runWorktree(state, "run-1");
    expect(again.result).toBe("ready");
    expect((await taskDataOf(state)).attempts).toBe(1);
  });

  test("a conflicting merge leaves the worktree mid-merge", async () => {
    const state = await fixture();
    await runWorktree(state, "run-1");
    const path = worktreeOf(state);
    await commitIn(path, "README.md", "# branch\n", "branch changes readme");
    await advanceMain(state.remote, "README.md", "# main\n", "main changes readme");

    const result = await runWorktree(state, "run-2");
    expect(result.result).toBe("conflict");
    expect(mergeInProgress(path)).toBe(true);
    expect(result.data?.files).toEqual(["README.md"]);
    expect((await taskDataOf(state)).attempt?.result).toBe("conflict");
  });

  test("a conflict with main resets the review-failed count; a clean merge keeps it", async () => {
    const state = await fixture();
    await runWorktree(state, "run-1");
    const path = worktreeOf(state);
    await commitIn(path, "README.md", "# branch\n", "branch changes readme");
    await markReviewFailed(state);
    await advanceMain(state.remote, "other.txt", "moved\n");
    expect((await runWorktree(state, "run-2")).result).toBe("ready");
    expect((await taskDataOf(state)).reviewFailed).toBeDefined();

    await advanceMain(state.remote, "README.md", "# main\n", "main changes readme");
    expect((await runWorktree(state, "run-3")).result).toBe("conflict");
    expect((await taskDataOf(state)).reviewFailed).toBeUndefined();
  });

  test("a directory that is not a worktree is refused, not reused", async () => {
    const state = await fixture();
    const path = worktreeOf(state);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "junk.txt"), "not a worktree\n");

    const result = await runWorktree(state, "run-1");
    expect(result.result).toBe("failed");
    expect(String(result.data?.message)).toContain("not a git worktree");
    expect((await taskDataOf(state)).attempts).toBe(1);
  });

  test("a work/<id> branch from an earlier attempt is reused", async () => {
    const state = await fixture();
    await runWorktree(state, "run-1");
    const path = worktreeOf(state);
    await commitIn(path, "branch.txt", "earlier work\n", "earlier work");
    const branchHead = gitOrThrow(path, ["rev-parse", "HEAD"]);
    gitOrThrow(path, ["push", "origin", `HEAD:refs/heads/work/${state.taskId}`]);
    gitOrThrow(state.remote.repository, ["worktree", "remove", "--force", path]);
    gitOrThrow(state.remote.repository, [
      "branch",
      "-D",
      `work/${state.taskId}`,
    ]);

    const result = await runWorktree(state, "run-2");
    expect(result.result).toBe("ready");
    expect(gitOrThrow(path, ["rev-parse", "HEAD"])).toBe(branchHead);
  });

  test("a remote work/<id> branch is reused after merging the latest main", async () => {
    const state = await fixture();
    await runWorktree(state, "run-1");
    const path = worktreeOf(state);
    await commitIn(path, "branch.txt", "earlier work\n", "earlier work");
    gitOrThrow(path, ["push", "origin", `HEAD:refs/heads/work/${state.taskId}`]);
    gitOrThrow(state.remote.repository, ["worktree", "remove", "--force", path]);
    gitOrThrow(state.remote.repository, [
      "branch",
      "-D",
      `work/${state.taskId}`,
    ]);
    await advanceMain(state.remote, "main.txt", "moved\n");

    const result = await runWorktree(state, "run-2");
    expect(result.result).toBe("ready");
    expect(readFileSync(join(path, "main.txt"), "utf8")).toBe("moved\n");
    expect(existsSync(join(path, "branch.txt"))).toBe(true);
  });

  test("a worktreeRoot that is a symlink out of the repository is refused", async () => {
    const state = await fixture();
    const outside = join(state.root, "outside-worktrees");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(state.remote.repository, ".operad-worktrees"));

    await expect(runWorktree(state, "run-1")).rejects.toThrow(/worktreeRoot:/);
    expect(existsSync(join(outside, state.taskId))).toBe(false);
  });

  test("prepare runs in the new worktree before the visit reports ready", async () => {
    const state = await fixture();
    writeFileSync(
      join(state.remote.repository, ".operad", "dev.json"),
      JSON.stringify({ prepare: ["pwd > .prepared-in"] }),
    );
    const result = await runWorktree(state, "run-1");
    expect(result.result).toBe("ready");
    const path = String(result.data?.path);
    expect(readFileSync(join(path, ".prepared-in"), "utf8").trim()).toBe(
      realpathSync(path),
    );
  });

  test("a failing prepare fails the worktree visit with its reason and log", async () => {
    const state = await fixture();
    writeFileSync(
      join(state.remote.repository, ".operad", "dev.json"),
      JSON.stringify({ prepare: ["echo nope >&2; exit 2"] }),
    );
    const result = await runWorktree(state, "run-1");
    expect(result.result).toBe("failed");
    expect(result.data?.reason).toBe("prepare failed");
    expect(readFileSync(String(result.data?.log), "utf8")).toContain("nope");
  });

  test("settings errors name the field", async () => {
    const state = await fixture();
    writeFileSync(
      join(state.remote.repository, ".operad", "dev.json"),
      JSON.stringify({ remote: 7 }),
    );
    await expect(runWorktree(state, "run-1")).rejects.toThrow(/remote:/);
  });

  test("a worktreeRoot outside the repository is refused", () => {
    expect(() =>
      validateDevSettings({ worktreeRoot: "/tmp/operad-worktrees" }),
    ).toThrow(/worktreeRoot:/);
    expect(() =>
      validateDevSettings({ worktreeRoot: "../../elsewhere" }),
    ).toThrow(/worktreeRoot:/);
  });

  test("settings written by an earlier version still load", async () => {
    const state = await fixture();
    writeFileSync(
      join(state.remote.repository, ".operad", "dev.json"),
      JSON.stringify({
        name: "repository",
        worktrees: ".legacy-worktrees/",
        sandbox: ".radian-sandbox/",
      }),
    );
    const result = await runWorktree(state, "run-1");
    expect(result.result).toBe("ready");
    expect(result.data?.path).toBe(
      join(state.remote.repository, ".legacy-worktrees", state.taskId),
    );
  });

  test("a missing settings file means the documented defaults", async () => {
    const state = await fixture();
    const path = join(state.remote.repository, ".operad", "dev.json");
    // The file repo add writes is the defaults; reading it back is the check.
    const settings = JSON.parse(readFileSync(path, "utf8")) as {
      readonly remote: string;
      readonly mainBranch: string;
      readonly worktreeRoot: string;
      readonly worker: { readonly use: string };
    };
    expect(settings.remote).toBe("origin");
    expect(settings.mainBranch).toBe("main");
    expect(settings.worktreeRoot).toBe(".operad-worktrees");
    expect(settings.worker.use).toBe("radian/agent");
  });
});

function runReverify(state: Fixture, runId: string) {
  return state.registry.runStep("dev/reverify", {}, {
    runId,
    object: { type: "task", id: state.taskKey, data: {} },
  });
}

describe("dev/reverify", () => {
  test("a branch behind a non-conflicting main merges it and goes to verify, no work", async () => {
    const state = await fixture();
    await runWorktree(state, "run-1");
    const path = worktreeOf(state);
    await commitIn(path, "branch.txt", "work\n", "branch work");
    await advanceMain(state.remote, "main.txt", "moved\n");
    const before = await taskDataOf(state);

    const result = await runReverify(state, "run-1");
    expect(result.result).toBe("ready");
    const mainSha = gitOrThrow(path, ["rev-parse", "--short", "origin/main"]);
    expect(result.data?.message).toBe(`reverify: merged main ${mainSha}, checking again`);
    expect(
      git(path, ["merge-base", "--is-ancestor", "origin/main", "HEAD"]).ok,
    ).toBe(true);
    const task = await taskDataOf(state);
    expect(task.attempts).toBe(before.attempts);
    expect(task.attempt?.number).toBe(before.attempt?.number);
    expect(JSON.stringify(task.attempt?.merged)).toContain(mainSha);
    expect(task.brief).toContain(`reverify: merged main ${mainSha}, checking again`);

    // The gate that follows checks the merged head, not the old branch tip.
    const settingsPath = join(state.remote.repository, ".operad", "dev.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as object;
    writeFileSync(
      settingsPath,
      JSON.stringify({
        ...settings,
        gate: { commands: ["test -f main.txt && test -f branch.txt"], commandTimeoutSecs: 60 },
      }),
    );
    const merged = gitOrThrow(path, ["rev-parse", "HEAD"]);
    const verified = await state.registry.runStep("dev/verify", {}, {
      runId: "run-1",
      object: { type: "task", id: state.taskKey, data: {} },
    });
    expect(verified.result).toBe("pass");
    expect(verified.data?.verified).toBe(merged);
    expect((await taskDataOf(state)).attempt?.verified).toBe(merged);
  });

  test("a conflicting main leaves the merge open and says so", async () => {
    const state = await fixture();
    await runWorktree(state, "run-1");
    const path = worktreeOf(state);
    await commitIn(path, "README.md", "# branch\n", "branch changes readme");
    await advanceMain(state.remote, "README.md", "# main\n", "main changes readme");

    const result = await runReverify(state, "run-1");
    expect(result.result).toBe("conflict");
    expect(mergeInProgress(path)).toBe(true);
    expect(result.data?.files).toEqual(["README.md"]);
    expect(result.data?.message).toBe("reverify: main conflicts, sending to work");
    expect((await taskDataOf(state)).brief).toContain(
      "reverify: main conflicts, sending to work",
    );
  });

  test("reverify keeps the review-failed count on a clean merge and resets it on a conflict", async () => {
    const state = await fixture();
    await runWorktree(state, "run-1");
    const path = worktreeOf(state);
    await commitIn(path, "README.md", "# branch\n", "branch changes readme");
    await markReviewFailed(state);
    await advanceMain(state.remote, "other.txt", "moved\n");
    expect((await runReverify(state, "run-1")).result).toBe("ready");
    expect((await taskDataOf(state)).reviewFailed).toBeDefined();

    await advanceMain(state.remote, "README.md", "# main\n", "main changes readme");
    expect((await runReverify(state, "run-1")).result).toBe("conflict");
    expect((await taskDataOf(state)).reviewFailed).toBeUndefined();
  });

  test("a main that has not moved adds no merge commit", async () => {
    const state = await fixture();
    await runWorktree(state, "run-1");
    const path = worktreeOf(state);
    await commitIn(path, "branch.txt", "work\n", "branch work");
    const head = gitOrThrow(path, ["rev-parse", "HEAD"]);

    const result = await runReverify(state, "run-1");
    expect(result.result).toBe("ready");
    expect(gitOrThrow(path, ["rev-parse", "HEAD"])).toBe(head);
    expect(result.data?.merged).toBeUndefined();
  });
});
