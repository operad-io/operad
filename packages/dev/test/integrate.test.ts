import { listAll } from "../src/model.ts";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { notCodeTestHooks } from "../src/notcode.ts";
import { IntegrationQueue } from "../src/integration-queue.ts";
import { validateDevSettings } from "../src/settings.ts";
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
  integrateTestHooks,
  planData,
  planState,
  schedulerTestHooks,
  setAuto,
  setTaskPhase,
  taskData,
  taskViews,
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
  readonly keyCommands?: readonly unknown[];
  readonly check?: Readonly<Record<string, number>>;
  readonly hooks?: readonly string[];
  /** Tasks of the same repository, verified like the first, that integrate with it. */
  readonly more?: number;
  readonly batch?: number;
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
  /** The tasks `more` asked for, each with its own worktree and verified commit. */
  readonly others: readonly Fixture[];
}

function writeDevJson(
  repository: string,
  value: {
    readonly style?: IntegrationStyle;
    readonly keyCommands?: readonly unknown[];
    readonly prepare?: readonly string[];
    readonly check?: Readonly<Record<string, number>>;
    readonly hooks?: readonly string[];
    readonly batch?: number;
  },
): void {
  mkdirSync(join(repository, ".operad"), { recursive: true });
  writeFileSync(
    join(repository, ".operad", "dev.json"),
    `${JSON.stringify(
      {
        name: "repository",
        ...(value.prepare === undefined ? {} : { prepare: value.prepare }),
        gate: { commands: ["true"], commandTimeoutSecs: 60 },
        integration: {
          style: value.style ?? "merge",
          keyCommands: value.keyCommands ?? [],
          ...(value.batch === undefined ? {} : { batch: value.batch }),
        },
        ...(value.check === undefined ? {} : { check: value.check }),
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
  // The settings file is local to the clone; keep it from making the tree dirty.
  appendFileSync(join(remote.repository, ".git", "info", "exclude"), ".operad/\n");
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
  const moreTasks = [];
  for (let index = 1; index <= (options.more ?? 0); index += 1) {
    moreTasks.push(
      await addTask(store, {
        plan: plan.id,
        slug: `task${index}`,
        title: `Task ${index}`,
        brief: "Make the code do another thing.",
      }),
    );
  }
  await confirmPlan(store, plan.id);
  const registry = new PluginRegistry(
    [createDevPlugin(), createShellPlugin()],
    { home: root, cwd: remote.repository, store },
  );
  const prepareTask = async (
    taskKey: string,
    file: string,
    suffix = "",
  ): Promise<Fixture> => {
    const taskId = taskKey.slice(taskKey.indexOf("/") + 1);
    const prepared = await registry.runStep("dev/worktree", {}, {
      runId: `worktree-run${suffix}`,
      object: { type: "task", id: taskKey, data: {} },
    });
    if (prepared.result !== "ready") {
      throw new Error(`worktree setup failed: ${JSON.stringify(prepared)}`);
    }
    const worktree = join(remote.repository, ".operad-worktrees", taskId);
    await commitIn(worktree, file, "line\n", "add code");
    // The work step pushes the branch in the real flow; cleanup deletes it.
    gitOrThrow(worktree, ["push", "origin", `HEAD:refs/heads/work/${taskId}`]);
    const verified = await registry.runStep("dev/verify", {}, {
      runId: `verify-run${suffix}`,
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
      others: [],
    };
  };
  const first = await prepareTask(task.id, "code.txt");
  const others: Fixture[] = [];
  for (const [index, other] of moreTasks.entries()) {
    others.push(await prepareTask(other.id, `code${index + 1}.txt`, `-${index + 1}`));
  }
  return { ...first, others };
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

function remoteRefs(state: Fixture): string {
  return gitOrThrow(state.remote.origin, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
  ]);
}

describe("dev/integrate", () => {
  test("merge style lands a merge commit with the documented message", async () => {
    const state = await fixture({ style: "merge" });
    const verified = (await taskOf(state)).attempt?.verified ?? "";
    const result = await integrate(state);
    expect(result.result).toBe("merged");

    const task = await taskOf(state);
    expect(task.phase).toBe("merged");
    expect(task.brief).toMatch(/\] merged as [0-9a-f]{7,}/);
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

  test("a merge marks a task that has notes, unless followups is false", async () => {
    for (const followups of [true, false]) {
      const state = await fixture();
      const dev = JSON.parse(readFileSync(state.devJson, "utf8"));
      writeFileSync(state.devJson, JSON.stringify({ ...dev, reviewer: { followups } }));
      const object = await state.store.get("task", state.taskKey);
      await state.store.put(
        "task",
        state.taskKey,
        {
          ...taskData(object?.data ?? {}),
          reviewNotes: [{ attempt: 1, round: 1, findings: [{ severity: "minor", file: "a.ts", line: 1, summary: "x" }] }],
        },
        "test",
      );
      expect((await integrate(state)).result).toBe("merged");
      expect((await taskOf(state)).followups?.state).toBe(followups ? "collect" : undefined);
    }
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
    expect(task.brief).toContain(
      "] rework 1 — conflict: conflicts with the latest main in code.txt",
    );
    expect(task.brief).toContain("code.txt");
    expect(task.attempt?.integrating).toBeNull();
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

  test("prepare runs in the integration checkout before the key commands", async () => {
    const state = await fixture({ style: "merge" });
    writeDevJson(state.remote.repository, {
      keyCommands: ["test -f .prepared"],
      prepare: ["touch .prepared"],
    });
    expect((await integrate(state)).result).toBe("merged");
  });

  test("a failing prepare fails the integration with its reason and log", async () => {
    const state = await fixture({ style: "merge" });
    writeDevJson(state.remote.repository, {
      keyCommands: ["true"],
      prepare: ["echo nope >&2; exit 2"],
    });
    const result = await integrate(state);
    expect(result.result).toBe("failed");
    expect(result.data?.reason).toBe("prepare failed");
    expect(readFileSync(String(result.data?.log), "utf8")).toContain("nope");
  });

  test("a key command that fails once and then passes lands with a note", async () => {
    const state = await fixture({ style: "merge" });
    const marker = join(state.root, "seen");
    writeDevJson(state.remote.repository, {
      style: "merge",
      keyCommands: [`if [ -f '${marker}' ]; then exit 0; fi; touch '${marker}'; exit 1`],
    });
    const result = await integrate(state);
    expect(result.result).toBe("merged");
    const task = await taskOf(state);
    expect(task.brief).toContain("] check line 1 failed, passed on rerun");
  });

  test("a failing integration check still proposes the flaky task, in the flaky-tests plan", async () => {
    const state = await fixture({ style: "merge" });
    const plan = await state.store.get("plan", state.planKey);
    await state.store.put("plan", state.planKey, { ...(plan?.data ?? {}), status: "draft" }, "test");
    writeDevJson(state.remote.repository, {
      style: "merge",
      check: { flakyTask: 1 },
      keyCommands: [
        {
          run: 'echo "(fail) a > flaky [1.00ms]" >&2; echo "(fail) b > broken [1.00ms]" >&2; exit 1',
          failed: { match: "^\\(fail\\) (.+?) \\[[0-9.]+m?s\\]$", rerun: "case {name} in *broken) exit 1;; esac" },
        },
      ],
    });
    const result = await integrate(state);
    expect(result.result).toBe("fail");
    expect(String(result.data?.message)).not.toContain("no task was proposed");
    const proposed = (await listAll(state.store, "task")).filter(
      (object) => String((object.data as { title?: unknown }).title) === "Fix the flaky test: a > flaky",
    );
    expect(proposed).toHaveLength(1);
    expect(String((proposed[0]?.data as { plan?: unknown } | undefined)?.plan)).toMatch(/-flaky-tests$/);
  });

  test("an integration check killed by a signal twice waits for a person, not for the worker", async () => {
    // Busy before and after the first run and while waiting, quiet before the
    // second run, busy again when that one ends.
    const readings = [18, 18, 18, 18, 2, 18];
    let reads = 0;
    notCodeTestHooks.load = () => ({
      load1: readings[Math.min(reads++, readings.length - 1)] ?? 18,
      cores: 10,
    });
    notCodeTestHooks.wait = async () => true;
    try {
      const state = await fixture({ style: "merge", keyCommands: ["exit 143"] });
      const before = remoteMain(state);
      const result = await integrate(state);
      expect(result.result).toBe("failed");
      const task = await taskOf(state);
      expect(task.phase).toBe("waiting");
      expect(task.brief).not.toContain("## Rework");
      expect(task.attempt?.integration?.notCode).toBe(
        "check was killed by SIGTERM twice under load 18 on 10 cores",
      );
      expect(remoteMain(state)).toBe(before);
    } finally {
      notCodeTestHooks.load = undefined;
      notCodeTestHooks.wait = undefined;
    }
  });

  test("a batch check that is not the code twice waits for a person and does not fall back", async () => {
    const root = await tempRoot();
    const count = join(root, "count");
    const state = await fixture({
      more: 1,
      batch: 2,
      check: { rerun: 0 },
      keyCommands: [
        `n=$(cat '${count}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${count}'; [ $n -le 2 ] && exit 143; exit 0`,
      ],
    });
    const follower = state.others[0];
    if (follower === undefined) throw new Error("task missing");
    // The leader's first check waits and reruns under the same high load; the
    // follower's later run is on a quiet machine.
    const readings = [18, 18, 18, 18, 18, 2, 18, 18, 18, 18, 18, 2, 18];
    let reads = 0;
    notCodeTestHooks.load = () => ({
      load1: readings[Math.min(reads++, readings.length - 1)] ?? 18,
      cores: 10,
    });
    notCodeTestHooks.wait = async () => true;
    const rings = bell();
    integrateTestHooks.wait = rings.wait;
    const queued = new Map([
      [state.taskId, signal()],
      [follower.taskId, signal()],
    ]);
    integrateTestHooks.queued = (task) => queued.get(task)?.resolve();
    const followerTurn = signal();
    const release = signal();
    integrateTestHooks.turnTaken = async (task) => {
      if (task === state.taskId) {
        await queued.get(follower.taskId)?.promise;
        return;
      }
      if (task === follower.taskId) {
        followerTurn.resolve();
        await release.promise;
      }
    };
    try {
      const leader = integrate(state, "integrate-run");
      await queued.get(state.taskId)?.promise;
      const followerRun = integrate(follower, "integrate-run-2");
      await queued.get(follower.taskId)?.promise;
      await rings.parked(1);
      const result = await leader;
      expect(result.result).toBe("failed");
      const task = await taskOf(state);
      expect(task.phase).toBe("waiting");
      expect(task.attempt?.integration?.notCode).toBe(
        "check was killed by SIGTERM twice under load 18 on 10 cores",
      );
      // The leader's two runs are all: it did not fall back and run again.
      expect(readFileSync(count, "utf8").trim()).toBe("2");
      rings.ring();
      await followerTurn.promise;
      expect(readFileSync(count, "utf8").trim()).toBe("2");
      release.resolve();
      expect((await followerRun).result).toBe("merged");
      expect(readFileSync(count, "utf8").trim()).toBe("3");
      expect(gitOrThrow(state.remote.origin, ["show", "main:code1.txt"])).toBe("line");
      expect(git(state.remote.origin, ["show", "main:code.txt"]).ok).toBe(false);
    } finally {
      release.resolve();
      notCodeTestHooks.load = undefined;
      notCodeTestHooks.wait = undefined;
    }
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
    const before = remoteRefs(state);

    const result = await integrate(state);
    expect(result.result).toBe("failed");
    expect(String(result.data?.message)).toContain(
      "the remote refused this push",
    );

    const object = await state.store.get("task", state.taskKey);
    if (object === undefined) throw new Error("task disappeared");
    const task = taskData(object.data);
    expect(task.phase).toBe("waiting");
    expect(task.attempt?.integration?.result).toBe("failed");
    expect(task.attempt?.integrating).toBeNull();
    expect(taskViews.row(object).mark).toBe("waiting");
    // The person sees the wait note next to the task: what failed, where, and
    // what git said. Nothing was pushed, so every remote ref is unchanged.
    const note = taskViews.row(object).note ?? "";
    expect(note).toContain('"origin"');
    expect(note).toContain('"main"');
    expect(note).toContain("the remote refused this push");
    expect(remoteRefs(state)).toBe(before);
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

async function killedAt(
  state: Fixture,
  point: string,
  step: "dev/integrate" | "dev/cleanup",
  runId: string,
  nth = 1,
): Promise<void> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      CHILD,
      state.store.root,
      state.remote.repository,
      state.taskKey,
      runId,
      point,
      step,
      String(nth),
    ],
    cwd: state.remote.repository,
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  expect(child.signalCode).toBe("SIGKILL");
}

/** A registry that has never seen the run, like a restarted process. */
function freshRegistry(state: Fixture): PluginRegistry {
  return new PluginRegistry([createDevPlugin(), createShellPlugin()], {
    home: state.root,
    cwd: state.remote.repository,
    store: new FilePluginStore({ root: state.store.root }),
  });
}

describe("dev/integrate rerun after a kill", () => {
  const points = [
    "candidate-built",
    "pending-saved",
    "push",
    "clone-followed",
    "merged-saved",
  ] as const;
  for (const style of ["merge", "squash"] as const) {
    for (const point of points) {
      test(`${style}: a kill at ${point}, then a rerun, merges once`, async () => {
        const state = await fixture({ style });
        const before = gitOrThrow(state.remote.origin, ["rev-list", "--count", "main"]);
        await killedAt(state, point, "dev/integrate", "integrate-run");

        const result = await freshRegistry(state).runStep("dev/integrate", {}, {
          runId: "integrate-run",
          object: { type: "task", id: state.taskKey, data: {} },
        });
        expect(result.result).toBe("merged");

        const task = await taskOf(state);
        expect(task.phase).toBe("merged");
        expect(task.attempt?.integration?.result).toBe("merged");
        // One commit on main for the task: a merge commit, or the squashed one.
        const added = Number(gitOrThrow(state.remote.origin, ["rev-list", "--count", "main"])) -
          Number(before);
        expect(added).toBe(style === "merge" ? 2 : 1);
        expect(
          gitOrThrow(state.remote.origin, [
            "log",
            "main",
            "--format=%s",
            `--grep=Merge work/${state.taskId}`,
          ]).split("\n").filter((line) => line.length > 0),
        ).toHaveLength(1);
        expect(gitOrThrow(state.remote.origin, ["show", "main:code.txt"])).toBe("line");
        // The brief says "merged as" once.
        expect(task.brief.split("merged as ").length - 1).toBe(1);
        // The main clone is fast-forwarded and clean.
        expect(gitOrThrow(state.remote.repository, ["rev-parse", "HEAD"])).toBe(
          remoteMain(state),
        );
        expect(gitOrThrow(state.remote.repository, ["status", "--porcelain"])).toBe("");
      }, 60_000);
    }
  }
});

describe("a batch leader killed after the push", () => {
  for (const style of ["merge", "squash"] as const) {
  test(`${style}: the leader and the tasks queued behind it each end merged once, on a fast-forwarded main clone`, async () => {
    const state = await fixture({ more: 2, batch: 3, style });
    const [second, third] = state.others;
    if (second === undefined || third === undefined) throw new Error("tasks missing");
    const queued = new Map([
      [second.taskId, signal()],
      [third.taskId, signal()],
    ]);
    integrateTestHooks.queued = (task) => queued.get(task)?.resolve();
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        CHILD,
        state.store.root,
        state.remote.repository,
        state.taskKey,
        "integrate-run",
        "push",
        "dev/integrate",
      ],
      cwd: state.remote.repository,
      env: { ...process.env, OPERAD_TEST_HOLD: "1", OPERAD_TEST_HOME: state.root },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("held\n");
      reader.releaseLock();
      const b = integrate(second, "integrate-run-2");
      await queued.get(second.taskId)?.promise;
      const c = integrate(third, "integrate-run-3");
      await queued.get(third.taskId)?.promise;
      child.stdin.write("go\n");
      await child.stdin.flush();
      await child.exited;
      expect(child.signalCode).toBe("SIGKILL");
      // The leader's push landed all three merges.
      expect(firstParentSubjects(state)).toHaveLength(4);

      expect((await b).result).toBe("merged");
      expect((await c).result).toBe("merged");
      const rerun = await freshRegistry(state).runStep("dev/integrate", {}, {
        runId: "integrate-run",
        object: { type: "task", id: state.taskKey, data: {} },
      });
      expect(rerun.result).toBe("merged");
    } finally {
      integrateTestHooks.queued = undefined;
      child.kill("SIGKILL");
    }

    // Main holds each task's merge once and nothing else.
    const subjects = firstParentSubjects(state);
    expect(subjects).toHaveLength(4);
    for (const task of [state, second, third]) {
      expect(subjects.filter((line) => line.startsWith(`Merge work/${task.taskId} (`))).toHaveLength(1);
      const data = await taskOf(task);
      expect(data.phase).toBe("merged");
      expect(data.brief.split("merged as ").length - 1).toBe(1);
      // The sha it reports is its own merge commit.
      const sha = /merged as ([0-9a-f]+)/.exec(data.brief)?.[1] ?? "";
      expect(gitOrThrow(state.remote.origin, ["log", "-1", "--format=%s", sha])).toStartWith(
        `Merge work/${task.taskId} (`,
      );
    }
    expect((await taskOf(state)).brief).toContain(
      `integrated in a batch with ${second.taskId}, ${third.taskId}`,
    );
    expect(gitOrThrow(state.remote.repository, ["rev-parse", "HEAD"])).toBe(remoteMain(state));
    expect(gitOrThrow(state.remote.repository, ["status", "--porcelain"])).toBe("");
  }, 60_000);
  }
});

describe("a candidate with nothing left to merge", () => {
  for (const style of ["merge", "squash"] as const) {
    test(`${style}: a change already on main under another message is already on main, not merged again`, async () => {
      const state = await fixture({ style });
      const scratch = join(state.root, "scratch");
      gitOrThrow(state.root, ["clone", "-q", state.remote.origin, scratch]);
      gitOrThrow(scratch, ["config", "user.email", "t@example.com"]);
      gitOrThrow(scratch, ["config", "user.name", "T"]);
      const branch = `origin/work/${state.taskId}`;
      gitOrThrow(scratch, [
        "merge",
        ...(style === "squash" ? ["--squash"] : ["--no-ff", "-m", "by hand"]),
        branch,
      ]);
      if (style === "squash") gitOrThrow(scratch, ["commit", "-q", "-m", "by hand"]);
      gitOrThrow(scratch, ["push", "-q", "origin", "HEAD:main"]);
      const byHand = gitOrThrow(scratch, ["rev-parse", "HEAD"]);
      const count = gitOrThrow(state.remote.origin, ["rev-list", "--count", "main"]);

      const result = await integrate(state);
      expect(result.data?.message ?? result.result).toBe("merged");
      expect(gitOrThrow(state.remote.origin, ["rev-list", "--count", "main"])).toBe(count);
      expect(remoteMain(state)).toBe(byHand);
      const task = await taskOf(state);
      expect(task.phase).toBe("merged");
      expect(task.brief).toContain(`already on main as ${byHand.slice(0, 7)}`);
      expect(task.brief).not.toContain("merged as ");
      expect(gitOrThrow(state.remote.repository, ["rev-parse", "HEAD"])).toBe(byHand);
    }, 60_000);
  }
});

describe("dev/cleanup rerun after a kill", () => {
  for (const nth of [1, 2, 3, 4, 5]) {
    test(`a kill after hook ${nth}, then a rerun, leaves nothing behind`, async () => {
      const state = await fixture({ style: "merge" });
      expect((await integrate(state)).result).toBe("merged");
      await killedAt(state, "hook-ran", "dev/cleanup", "cleanup-run", nth);

      const result = await freshRegistry(state).runStep("dev/cleanup", {}, {
        runId: "cleanup-run",
        object: { type: "task", id: state.taskKey, data: {} },
      });
      expect(result.result).toBe("done");
      expect(result.data?.failures).toBe(0);
      expect(existsSync(state.worktree)).toBe(false);
      expect(existsSync(state.gate)).toBe(false);
      expect(
        git(state.remote.repository, ["show-ref", "--verify", `refs/heads/work/${state.taskId}`]).ok,
      ).toBe(false);
      expect(
        git(state.remote.origin, ["show-ref", "--verify", `refs/heads/work/${state.taskId}`]).ok,
      ).toBe(false);
      const task = await taskOf(state);
      expect(task.phase).toBe("merged");
      expect(task.brief.split("merged as ").length - 1).toBe(1);
    }, 60_000);
  }
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

describe("dev/integrate main clone", () => {
  const cloneHead = (state: Fixture) =>
    gitOrThrow(state.remote.repository, ["rev-parse", "HEAD"]);

  test("a clean clone on the base branch fast-forwards", async () => {
    const state = await fixture();
    const result = await integrate(state);
    expect(result.result).toBe("merged");
    expect(cloneHead(state)).toBe(remoteMain(state));
    expect(
      readFileSync(join(state.remote.repository, "code.txt"), "utf8"),
    ).toBe("line\n");
    const clone = result.data?.mainClone as { updated: boolean } | undefined;
    expect(clone?.updated).toBe(true);
    expect((await taskOf(state)).brief).not.toContain("main clone not updated");
  });

  test("a dirty clone is left alone with the note", async () => {
    const state = await fixture();
    const before = cloneHead(state);
    writeFileSync(join(state.remote.repository, "README.md"), "edited\n");
    const result = await integrate(state);
    expect(result.result).toBe("merged");
    expect(cloneHead(state)).toBe(before);
    expect(readFileSync(join(state.remote.repository, "README.md"), "utf8")).toBe(
      "edited\n",
    );
    expect(result.data?.mainClone).toMatchObject({
      updated: false,
      note: "uncommitted changes",
    });
    expect((await taskOf(state)).brief).toContain(
      "main clone not updated: uncommitted changes",
    );
  });

  test("an untracked file makes the clone dirty and it is left alone", async () => {
    const state = await fixture();
    const before = cloneHead(state);
    writeFileSync(join(state.remote.repository, "scratch.txt"), "new\n");
    const result = await integrate(state);
    expect(result.result).toBe("merged");
    expect(cloneHead(state)).toBe(before);
    expect(result.data?.mainClone).toMatchObject({
      updated: false,
      note: "uncommitted changes",
    });
  });

  test("a clone on another branch is left alone", async () => {
    const state = await fixture();
    gitOrThrow(state.remote.repository, ["checkout", "-q", "-b", "other"]);
    const before = cloneHead(state);
    const result = await integrate(state);
    expect(result.result).toBe("merged");
    expect(cloneHead(state)).toBe(before);
    expect(gitOrThrow(state.remote.repository, ["branch", "--show-current"])).toBe(
      "other",
    );
    expect((await taskOf(state)).brief).toContain("main clone not updated");
  });

  test("a lockfile change runs the install in the clone, once, after the fast-forward", async () => {
    const state = await fixture();
    const calls: { cwd: string; cmd: readonly string[]; head: string }[] = [];
    integrateTestHooks.runCommand = (cwd, cmd) => {
      calls.push({ cwd, cmd, head: cloneHead(state) });
      return { ok: true, out: "" };
    };
    try {
      await commitIn(state.worktree, "bun.lock", "lock\n", "lock");
      gitOrThrow(state.worktree, ["push", "origin", `HEAD:refs/heads/work/${state.taskId}`]);
      const verified = await state.registry.runStep("dev/verify", {}, {
        runId: "verify-run-2",
        object: { type: "task", id: state.taskKey, data: {} },
      });
      expect(verified.result).toBe("pass");
      const result = await integrate(state);
      expect(result.result).toBe("merged");
      expect(calls).toEqual([
        {
          cwd: state.remote.repository,
          cmd: ["bun", "install", "--frozen-lockfile"],
          head: remoteMain(state),
        },
      ]);
      expect(result.data?.mainClone).toMatchObject({ updated: true, installed: true });
    } finally {
      integrateTestHooks.runCommand = undefined;
    }
  });

  test("no lockfile change runs no install, and a failed install is reported", async () => {
    const state = await fixture();
    let ran = 0;
    integrateTestHooks.runCommand = () => {
      ran += 1;
      return { ok: false, out: "boom" };
    };
    try {
      expect((await integrate(state)).result).toBe("merged");
      expect(ran).toBe(0);
    } finally {
      integrateTestHooks.runCommand = undefined;
    }
  });
});

const QUEUE_CHILD = fileURLToPath(
  new URL("./fixtures/queue-child.ts", import.meta.url),
);

/** A wait a test rings: the waiters park until `ring`, so nothing sleeps. */
function bell() {
  const parked: (() => void)[] = [];
  const listeners: { readonly count: number; readonly resolve: () => void }[] = [];
  return {
    wait: (): Promise<void> =>
      new Promise<void>((resolve) => {
        parked.push(resolve);
        for (const listener of [...listeners]) {
          if (parked.length >= listener.count) {
            listeners.splice(listeners.indexOf(listener), 1);
            listener.resolve();
          }
        }
      }),
    /** Resolves once `count` waiters are parked. */
    parked: (count: number): Promise<void> =>
      parked.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => listeners.push({ count, resolve })),
    ring: (): void => {
      for (const resolve of parked.splice(0)) resolve();
    },
  };
}

function signal() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  integrateTestHooks.queued = undefined;
  integrateTestHooks.turnTaken = undefined;
  integrateTestHooks.wait = undefined;
  integrateTestHooks.claimed = undefined;
});

function firstParentSubjects(state: Fixture): string[] {
  return gitOrThrow(state.remote.origin, [
    "log",
    "--first-parent",
    "--format=%s",
    "main",
  ]).split("\n");
}

describe("integration queue", () => {
  test("two tasks of one repository integrate one after the other, the second on the first's main, with no restart", async () => {
    const runs = (await tempRoot()) + "/key-runs";
    const state = await fixture({
      more: 1,
      keyCommands: [`echo run >> '${runs}'`],
    });
    const second = state.others[0];
    if (second === undefined) throw new Error("no second task");
    const rings = bell();
    integrateTestHooks.wait = rings.wait;
    const queued = new Map([
      [state.taskId, signal()],
      [second.taskId, signal()],
    ]);
    integrateTestHooks.queued = (task) => queued.get(task)?.resolve();
    // The first holds the turn until the second is in the queue behind it.
    integrateTestHooks.turnTaken = async (task) => {
      if (task === state.taskId) await queued.get(second.taskId)?.promise;
    };

    const first = integrate(state, "integrate-run");
    await queued.get(state.taskId)?.promise;
    const later = integrate(second, "integrate-run-2");
    await rings.parked(1);
    const waiting = await taskOf(second);
    expect(waiting.attempt?.integrationWait).toBe(`${state.taskId} is integrating`);
    const object = await second.store.get("task", second.taskKey);
    if (object === undefined) throw new Error("task disappeared");
    expect(taskViews.row(object).note).toBe(
      `$0.00 · waiting to integrate: ${state.taskId} is integrating`,
    );
    // A task cancelled while it waited no longer says it is waiting.
    const cancelled = { ...object, data: { ...object.data, phase: "cancelled" } };
    expect(taskViews.row(cancelled).note ?? "").not.toContain("waiting to integrate");

    expect((await first).result).toBe("merged");
    rings.ring();
    expect((await later).result).toBe("merged");

    // One key-command run each: the second never started over.
    expect(readFileSync(runs, "utf8").trim().split("\n")).toHaveLength(2);
    const subjects = firstParentSubjects(state);
    expect(subjects).toHaveLength(3);
    expect(subjects[0]).toStartWith(`Merge work/${second.taskId} (`);
    expect(subjects[1]).toStartWith(`Merge work/${state.taskId} (`);
    const merges = gitOrThrow(state.remote.origin, [
      "log",
      "--first-parent",
      "--format=%H",
      "-2",
      "main",
    ]).split("\n");
    const parent = gitOrThrow(state.remote.origin, ["rev-parse", `${merges[0]}^1`]);
    expect(parent).toBe(merges[1] ?? "");
    expect((await taskOf(second)).attempt?.integrationWait).toBeNull();
  });

  test("a turn is given back when its process dies", async () => {
    const root = await tempRoot();
    const repository = { name: "repository", path: "/r/repository" };
    const child = Bun.spawn({
      cmd: [process.execPath, QUEUE_CHILD, root, repository.name, repository.path, "T-dead"],
      stdout: "pipe",
      stderr: "inherit",
    });
    try {
      const reader = child.stdout.getReader();
      const chunk = await reader.read();
      expect(new TextDecoder().decode(chunk.value)).toBe("held\n");
      reader.releaseLock();

      const rings = bell();
      const said: string[] = [];
      const queue = new IntegrationQueue({
        home: root,
        repository,
        task: "T-live",
        run: "run",
        verified: "0".repeat(40),
        message: "Merge work/T-live",
        say: (line) => {
          said.push(line);
        },
        wait: rings.wait,
      });
      await queue.join();
      let turn: string | undefined;
      const waiting = queue.turn().then((result) => {
        turn = result.kind;
      });
      await rings.parked(1);
      expect(said).toEqual(["waiting to integrate: T-dead is integrating"]);
      expect(turn).toBeUndefined();

      child.kill("SIGKILL");
      await child.exited;
      rings.ring();
      await waiting;
      expect(turn).toBe("turn");
      queue.leave();
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  });

  test("with integration.batch 3 and three queued tasks, the key commands run once and three merge commits land in order", async () => {
    const runs = (await tempRoot()) + "/key-runs";
    const state = await fixture({
      more: 2,
      batch: 3,
      keyCommands: [`echo run >> '${runs}'`],
    });
    const [second, third] = state.others;
    if (second === undefined || third === undefined) throw new Error("tasks missing");
    const rings = bell();
    integrateTestHooks.wait = rings.wait;
    const queued = new Map([
      [state.taskId, signal()],
      [second.taskId, signal()],
      [third.taskId, signal()],
    ]);
    integrateTestHooks.queued = (task) => queued.get(task)?.resolve();
    integrateTestHooks.turnTaken = async (task) => {
      if (task !== state.taskId) return;
      await queued.get(second.taskId)?.promise;
      await queued.get(third.taskId)?.promise;
    };

    const first = integrate(state, "integrate-run");
    await queued.get(state.taskId)?.promise;
    const b = integrate(second, "integrate-run-2");
    await queued.get(second.taskId)?.promise;
    const c = integrate(third, "integrate-run-3");
    await rings.parked(2);

    expect((await first).result).toBe("merged");
    rings.ring();
    expect((await b).result).toBe("merged");
    expect((await c).result).toBe("merged");

    expect(readFileSync(runs, "utf8").trim().split("\n")).toHaveLength(1);
    const subjects = firstParentSubjects(state);
    expect(subjects).toHaveLength(4);
    expect(subjects[2]).toStartWith(`Merge work/${state.taskId} (`);
    expect(subjects[1]).toStartWith(`Merge work/${second.taskId} (`);
    expect(subjects[0]).toStartWith(`Merge work/${third.taskId} (`);
    for (const file of ["code.txt", "code1.txt", "code2.txt"]) {
      expect(gitOrThrow(state.remote.origin, ["show", `main:${file}`])).toBe("line");
    }
    const others = (task: Fixture): string => {
      const names = [state, second, third].filter((one) => one !== task).map((one) => one.taskId);
      return `integrated in a batch with ${names.join(", ")}`;
    };
    for (const task of [state, second, third]) {
      const data = await taskOf(task);
      expect(data.phase).toBe("merged");
      expect(data.brief).toContain(others(task));
    }
  });

  test("a failing key command in a batch falls back, and only that task goes back to its worker", async () => {
    const state = await fixture({
      more: 2,
      batch: 3,
      keyCommands: ["test ! -f code1.txt"],
    });
    const [second, third] = state.others;
    if (second === undefined || third === undefined) throw new Error("tasks missing");
    const rings = bell();
    integrateTestHooks.wait = rings.wait;
    const queued = new Map([
      [state.taskId, signal()],
      [second.taskId, signal()],
      [third.taskId, signal()],
    ]);
    integrateTestHooks.queued = (task) => queued.get(task)?.resolve();
    integrateTestHooks.turnTaken = async (task) => {
      if (task !== state.taskId) return;
      await queued.get(second.taskId)?.promise;
      await queued.get(third.taskId)?.promise;
    };

    const first = integrate(state, "integrate-run");
    await queued.get(state.taskId)?.promise;
    const b = integrate(second, "integrate-run-2");
    await queued.get(second.taskId)?.promise;
    const c = integrate(third, "integrate-run-3");
    await rings.parked(2);

    expect((await first).result).toBe("merged");
    await rings.parked(2);
    rings.ring();
    expect((await b).result).toBe("fail");
    await rings.parked(1);
    rings.ring();
    expect((await c).result).toBe("merged");

    expect(gitOrThrow(state.remote.origin, ["show", "main:code.txt"])).toBe("line");
    expect(gitOrThrow(state.remote.origin, ["show", "main:code2.txt"])).toBe("line");
    expect(git(state.remote.origin, ["cat-file", "-e", "main:code1.txt"]).ok).toBe(false);
    const sent = await taskOf(second);
    expect(sent.phase).toBe("running");
    expect(sent.brief).toContain("## Rework 1 (integration)");
    for (const task of [state, third]) {
      const data = await taskOf(task);
      expect(data.phase).toBe("merged");
      expect(data.brief).not.toContain("integrated in a batch");
    }
  });
});

describe("a task that leaves a batch", () => {
  test("a claimed task that is cancelled is not merged, and the others land one by one", async () => {
    const state = await fixture({
      more: 2,
      batch: 3,
      keyCommands: ["true"],
    });
    const [second, third] = state.others;
    if (second === undefined || third === undefined) throw new Error("tasks missing");
    const rings = bell();
    integrateTestHooks.wait = rings.wait;
    const queued = new Map([
      [state.taskId, signal()],
      [second.taskId, signal()],
      [third.taskId, signal()],
    ]);
    integrateTestHooks.queued = (task) => queued.get(task)?.resolve();
    const cancelled = new AbortController();
    const claimed = signal();
    const release = signal();
    // The leader's checks end only after the second task has been cancelled.
    integrateTestHooks.turnTaken = async (task) => {
      if (task !== state.taskId) return;
      await queued.get(second.taskId)?.promise;
      await queued.get(third.taskId)?.promise;
    };
    integrateTestHooks.claimed = async () => {
      claimed.resolve();
      await release.promise;
    };

    const first = integrate(state, "integrate-run");
    await queued.get(state.taskId)?.promise;
    const b = second.registry.runStep("dev/integrate", {}, {
      runId: "integrate-run-2",
      object: { type: "task", id: second.taskKey, data: {} },
      signal: cancelled.signal,
    });
    await queued.get(second.taskId)?.promise;
    const c = integrate(third, "integrate-run-3");
    await rings.parked(2);
    await claimed.promise;
    cancelled.abort();
    rings.ring();
    expect((await b).result).toBe("cancelled");
    release.resolve();

    expect((await first).result).toBe("merged");
    await rings.parked(1);
    rings.ring();
    expect((await c).result).toBe("merged");

    expect(git(state.remote.origin, ["cat-file", "-e", "main:code1.txt"]).ok).toBe(false);
    expect(gitOrThrow(state.remote.origin, ["show", "main:code2.txt"])).toBe("line");
    expect(firstParentSubjects(state)).toHaveLength(3);
    // No ticket is left behind for the task that went.
    const queue = new IntegrationQueue({
      home: state.root,
      repository: { name: "repository", path: state.remote.repository },
      task: "T-probe",
      run: "run",
      verified: "0".repeat(40),
      message: "m",
      say: () => {},
    });
    expect(queue.tickets()).toEqual([]);
  });
});

describe("a claimed task that leaves the queue", () => {
  test("a batch that falls back does not write its ticket back", async () => {
    const root = await tempRoot();
    const repository = { name: "repository", path: "/r/repository" };
    const make = (task: string) =>
      new IntegrationQueue({
        home: root,
        repository,
        task,
        run: "run",
        verified: "0".repeat(40),
        message: `Merge work/${task}`,
        say: () => {},
      });
    const [a, b, c] = [make("T-a"), make("T-b"), make("T-c")];
    await a.join();
    await b.join();
    await c.join();
    const followers = a.claim(3);
    expect(followers.map((ticket) => ticket.task)).toEqual(["T-b", "T-c"]);
    b.leave();
    expect(a.stillQueued(followers).map((ticket) => ticket.task)).toEqual(["T-c"]);
    a.fallBack(followers);
    expect(a.tickets().map((ticket) => ticket.task)).toEqual(["T-a", "T-c"]);
    expect(a.tickets()[1]?.solo).toBe(true);
    a.leave();
    expect((await c.turn()).kind).toBe("turn");
    c.leave();
    expect(a.tickets()).toEqual([]);
  });
});

describe("a claimed task aborted after the leader's push", () => {
  test("reports the merge that is on main, not a cancel", async () => {
    const root = await tempRoot();
    const repository = { name: "repository", path: "/r/repository" };
    const cancelled = new AbortController();
    const make = (task: string, abort?: AbortSignal) =>
      new IntegrationQueue({
        home: root,
        repository,
        task,
        run: "run",
        verified: "0".repeat(40),
        message: `Merge work/${task}`,
        say: () => {},
        ...(abort === undefined ? {} : { signal: abort }),
      });
    const [a, b] = [make("T-a"), make("T-b", cancelled.signal)];
    await a.join();
    await b.join();
    a.claim(2);
    a.publish({
      base: "1".repeat(40),
      head: "2".repeat(40),
      members: [{ task: "T-b", sha: "2".repeat(40) }],
    });
    a.finish();
    cancelled.abort();
    expect((await b.turn()).kind).toBe("batched");
  });
});

describe("integration.batch setting", () => {
  test("is an integer of 1 or more, and 1 when unset", () => {
    expect(validateDevSettings({ name: "r" }).integration.batch).toBe(1);
    expect(
      validateDevSettings({ name: "r", integration: { batch: 3 } }).integration.batch,
    ).toBe(3);
    for (const bad of [0, 1.5, "3"]) {
      expect(() =>
        validateDevSettings({ name: "r", integration: { batch: bad } }),
      ).toThrow("integration.batch");
    }
  });
});
