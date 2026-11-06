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
        async run(_ctx, params): Promise<PluginStepResult> {
          const input = params as {
            readonly prompt: string;
            readonly cwd: string;
            readonly args?: readonly string[];
          };
          const mode = input.args?.[0] ?? "nothing";
          writeFileSync(
            record,
            JSON.stringify({
              prompt: input.prompt,
              cwd: input.cwd,
              args: input.args ?? [],
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
          if (mode === "commit") {
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
  test("done: new commits and a clean tree are pushed", async () => {
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
