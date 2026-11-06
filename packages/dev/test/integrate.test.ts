import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FilePluginStore, PluginRegistry } from "@operad-io/engine";
import { createShellPlugin } from "@operad-io/shell";
import {
  addPlan,
  addRepository,
  addTask,
  confirmPlan,
  createDevPlugin,
  getPlan,
  planData,
  planState,
  schedulerTestHooks,
  setAuto,
  setTaskPhase,
  taskData,
  type IntegrationStyle,
  type TaskData,
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
afterEach(() => {
  schedulerTestHooks.write = undefined;
});
guardLockHandles();

const CHILD = fileURLToPath(
  new URL("./fixtures/integrate-child.ts", import.meta.url),
);

interface FixtureOptions {
  readonly style?: IntegrationStyle;
  readonly keyCommands?: readonly string[];
  readonly hooks?: readonly string[];
}

interface Fixture {
  readonly root: string;
  readonly remote: RemoteSetup;
  readonly store: ReturnType<typeof storeAt>;
  readonly registry: PluginRegistry;
  readonly planKey: string;
  readonly taskKey: string;
  readonly taskId: string;
  readonly worktree: string;
  readonly gate: string;
  readonly devJson: string;
}

function writeDevJson(
  repository: string,
  value: {
    readonly style?: IntegrationStyle;
    readonly keyCommands?: readonly string[];
    readonly hooks?: readonly string[];
  },
): void {
  mkdirSync(join(repository, ".operad"), { recursive: true });
  writeFileSync(
    join(repository, ".operad", "dev.json"),
    `${JSON.stringify(
      {
        name: "repository",
        gate: { commands: ["true"], commandTimeoutSecs: 60 },
        integration: {
          style: value.style ?? "merge",
          keyCommands: value.keyCommands ?? [],
        },
        ...(value.hooks === undefined ? {} : { hooks: { afterMerge: value.hooks } }),
      },
      null,
      2,
    )}\n`,
  );
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await tempRoot();
  const remote = await makeRemote(root);
  const store = storeAt(root);
  const repository = await addRepository(store, {
    path: remote.repository,
    name: "repository",
  });
  const devJson = join(remote.repository, ".operad", "dev.json");
  writeDevJson(remote.repository, options);
  const plan = await addPlan(store, {
    repository,
    slug: "plan",
    title: "Plan",
    request: "do the work",
  });
  const planKey = plan.id;
  const task = await addTask(store, {
    plan: plan.id,
    slug: "task",
    title: "Task",
    brief: "Make the code do the thing.",
  });
  await confirmPlan(store, plan.id);
  const registry = new PluginRegistry(
    [createDevPlugin(), createShellPlugin()],
    { home: root, cwd: remote.repository, store },
  );
  const taskKey = task.id;
  const taskId = taskKey.slice(taskKey.indexOf("/") + 1);
  const prepared = await registry.runStep("dev/worktree", {}, {
    runId: "worktree-run",
    object: { type: "task", id: taskKey, data: {} },
  });
  if (prepared.result !== "ready") {
    throw new Error(`worktree setup failed: ${JSON.stringify(prepared)}`);
  }
  const worktree = join(remote.repository, ".operad-worktrees", taskId);
  await commitIn(worktree, "code.txt", "line\n", "add code");
  // The work step pushes the branch in the real flow; cleanup deletes it.
  gitOrThrow(worktree, [
    "push",
    "origin",
    `HEAD:refs/heads/work/${taskId}`,
  ]);
  const verified = await registry.runStep("dev/verify", {}, {
    runId: "verify-run",
    object: { type: "task", id: taskKey, data: {} },
  });
  if (verified.result !== "pass") {
    throw new Error(`verify setup failed: ${JSON.stringify(verified)}`);
  }
  return {
    root,
    remote,
    store,
    registry,
    planKey,
    taskKey,
    taskId,
    worktree,
    gate: join(remote.repository, ".operad-worktrees", `${taskId}-gate`),
    devJson,
  };
}

function integrate(state: Fixture, runId = "integrate-run") {
  return state.registry.runStep("dev/integrate", {}, {
    runId,
    object: { type: "task", id: state.taskKey, data: {} },
  });
}

function cleanup(state: Fixture, runId = "cleanup-run") {
  return state.registry.runStep("dev/cleanup", {}, {
    runId,
    object: { type: "task", id: state.taskKey, data: {} },
  });
}

interface SchedulerState {
  readonly scheduler: PluginRegistry;
  readonly answers: { readonly runId: string; readonly choice: string }[];
  readonly lines: string[];
}

/** Puts the verified task at the person wait a passed review reaches, at auto merge. */
async function autoMergeScheduler(state: Fixture): Promise<SchedulerState> {
  await setAuto(state.store, state.planKey, "merge");
  await setTaskPhase(state.store, state.taskKey, "waiting", {
    run: "verify-run",
  });
  const object = await state.store.get("task", state.taskKey);
  if (object === undefined) throw new Error("task disappeared");
  const task = taskData(object.data);
  await state.store.put(
    "task",
    state.taskKey,
    {
      ...task,
      attempt: {
        ...task.attempt,
        run: "verify-run",
        review: { result: "pass", run: "verify-run" },
      },
    },
    "test",
  );
  const answers: { readonly runId: string; readonly choice: string }[] = [];
  const lines: string[] = [];
  schedulerTestHooks.write = (line) => lines.push(line);
  const scheduler = new PluginRegistry([createDevPlugin()], {
    home: state.root,
    cwd: state.remote.repository,
    store: state.store,
    onAnswer: async (runId, choice) => {
      answers.push({ runId, choice });
    },
  });
  return { scheduler, answers, lines };
}

async function taskOf(state: Fixture): Promise<TaskData> {
  const object = await state.store.get("task", state.taskKey);
  if (object === undefined) throw new Error("task disappeared");
  return taskData(object.data);
}

function remoteMain(state: Fixture): string {
  return gitOrThrow(state.remote.origin, ["rev-parse", "refs/heads/main"]);
}

describe("dev/integrate", () => {
  test("merge style lands a merge commit with the documented message", async () => {
    const state = await fixture({ style: "merge" });
    const verified = (await taskOf(state)).attempt?.verified ?? "";
    const result = await integrate(state);
    expect(result.result).toBe("merged");

    const task = await taskOf(state);
    expect(task.phase).toBe("merged");
    expect(task.attempt?.integration?.result).toBe("merged");
    expect(task.attempt?.integration?.verified).toBe(verified);
    expect(task.attempt?.integration?.headMoved).toBe(false);

    expect(gitOrThrow(state.remote.origin, ["show", "main:code.txt"])).toBe(
      "line",
    );
    expect(
      gitOrThrow(state.remote.origin, ["log", "-1", "--format=%s", "main"]),
    ).toBe(`Merge work/${state.taskId} (${verified.slice(0, 7)})`);
    expect(
      gitOrThrow(state.remote.origin, ["rev-list", "--parents", "-1", "main"])
        .split(" ").length,
    ).toBe(3);

    const plan = await getPlan(state.store, state.planKey);
    expect(planData(plan.data).mergedCount).toBe(1);
    expect(planState(planData(plan.data))).toBe("finished");
  });

  test("squash style lands one commit with the same message", async () => {
    const state = await fixture({ style: "squash" });
    const verified = (await taskOf(state)).attempt?.verified ?? "";
    const result = await integrate(state);
    expect(result.result).toBe("merged");

    expect(gitOrThrow(state.remote.origin, ["show", "main:code.txt"])).toBe(
      "line",
    );
    expect(
      gitOrThrow(state.remote.origin, ["log", "-1", "--format=%s", "main"]),
    ).toBe(`Merge work/${state.taskId} (${verified.slice(0, 7)})`);
    expect(
      gitOrThrow(state.remote.origin, ["rev-list", "--parents", "-1", "main"])
        .split(" ").length,
    ).toBe(2);
  });

  test("a conflict appends the conflict rework and leaves main alone", async () => {
    const state = await fixture({ style: "merge" });
    await advanceMain(state.remote, "code.txt", "main line\n", "main moves");
    const before = remoteMain(state);

    const result = await integrate(state);
    expect(result.result).toBe("conflict");
    expect(result.data?.files).toEqual(["code.txt"]);

    const task = await taskOf(state);
    expect(task.phase).toBe("running");
    expect(task.brief).toContain("## Rework 1 (conflict with main)");
    expect(task.brief).toContain("code.txt");
    expect(remoteMain(state)).toBe(before);
  });

  test("a main that moves between the fetch and the push is rebuilt", async () => {
    const state = await fixture({ style: "merge" });
    const marker = join(state.root, "main-moved");
    const seed = state.remote.seed;
    const moveOnce = [
      `if [ ! -f '${marker}' ]; then`,
      `  echo moved > '${seed}/moved.txt'`,
      `  git -C '${seed}' add moved.txt`,
      `  git -C '${seed}' -c user.name=test -c user.email=test@example.com commit -qm moved`,
      `  git -C '${seed}' push origin main`,
      `  touch '${marker}'`,
      `fi`,
    ].join("\n");
    writeDevJson(state.remote.repository, {
      style: "merge",
      keyCommands: [moveOnce],
    });

    const result = await integrate(state);
    expect(result.result).toBe("merged");
    expect(gitOrThrow(state.remote.origin, ["show", "main:code.txt"])).toBe(
      "line",
    );
    expect(gitOrThrow(state.remote.origin, ["show", "main:moved.txt"])).toBe(
      "moved",
    );
    expect((await taskOf(state)).phase).toBe("merged");
  });

  test("a failing key command sends the task back to work", async () => {
    const state = await fixture({
      style: "merge",
      keyCommands: ["echo nope >&2; exit 3"],
    });
    const before = remoteMain(state);
    const result = await integrate(state);
    expect(result.result).toBe("fail");
    expect(String(result.data?.message)).toContain("exited 3");

    const task = await taskOf(state);
    expect(task.phase).toBe("running");
    expect(task.brief).toContain("## Rework 1 (integration)");
    expect(task.brief).toContain("exit 3");
    expect(remoteMain(state)).toBe(before);
  });

  test("the verified sha is merged even after the branch head moves", async () => {
    const state = await fixture({ style: "merge" });
    const verified = (await taskOf(state)).attempt?.verified ?? "";
    await commitIn(state.worktree, "later.txt", "later\n", "branch moves");
    const moved = gitOrThrow(state.worktree, ["rev-parse", "HEAD"]);
    expect(moved).not.toBe(verified);

    const result = await integrate(state);
    expect(result.result).toBe("merged");
    expect(result.data?.headMoved).toBe(true);
    const task = await taskOf(state);
    expect(task.attempt?.integration?.head).toBe(moved);
    expect(task.attempt?.integration?.verified).toBe(verified);
    expect(gitOrThrow(state.remote.origin, ["show", "main:code.txt"])).toBe(
      "line",
    );
    expect(git(state.remote.origin, ["show", "main:later.txt"]).ok).toBe(false);
  });

  test("a remote that refuses the push is failed with git's message", async () => {
    const state = await fixture({ style: "merge" });
    const hooks = join(state.remote.origin, "hooks");
    mkdirSync(hooks, { recursive: true });
    const hook = join(hooks, "pre-receive");
    writeFileSync(
      hook,
      "#!/bin/sh\necho 'the remote refused this push' >&2\nexit 1\n",
    );
    chmodSync(hook, 0o755);
    const before = remoteMain(state);

    const result = await integrate(state);
    expect(result.result).toBe("failed");
    expect(String(result.data?.message)).toContain(
      "the remote refused this push",
    );
    expect((await taskOf(state)).phase).toBe("waiting");
    expect(remoteMain(state)).toBe(before);
  });

  test("a push that lands and reports an error is not pushed again", async () => {
    const state = await fixture({ style: "merge" });
    const checks = join(state.root, "checks");
    writeDevJson(state.remote.repository, {
      style: "merge",
      keyCommands: [`echo check >> '${checks}'`],
    });
    // The remote accepts the new main, then the client sees the push fail, as
    // when the answer is lost after the remote updated its ref.
    const wrapper = join(state.root, "receive-wrapper.sh");
    writeFileSync(
      wrapper,
      [
        "#!/bin/sh",
        'git-receive-pack "$@"',
        "status=$?",
        "echo 'the connection dropped after the remote accepted the push' >&2",
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(wrapper, 0o755);
    gitOrThrow(state.remote.repository, [
      "config",
      "remote.origin.receivepack",
      wrapper,
    ]);

    const result = await integrate(state);
    expect(result.result).toBe("merged");
    expect(result.data?.landed).toBe(true);
    expect(readFileSync(checks, "utf8").trim().split("\n")).toHaveLength(1);

    const task = await taskOf(state);
    expect(task.phase).toBe("merged");
    expect(task.attempt?.integration?.result).toBe("merged");
    expect(task.attempt?.integration?.pushed).toBe(true);
    expect(gitOrThrow(state.remote.origin, ["show", "main:code.txt"])).toBe(
      "line",
    );
    expect(
      gitOrThrow(state.remote.origin, ["rev-list", "--parents", "-1", "main"])
        .split(" ").length,
    ).toBe(3);
  });

  test("a kill after the push recovers with no second push", async () => {
    const state = await fixture({ style: "merge" });
    const pushes = join(state.root, "pushes");
    const hooks = join(state.remote.origin, "hooks");
    mkdirSync(hooks, { recursive: true });
    const hook = join(hooks, "pre-receive");
    writeFileSync(hook, `#!/bin/sh\necho push >> '${pushes}'\ncat >/dev/null\nexit 0\n`);
    chmodSync(hook, 0o755);

    const child = Bun.spawn({
      cmd: [
        process.execPath,
        CHILD,
        state.store.root,
        state.remote.repository,
        state.taskKey,
        "integrate-run",
      ],
      cwd: state.remote.repository,
      stdout: "ignore",
      stderr: "ignore",
    });
    await child.exited;
    expect(readFileSync(pushes, "utf8").trim().split("\n")).toHaveLength(1);
    expect((await taskOf(state)).phase).not.toBe("merged");

    // Recover in a fresh registry: the step reads the candidate it saved and
    // asks the remote instead of pushing the same commit again.
    const store = new FilePluginStore({ root: state.store.root });
    const registry = new PluginRegistry([createDevPlugin()], {
      home: state.root,
      cwd: state.remote.repository,
      store,
    });
    const recovered = await registry.runStep("dev/integrate", {}, {
      runId: "integrate-run",
      object: { type: "task", id: state.taskKey, data: {} },
    });
    expect(recovered.result).toBe("merged");
    expect(recovered.data?.replayed).toBe(true);
    expect(readFileSync(pushes, "utf8").trim().split("\n")).toHaveLength(1);
    expect((await taskOf(state)).phase).toBe("merged");
  });
});

describe("dev/cleanup", () => {
  test("the default hooks remove both worktrees and both branches", async () => {
    const state = await fixture({ style: "merge" });
    expect((await integrate(state)).result).toBe("merged");
    expect(existsSync(state.worktree)).toBe(true);
    expect(existsSync(state.gate)).toBe(true);

    const result = await cleanup(state);
    expect(result.result).toBe("done");
    expect(result.data?.failures).toBe(0);
    expect(existsSync(state.worktree)).toBe(false);
    expect(existsSync(state.gate)).toBe(false);
    expect((await taskOf(state)).phase).toBe("merged");
    expect(
      git(state.remote.repository, [
        "show-ref",
        "--verify",
        `refs/heads/work/${state.taskId}`,
      ]).ok,
    ).toBe(false);
    expect(
      git(state.remote.origin, [
        "show-ref",
        "--verify",
        `refs/heads/work/${state.taskId}`,
      ]).ok,
    ).toBe(false);
  });

  test("a worktree removed by hand is cleaned up, not a task failure", async () => {
    const state = await fixture({ style: "merge" });
    expect((await integrate(state)).result).toBe("merged");
    rmSync(state.worktree, { recursive: true, force: true });

    const result = await cleanup(state);
    expect(result.result).toBe("done");
    expect((await taskOf(state)).phase).toBe("merged");
    expect(existsSync(state.worktree)).toBe(false);
    expect(existsSync(state.gate)).toBe(false);
    expect(
      git(state.remote.origin, [
        "show-ref",
        "--verify",
        `refs/heads/work/${state.taskId}`,
      ]).ok,
    ).toBe(false);
  });

  test("a failing hook is recorded and the task stays merged", async () => {
    const state = await fixture({
      style: "merge",
      hooks: ["echo hook failed >&2; exit 7"],
    });
    expect((await integrate(state)).result).toBe("merged");

    const result = await cleanup(state);
    expect(result.result).toBe("done");
    expect(result.data?.failures).toBe(1);
    const failures = result.data?.failed as readonly {
      readonly line: number;
      readonly message: string;
    }[];
    expect(failures[0]?.line).toBe(1);
    expect(failures[0]?.message).toContain("exited 7");
    expect((await taskOf(state)).phase).toBe("merged");
  });
});

describe("dev scheduling reports the integration transition", () => {
  test("a refused push prints integrating -> waiting, never merged", async () => {
    const state = await fixture({ style: "merge" });
    const hooks = join(state.remote.origin, "hooks");
    mkdirSync(hooks, { recursive: true });
    const hook = join(hooks, "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho 'refused' >&2\nexit 1\n");
    chmodSync(hook, 0o755);

    const { scheduler, answers, lines } = await autoMergeScheduler(state);
    await scheduler.tick();
    expect(answers).toEqual([{ runId: "verify-run", choice: "merge" }]);
    expect(lines).toEqual([`${state.taskId} waiting -> integrating`]);

    const result = await integrate(state);
    expect(result.result).toBe("failed");
    expect((await taskOf(state)).phase).toBe("waiting");

    await scheduler.tick();
    expect(lines).toEqual([
      `${state.taskId} waiting -> integrating`,
      `${state.taskId} integrating -> waiting`,
    ]);
    expect(lines.some((line) => line.includes("merged"))).toBe(false);
  });

  test("a conflict prints integrating -> running, never merged", async () => {
    const state = await fixture({ style: "merge" });
    await advanceMain(state.remote, "code.txt", "main line\n", "main moves");

    const { scheduler, answers, lines } = await autoMergeScheduler(state);
    await scheduler.tick();
    expect(answers).toEqual([{ runId: "verify-run", choice: "merge" }]);

    const result = await integrate(state);
    expect(result.result).toBe("conflict");
    expect((await taskOf(state)).phase).toBe("running");

    await scheduler.tick();
    expect(lines).toEqual([
      `${state.taskId} waiting -> integrating`,
      `${state.taskId} integrating -> running`,
    ]);
    expect(lines.some((line) => line.includes("merged"))).toBe(false);
  });
});
