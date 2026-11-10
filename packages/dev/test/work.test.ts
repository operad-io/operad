import { createPoolPlugin } from "@operad-io/pool";
import { FilePlaces } from "@operad-io/pool";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  definePlugin,
  PluginRegistry,
  type PluginStepResult,
} from "@operad-io/engine";
import {
  addPlan,
  addRepository,
  addTask,
  createDevPlugin,
  MAX_WORK_WAITS,
  reviewTestHooks,
  taskData,
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

const FAKE_COST_MICROS = 2_500_000;

function fakeHarness(record: string) {
  return definePlugin({
    name: "fake-harness",
    kind: "harness",
    version: "0.0.0",
    steps: [
      {
        name: "agent",
        results: ["done", "failed", "interrupted"],
        async run(ctx, params): Promise<PluginStepResult> {
          const input = params as {
            readonly prompt: string;
            readonly cwd: string;
            readonly args?: readonly string[];
            readonly resumeSession?: string;
          };
          // Mirror harness-radian: an absent args falls back to the flow's.
          const flow =
            typeof ctx.params === "object" &&
            ctx.params !== null &&
            !Array.isArray(ctx.params)
              ? (ctx.params as Readonly<Record<string, unknown>>)
              : undefined;
          const flowArgs = Array.isArray(flow?.args)
            ? (flow.args as readonly unknown[])
            : undefined;
          const args: readonly unknown[] = input.args ?? flowArgs ?? [];
          const mode = typeof args[0] === "string" ? args[0] : "nothing";
          writeFileSync(
            record,
            JSON.stringify({
              prompt: input.prompt,
              cwd: input.cwd,
              args,
              resumeSession: input.resumeSession ?? null,
            }),
          );
          if (mode === "fail") {
            return {
              result: "failed",
              data: {
                sessionId: "fake-session",
                cost: { micros: FAKE_COST_MICROS },
                message: "the fake harness said no",
              },
            };
          }
          if (mode === "unavailable" || mode === "usage_limit") {
            return {
              result: "failed",
              data: {
                sessionId: "fake-session",
                message: "the model is busy",
                modelError: { kind: mode },
              },
            };
          }
          if (mode === "dirty-fail") {
            writeFileSync(join(input.cwd, "dirty.txt"), "not committed\n");
            return {
              result: "failed",
              data: {
                sessionId: "fake-session",
                cost: { micros: FAKE_COST_MICROS },
                message: "the fake harness left work behind",
              },
            };
          }
          if (mode === "commit" || mode === "commit-words" || mode === "commit-standard" || mode === "commit-incomplete" || mode === "commit-broken") {
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
          }
          if (mode === "dirty") {
            writeFileSync(join(input.cwd, "dirty.txt"), "not committed\n");
          }
          if (mode === "reset") {
            gitOrThrow(input.cwd, ["reset", "--hard", "HEAD~1"]);
          }
          if (mode === "commit-standard" || mode === "commit-incomplete") {
            return {
              result: "done",
              data: {
                sessionId: "fake-session",
                usage: {
                  harness: "fake",
                  model: null,
                  tokens: { input: 40, output: 9, cacheread: 0, cachewrite: 0 },
                  costMicros: FAKE_COST_MICROS,
                  costQuality: mode === "commit-incomplete" ? "incomplete" : "exact",
                },
              },
            };
          }
          if (mode === "commit-broken") {
            return {
              result: "done",
              data: { sessionId: "fake-session", usage: { harness: "fake", tokens: {} } },
            };
          }
          // The shape before `usage` was standard; facts like it are still read.
          return {
            result: "done",
            data: {
              sessionId: "fake-session",
              ...(mode === "commit-words"
                ? { finalMessage: "Changed things.\nNew words: reviewer.first.use, `stallSecs`" }
                : {}),
              cost: { micros: FAKE_COST_MICROS },
              usage: {},
            },
          };
        },
      },
    ],
  });
}

interface Fixture {
  readonly root: string;
  readonly remote: RemoteSetup;
  readonly taskKey: string;
  readonly taskId: string;
  readonly registry: PluginRegistry;
  readonly record: string;
  readonly store: ReturnType<typeof storeAt>;
}

interface FixtureOptions {
  readonly workerUse?: string;
  /** Written as `workers` and `pools` instead of the single `worker`. */
  readonly workers?: Readonly<Record<string, unknown>>;
  readonly pools?: Readonly<Record<string, unknown>>;
  readonly args?: readonly string[];
  readonly workerBrief?: string;
  /** Extra plugins to load next to dev and the fake harness. */
  readonly plugins?: readonly unknown[];
}

async function fixture(
  mode: string,
  options: FixtureOptions = {},
): Promise<Fixture> {
  const root = await tempRoot();
  const remote = await makeRemote(root);
  const store = storeAt(root);
  const repository = await addRepository(store, {
    path: remote.repository,
    name: "repository",
  });
  const record = join(root, "record.json");
  writeFileSync(
    join(remote.repository, ".operad", "dev.json"),
    JSON.stringify(
      {
        name: "repository",
        remote: "origin",
        mainBranch: "main",
        worktreeRoot: ".operad-worktrees",
        ...(options.workers === undefined
          ? {
              worker: {
                use: options.workerUse ?? "fake-harness/agent",
                args: options.args ?? [mode],
              },
            }
          : {
              workers: options.workers,
              ...(options.pools === undefined ? {} : { pools: options.pools }),
            }),
        workerBrief: ".operad/worker-brief.md",
      },
      null,
      2,
    ),
  );
  if (options.workerBrief !== undefined) {
    writeFileSync(
      join(remote.repository, ".operad", "worker-brief.md"),
      options.workerBrief,
    );
  }
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
    brief: [
      "Write the worker file.",
      "",
      "## Rework 1 (review)",
      "",
      "Add the detail the review asked for.",
    ].join("\n"),
  });
  const plugins = [
    createDevPlugin(),
    createPoolPlugin(),
    fakeHarness(record),
    ...(options.plugins ?? []),
  ];
  const registry = new PluginRegistry(plugins, {
    home: root,
    cwd: remote.repository,
    store,
  });
  const state: Fixture = {
    root,
    remote,
    taskKey: task.id,
    taskId: task.id.slice(task.id.indexOf("/") + 1),
    registry,
    record,
    store,
  };
  const worktree = await registry.runStep("dev/worktree", {}, {
    runId: "worktree-run",
    object: { type: "task", id: task.id, data: {} },
  });
  if (worktree.result !== "ready") {
    throw new Error(`worktree setup failed: ${JSON.stringify(worktree)}`);
  }
  return state;
}

