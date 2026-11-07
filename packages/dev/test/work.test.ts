import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
          if (mode === "commit" || mode === "commit-standard" || mode === "commit-incomplete" || mode === "commit-broken") {
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
        worker: {
          use: options.workerUse ?? "fake-harness/agent",
          args: options.args ?? [mode],
        },
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

function runWork(state: Fixture, runId = "work-run") {
  return state.registry.runStep("dev/work", {}, {
    runId,
    object: { type: "task", id: state.taskKey, data: {} },
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
    for (let wait = 0; wait < MAX_WORK_WAITS; wait += 1) {
      expect((await runWork(state)).result).toBe("unavailable");
    }
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