function runWork(
  state: Fixture,
  runId = "work-run",
  onEvent: (plugin: string, type: string) => void = () => undefined,
) {
  return state.registry.runStep("dev/work", {}, {
    runId,
    object: { type: "task", id: state.taskKey, data: {} },
    emit: (plugin, event) => {
      onEvent(plugin, event.type);
    },
  });
}

function readRecord(state: Fixture): {
  readonly prompt: string;
  readonly cwd: string;
} {
  return JSON.parse(readFileSync(state.record, "utf8")) as {
    readonly prompt: string;
    readonly cwd: string;
  };
}

async function taskDataOf(state: Fixture) {
  const object = await state.store.get("task", state.taskKey);
  if (object === undefined) throw new Error("task disappeared");
  return taskData(object.data);
}

describe("dev/work", () => {
  test("the standard usage gives the row's cost and the tokens", async () => {
    const state = await fixture("commit-standard");
    const result = await runWork(state);
    expect(result.result).toBe("done");
    const task = await taskDataOf(state);
    expect(task.attempt?.cost).toBe(2.5);
    expect(task.attempt?.costMicros).toBe(2_500_000);
    expect(task.attempt?.tokens).toEqual({ input: 40, output: 9 });
    expect(task.cost).toBe(2.5);
    expect(task.attempt?.costQuality).toBe("exact");
  });

  test("an incomplete cost is recorded as incomplete", async () => {
    const state = await fixture("commit-incomplete");
    await runWork(state);
    const task = await taskDataOf(state);
    expect(task.attempt?.costQuality).toBe("incomplete");
    expect(task.costQuality).toBe("incomplete");
  });

  test("the New words line of the final answer is kept on the attempt", async () => {
    const state = await fixture("commit-words");
    await runWork(state);
    expect((await taskDataOf(state)).attempt?.workWords).toEqual([
      "reviewer.first.use",
      "stallSecs",
    ]);
    const none = await fixture("commit");
    await runWork(none);
    expect((await taskDataOf(none)).attempt?.workWords).toEqual([]);
  });

  test("a usage that is not standard is ignored and logged with the run", async () => {
    const state = await fixture("commit-broken");
    await runWork(state);
    const task = await taskDataOf(state);
    expect(task.attempt?.cost).toBeNull();
  });

  test("done: new commits and a clean tree are pushed (cost from the old fields of an old fact)", async () => {
    const state = await fixture("commit");
    const result = await runWork(state);
    expect(result.result).toBe("done");
    const task = await taskDataOf(state);
    expect(task.attempt?.sessionId).toBe("fake-session");
    expect(task.attempt?.cost).toBe(2.5);
    expect(task.cost).toBe(2.5);

    const branch = `work/${state.taskId}`;
    expect(
      git(state.remote.origin, ["show-ref", "--verify", `refs/heads/${branch}`])
        .ok,
    ).toBe(true);
    expect(
      git(state.remote.origin, ["show", `${branch}:worker.txt`]).out,
    ).toBe("done");
  });

  test("nothing: no new commits", async () => {
    const state = await fixture("nothing");
    const result = await runWork(state);
    expect(result.result).toBe("nothing");
    expect((await taskDataOf(state)).attempt?.sessionId).toBe("fake-session");
  });

  test("nothing: a reset below the base is not new work", async () => {
    const state = await fixture("reset");
    const path = join(
      state.remote.repository,
      ".operad-worktrees",
      state.taskId,
    );
    await commitIn(path, "branch.txt", "branch\n", "branch work");
    await advanceMain(state.remote, "main.txt", "moved\n", "main moves");
    const prepared = await state.registry.runStep("dev/worktree", {}, {
      runId: "retry-run",
      object: { type: "task", id: state.taskKey, data: {} },
    });
    expect(prepared.result).toBe("ready");
    const base = (await taskDataOf(state)).attempt?.base;
    expect(typeof base).toBe("string");

    const result = await runWork(state, "retry-work");
    expect(result.result).toBe("nothing");
    expect(gitOrThrow(path, ["rev-parse", "HEAD"])).not.toBe(base);
    expect(
      git(state.remote.origin, [
        "show-ref",
        "--verify",
        `refs/heads/work/${state.taskId}`,
      ]).ok,
    ).toBe(false);
  });

  test("a failed work and a new worktree visit in the same run count a new attempt", async () => {
    const state = await fixture("fail");
    const failed = await runWork(state, "retry-run");
    expect(failed.result).toBe("failed");
    expect((await taskDataOf(state)).attempts).toBe(1);

    const again = await state.registry.runStep("dev/worktree", {}, {
      runId: "retry-run",
      object: { type: "task", id: state.taskKey, data: {} },
    });
    expect(again.result).toBe("ready");
    expect((await taskDataOf(state)).attempts).toBe(2);
  });

  test("unavailable: a model error waits for the model instead of a person", async () => {
    for (const mode of ["unavailable", "usage_limit"]) {
      const state = await fixture(mode);
      const before = Date.now();
      const result = await runWork(state);
      expect(result.result).toBe("unavailable");
      const retryAt = result.data?.retryAt;
      expect(typeof retryAt).toBe("number");
      expect(retryAt as number).toBeGreaterThanOrEqual(before + 120_000);
      const task = await taskDataOf(state);
      expect(task.phase).toBe("running");
      expect(task.attempt?.workWaits).toBe(1);
      expect(task.attempt?.workRetryAt).toBe(retryAt as number);
    }
  });

  test("unavailable: after the allowed waits the failure goes to a person", async () => {
    const state = await fixture("unavailable");
    // Every wait is a real harness run, so the count is set to one short of the
    // bound instead of running the harness MAX_WORK_WAITS times.
    const waited = await state.store.get("task", state.taskKey);
    if (waited === undefined) throw new Error("task disappeared");
    const data = taskData(waited.data);
    if (data.attempt === undefined) throw new Error("no attempt");
    await state.store.put(
      "task",
      state.taskKey,
      { ...waited.data, attempt: { ...data.attempt, workWaits: MAX_WORK_WAITS - 1 } },
      "test",
    );
    expect((await runWork(state)).result).toBe("unavailable");
    expect((await taskDataOf(state)).attempt?.workWaits).toBe(MAX_WORK_WAITS);
    const last = await runWork(state);
    expect(last.result).toBe("failed");
    expect((await taskDataOf(state)).phase).toBe("waiting");
  });

  test("work_due holds until the recorded time, then lets the work run", async () => {
    const state = await fixture("unavailable");
    await runWork(state);
    const retryAt = (await taskDataOf(state)).attempt?.workRetryAt as number;
    const waits: number[] = [];
    reviewTestHooks.now = () => (waits.length === 0 ? retryAt - 5_000 : retryAt);
    reviewTestHooks.wait = async (ms) => {
      waits.push(ms);
      return true;
    };
    try {
      const due = await state.registry.runStep("dev/work_due", {}, {
        runId: "work-run",
        object: { type: "task", id: state.taskKey, data: {} },
      });
      expect(due.result).toBe("ready");
      expect(waits).toEqual([5_000]);
    } finally {
      reviewTestHooks.now = undefined;
      reviewTestHooks.wait = undefined;
    }
  });

  test("a plain failure is not waited for", async () => {
    const state = await fixture("fail");
    expect((await runWork(state)).result).toBe("failed");
    expect((await taskDataOf(state)).attempt?.workWaits ?? 0).toBe(0);
  });

  test("failed: the harness failed", async () => {
    const state = await fixture("fail");
    const result = await runWork(state);
    expect(result.result).toBe("failed");
    expect(result.data?.reason).toBe("harness");
    expect(String(result.data?.message)).toContain("fake harness");
    expect((await taskDataOf(state)).attempt?.sessionId).toBe("fake-session");
  });

  test("failed: uncommitted changes are named", async () => {
    const state = await fixture("dirty");
    const result = await runWork(state);
    expect(result.result).toBe("failed");
    expect(result.data?.reason).toBe("changes");
    expect(result.data?.files).toEqual(["dirty.txt"]);
    expect(String(result.data?.message)).toContain("dirty.txt");
  });

  test("failed: a failed harness still names the files it left", async () => {
    const state = await fixture("dirty-fail");
    const result = await runWork(state);
    expect(result.result).toBe("failed");
    expect(result.data?.reason).toBe("harness");
    expect(result.data?.files).toEqual(["dirty.txt"]);
    expect(String(result.data?.message)).toContain("dirty.txt");
  });

  test("an empty worker.args is passed, not the flow's args", async () => {
    const state = await fixture("nothing", { args: [] });
    const result = await state.registry.runStep("dev/work", {}, {
      runId: "work-run",
      object: { type: "task", id: state.taskKey, data: {} },
      params: { args: ["commit"] },
    });
    expect(result.result).toBe("nothing");
    const record = JSON.parse(readFileSync(state.record, "utf8")) as {
      readonly args: readonly string[];
    };
    expect(record.args).toEqual([]);
  });

  test("the prompt is the worker brief, the body and the rework sections", async () => {
    const state = await fixture("nothing", {
      workerBrief: "Repository brief: stay in the worktree.",
    });
    await runWork(state);
    const { prompt, cwd } = readRecord(state);
    expect(prompt.startsWith("Repository brief: stay in the worktree.")).toBe(
      true,
    );
    expect(prompt).toContain("Write the worker file.");
    expect(prompt).toContain("## Rework 1 (review)");
    expect(prompt).toContain("Add the detail the review asked for.");
    expect(prompt).not.toContain("## Changes");
    expect(cwd).toContain(join(".operad-worktrees", state.taskId));
  });

  test("a conflict left by the worktree step starts the prompt", async () => {
    const state = await fixture("nothing");
    const worktree = join(
      state.remote.repository,
      ".operad-worktrees",
      state.taskId,
    );
    await commitIn(worktree, "README.md", "# branch\n", "branch changes readme");
    await advanceMain(
      state.remote,
      "README.md",
      "# main\n",
      "main changes readme",
    );
    const conflict = await state.registry.runStep("dev/worktree", {}, {
      runId: "conflict-run",
      object: { type: "task", id: state.taskKey, data: {} },
    });
    expect(conflict.result).toBe("conflict");

    await runWork(state, "conflict-work");
    const { prompt } = readRecord(state);
    expect(
      prompt.startsWith("The worktree has an unresolved merge conflict"),
    ).toBe(true);
    expect(prompt).toContain("- README.md");
    expect(prompt).toContain("Start by resolving every conflict");
  });
});

const realTest = process.env.OPERAD_TEST_RADIAN === "1" ? test : test.skip;

realTest(
  "runs the real harness-radian (set OPERAD_TEST_RADIAN=1 to enable this test)",
  async () => {
    const modulePath = new URL(
      "../../harness-radian/src/index.ts",
      import.meta.url,
    ).href;
    const module = (await import(modulePath)) as {
      readonly createRadianHarnessPlugin: () => unknown;
    };
    const state = await fixture("nothing", {
      workerUse: "harness-radian/agent",
      args: [],
      plugins: [module.createRadianHarnessPlugin()],
    });
    const result = await runWork(state, "real-run");
    expect(["done", "nothing", "failed"]).toContain(result.result);
    const task = await taskDataOf(state);
    expect(task.attempt?.sessionId).not.toBeUndefined();
  },
);

describe("dev/work after main moved", () => {
  const worktreeOf = (state: Fixture) =>
    join(state.remote.repository, ".operad-worktrees", state.taskId);
  const visit = (state: Fixture, runId: string) =>
    state.registry.runStep("dev/worktree", {}, {
      runId,
      object: { type: "task", id: state.taskKey, data: {} },
    });

  test("a rework gets main's commit, and the attempt and Changes say so", async () => {
    const state = await fixture("nothing");
    await advanceMain(state.remote, "main.txt", "moved\n", "main moves");
    const prepared = await visit(state, "rework-run");
    expect(prepared.result).toBe("ready");
    expect(readFileSync(join(worktreeOf(state), "main.txt"), "utf8")).toBe("moved\n");
    const task = await taskDataOf(state);
    const short = gitOrThrow(worktreeOf(state), ["rev-parse", "--short", "origin/main"]);
    expect(task.attempt?.merged).toEqual({ ref: "origin/main", commit: short, conflict: false });
    expect(task.brief).toContain(`] merged origin/main ${short} into the branch (clean)`);
  });

  test("a clean merge and no change by the worker is nothing", async () => {
    const state = await fixture("nothing");
    await advanceMain(state.remote, "main.txt", "moved\n", "main moves");
    await visit(state, "rework-run");
    const result = await runWork(state, "rework-work");
    expect(result.result).toBe("nothing");
  });

  test("a clean merge and a commit by the worker is work", async () => {
    const state = await fixture("commit");
    await advanceMain(state.remote, "main.txt", "moved\n", "main moves");
    await visit(state, "rework-run");
    expect((await runWork(state, "rework-work")).result).toBe("done");
  });

  test("a conflicting main is left for the worker and the prompt names the files", async () => {
    const state = await fixture("nothing");
    const path = worktreeOf(state);
    await commitIn(path, "README.md", "# branch\n", "branch changes readme");
    await advanceMain(state.remote, "README.md", "# main\n", "main changes readme");
    const conflict = await visit(state, "rework-run");
    expect(conflict.result).toBe("conflict");
    const task = await taskDataOf(state);
    expect(task.attempt?.merged).toMatchObject({ conflict: true });
    expect(task.brief).toContain("into the branch (conflict)");
    await runWork(state, "rework-work");
    const { prompt } = readRecord(state);
    expect(prompt).toContain("merge of the latest main in progress");
    expect(prompt).toContain("resolving it is part of this attempt");
    expect(prompt).toContain("- README.md");
  });

  test("a merge the worker resolved is work", async () => {
    const state = await fixture("nothing");
    const path = worktreeOf(state);
    await commitIn(path, "README.md", "# branch\n", "branch changes readme");
    await advanceMain(state.remote, "README.md", "# main\n", "main changes readme");
    expect((await visit(state, "rework-run")).result).toBe("conflict");
    // The worker resolves the merge and commits it; the fake reports done.
    writeFileSync(join(path, "README.md"), "# both\n");
    gitOrThrow(path, ["add", "README.md"]);
    gitOrThrow(path, ["-c", "user.name=w", "-c", "user.email=w@example.com", "commit", "-qm", "resolve"]);
    expect((await runWork(state, "rework-work")).result).toBe("done");
  });
});

describe("dev/work with workers", () => {
  const visit = (state: Fixture, runId: string) =>
    state.registry.runStep("dev/worktree", {}, {
      runId,
      object: { type: "task", id: state.taskKey, data: {} },
    });
  const devJson = (state: Fixture) =>
    join(state.remote.repository, ".operad", "dev.json");
  const rewrite = (state: Fixture, change: Record<string, unknown>) => {
    const current = JSON.parse(readFileSync(devJson(state), "utf8")) as Record<string, unknown>;
    writeFileSync(devJson(state), JSON.stringify({ ...current, ...change }, null, 2));
  };
  const fake = (mode: string, extra: Record<string, unknown> = {}) => ({
    use: "fake-harness/agent",
    args: [mode],
    ...extra,
  });

  test("the old single worker runs as one worker named after its harness", async () => {
    const state = await fixture("commit");
    const result = await runWork(state);
    expect(result.result).toBe("done");
    expect(result.data).toMatchObject({ worker: "fake-harness", work: "work: fake-harness" });
    const task = await taskDataOf(state);
    expect(task.attempt?.worker).toBe("fake-harness");
    expect(task.attempt?.fallbackFrom).toBeNull();
  });

  test("the attempt records the worker the pool picked, the first one listed with room", async () => {
    const state = await fixture("nothing", {
      workers: { first: fake("nothing"), second: fake("nothing") },
    });
    await runWork(state);
    expect((await taskDataOf(state)).attempt?.worker).toBe("first");
  });

  test("a rework goes back to the worker that ran the attempt before", async () => {
    const state = await fixture("nothing", {
      workers: { second: fake("nothing") },
    });
    await runWork(state, "run-1");
    expect((await taskDataOf(state)).attempt?.worker).toBe("second");
    // A worker listed first now has room too; the rework still asks for "second".
    rewrite(state, { workers: { first: fake("nothing"), second: fake("nothing") } });
    expect((await visit(state, "rework-run")).result).toBe("ready");
    expect((await taskDataOf(state)).attempt?.previousWorker).toBe("second");
    const result = await runWork(state, "run-2");
    expect(result.data).toMatchObject({ worker: "second" });
    const task = await taskDataOf(state);
    expect(task.attempt?.worker).toBe("second");
    expect(task.attempt?.workerChanged).toBeNull();
  });

  test("an attempt that never reached a worker passes the earlier worker on", async () => {
    const state = await fixture("nothing", { workers: { second: fake("nothing") } });
    await runWork(state, "run-1");
    rewrite(state, { workers: { first: fake("nothing"), second: fake("nothing") } });
    await visit(state, "rework-a");
    // That attempt ended before any work; the next one still goes to "second".
    await visit(state, "rework-b");
    const result = await runWork(state, "run-2");
    expect(result.data).toMatchObject({ worker: "second" });
  });

  test("a rework waits for its worker while another worker is free", async () => {
    const state = await fixture("nothing", {
      workers: { second: fake("nothing") },
    });
    await runWork(state, "run-1");
    rewrite(state, { workers: { first: fake("nothing"), second: fake("nothing") } });
    await visit(state, "rework-run");
    // Another task holds the only place of "second".
    const places = new FilePlaces(join(state.root, "pool"));
    const held = await places.claim([
      {
        own: "count:repository/default/second",
        ownLimit: 1,
        home: "harness:fake-harness",
        homeLimit: undefined,
      },
    ]);
    if (held.kind !== "taken") throw new Error("the place was not free");
    let waiting: () => void = () => undefined;
    const sawWaiting = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    let finished = false;
    const work = runWork(state, "run-2", (plugin, type) => {
      if (plugin === "pool" && type === "pool.waiting") waiting();
    }).then((result) => {
      finished = true;
      return result;
    });
    await sawWaiting;
    expect(finished).toBe(false);
    await held.release();
    const result = await work;
    expect(result.data).toMatchObject({ worker: "second" });
  });

  test("a worker removed from dev.json is replaced and the change is recorded", async () => {
    const state = await fixture("nothing", {
      workers: { gone: fake("nothing") },
    });
    await runWork(state, "run-1");
    rewrite(state, { workers: { other: fake("nothing") } });
    await visit(state, "rework-run");
    const result = await runWork(state, "run-2");
    expect(result.result).toBe("nothing");
    expect(result.data).toMatchObject({
      worker: "other",
      work: "work: other; gone is no longer in the pool",
    });
    const task = await taskDataOf(state);
    expect(task.attempt?.worker).toBe("other");
    expect(task.attempt?.workerChanged).toBe("gone");
  });

  test("a fallback attempt records the worker that ran, and the rework goes to it", async () => {
    const state = await fixture("nothing", {
      workers: {
        claude: fake("usage_limit", { fallback: "pi" }),
        pi: fake("nothing"),
      },
    });
    const first = await runWork(state, "run-1");
    expect(first.data).toMatchObject({
      worker: "pi",
      fallbackFrom: "claude",
      work: "work: pi (fallback from claude)",
    });
    const attempt = (await taskDataOf(state)).attempt;
    expect(attempt?.worker).toBe("pi");
    expect(attempt?.fallbackFrom).toBe("claude");
    await visit(state, "rework-run");
    const second = await runWork(state, "run-2");
    expect(second.data).toMatchObject({ worker: "pi", work: "work: pi" });
    expect((await taskDataOf(state)).attempt?.fallbackFrom).toBeNull();
  });

  test("a rework resumes the session of the worker it goes back to", async () => {
    const state = await fixture("nothing", { workers: { only: fake("nothing") } });
    await runWork(state, "run-1");
    await visit(state, "rework-run");
    await runWork(state, "run-2");
    const record = JSON.parse(readFileSync(state.record, "utf8")) as {
      readonly resumeSession: string | null;
    };
    expect(record.resumeSession).toBe("fake-session");
  });

  test("a fallback outside the default pool is still the worker a rework goes back to", async () => {
    const state = await fixture("nothing", {
      workers: {
        claude: fake("usage_limit", { fallback: "pi" }),
        pi: fake("nothing"),
      },
      pools: { default: ["claude"] },
    });
    await runWork(state, "run-1");
    expect((await taskDataOf(state)).attempt?.worker).toBe("pi");
    await visit(state, "rework-run");
    const second = await runWork(state, "run-2");
    expect(second.data).toMatchObject({ worker: "pi", work: "work: pi" });
    expect((await taskDataOf(state)).attempt?.workerChanged).toBeNull();
  });

  test("the work reads the main clone's dev.json, not the worktree's older copy", async () => {
    const state = await fixture("nothing", { workers: { old: fake("nothing") } });
    const stale = join(
      state.remote.repository,
      ".operad-worktrees",
      state.taskId,
      ".operad",
      "dev.json",
    );
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, readFileSync(devJson(state)));
    const tree = dirname(dirname(stale));
    gitOrThrow(tree, ["add", "-f", ".operad/dev.json"]);
    gitOrThrow(tree, ["-c", "user.name=w", "-c", "user.email=w@example.com", "commit", "-qm", "old copy"]);
    // main moves on: the worktree keeps the old copy.
    rewrite(state, { workers: { fresh: fake("nothing") } });
    const result = await runWork(state);
    expect(result.data).toMatchObject({ worker: "fresh" });
    expect(JSON.parse(readFileSync(stale, "utf8"))).toHaveProperty("workers.old");
  });
});
