import { createPoolPlugin } from "@operad-io/pool";
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  definePlugin,
  openLog,
  parseObjectKey,
  PluginRegistry,
  Runner,
  type LogBackend,
  type PluginStepResult,
  type StepEvent,
} from "@operad-io/engine";
import { createShellPlugin } from "@operad-io/shell";
import {
  addPlan,
  addRepository,
  addTask,
  classifyStop,
  createDevPlugin,
  DEFAULT_DEV_SETTINGS,
  reviewTestHooks,
  settingsProblem,
  taskData,
  validateDevSettings,
  type StopFacts,
  type StopKind,
} from "../src/index.ts";
import { makeRemote, type RemoteSetup } from "./git-support.ts";
import { cleanupTempRoots, guardLockHandles, storeAt, tempRoot } from "./support.ts";

// Every test here makes real git worktrees, which takes longer than bun's
// default 5 s when the machine is busy.
setDefaultTimeout(60_000);

afterAll(cleanupTempRoots);
guardLockHandles();
afterEach(() => {
  reviewTestHooks.now = undefined;
  reviewTestHooks.wait = undefined;
});

describe("classifyStop", () => {
  const table: readonly [string, StopFacts, StopKind][] = [
    ["a recovered run", { step: "work", result: "interrupted" }, "environment"],
    ["a recovered worktree step", { step: "worktree", result: "interrupted" }, "environment"],
    [
      "a step that is not loaded",
      { step: "work", result: "failed", reason: "step_not_loaded", use: "pool/agent" },
      "environment",
    ],
    [
      "not loaded, with no step named",
      { step: "work", result: "failed", reason: "step_not_loaded" },
      "task",
    ],
    ["settings that cannot be read", { step: "work", result: "failed", reason: "settings_unreadable" }, "environment"],
    ["a process killed by a signal nobody sent", { step: "work", result: "failed", reason: "stopped" }, "environment"],
    ["a person's cancel", { step: "work", result: "interrupted", cancelled: true }, "task"],
    ["a person's cancel over a stop", { step: "work", result: "failed", reason: "stopped", cancelled: true }, "task"],
    ["a harness that failed", { step: "work", result: "failed", reason: "harness" }, "task"],
    ["uncommitted changes", { step: "work", result: "failed", reason: "changes" }, "task"],
    ["a push that failed", { step: "work", result: "failed", reason: "push" }, "task"],
    ["no worktree", { step: "work", result: "failed", reason: "no_worktree" }, "task"],
    ["nothing done", { step: "work", result: "nothing" }, "task"],
    ["a failure with no reason", { step: "work", result: "failed" }, "task"],
    ["a repair run that only asks a person", { step: "worktree", result: "interrupted", reason: "run_ended" }, "task"],
  ];
  for (const [name, facts, kind] of table) {
    test(`${name} is ${kind}`, () => {
      expect(classifyStop(facts).kind).toBe(kind);
    });
  }

  test("the cause says what was wrong, and what a retry waits for", () => {
    expect(
      classifyStop({ step: "work", result: "failed", reason: "step_not_loaded", use: "pool/agent" }),
    ).toEqual({
      kind: "environment",
      cause: "pool/agent is not loaded",
      waitFor: "step",
      use: "pool/agent",
    });
    expect(classifyStop({ step: "work", result: "failed", reason: "settings_unreadable" })).toEqual({
      kind: "environment",
      cause: "settings could not be read",
      waitFor: "settings",
    });
    expect(classifyStop({ step: "work", result: "interrupted" }).waitFor).toBeUndefined();
  });
});

describe("retry.environmentWaitMinutes", () => {
  test("defaults to 60 and takes a positive integer", () => {
    expect(DEFAULT_DEV_SETTINGS.retry.environmentWaitMinutes).toBe(60);
    expect(validateDevSettings({ name: "x" }).retry.environmentWaitMinutes).toBe(60);
    expect(
      validateDevSettings({ name: "x", retry: { environmentWaitMinutes: 5 } }).retry
        .environmentWaitMinutes,
    ).toBe(5);
    expect(() => validateDevSettings({ name: "x", retry: { environmentWaitMinutes: 0 } })).toThrow(
      /environmentWaitMinutes/,
    );
    expect(() => validateDevSettings({ name: "x", retry: { other: 1 } })).toThrow(/retry/);
  });
});

type Script = (call: number) => PluginStepResult;

/** A worker that answers from a script, call by call; it never commits. */
function scripted(script: Script) {
  const state = { calls: 0 };
  const plugin = definePlugin({
    name: "fake-harness",
    kind: "harness",
    version: "0.0.0",
    steps: [
      {
        name: "agent",
        results: ["done", "failed", "interrupted"],
        run(): PluginStepResult {
          state.calls += 1;
          return script(state.calls);
        },
      },
    ],
  });
  return { plugin, state };
}

const KILLED: PluginStepResult = {
  result: "interrupted",
  data: { reason: "signal", message: "the harness was killed by SIGKILL without a Result line" },
};
const DONE: PluginStepResult = { result: "done", data: {} };

interface World {
  readonly root: string;
  readonly remote: RemoteSetup;
  readonly store: ReturnType<typeof storeAt>;
  readonly log: LogBackend;
  readonly tasks: readonly string[];
  readonly events: StepEvent[];
}

async function world(taskCount: number, devJson: Record<string, unknown> = {}): Promise<World> {
  const root = await tempRoot();
  const remote = await makeRemote(root);
  const store = storeAt(root);
  const repository = await addRepository(store, { path: remote.repository, name: "repository" });
  writeFileSync(
    join(remote.repository, ".operad", "dev.json"),
    JSON.stringify({
      name: "repository",
      remote: "origin",
      mainBranch: "main",
      worktreeRoot: ".operad-worktrees",
      worker: { use: "fake-harness/agent", args: [] },
      ...devJson,
    }),
  );
  const plan = await addPlan(store, { repository, slug: "plan", title: "Plan", request: "do it" });
  const tasks: string[] = [];
  for (let index = 0; index < taskCount; index += 1) {
    const task = await addTask(store, {
      plan: plan.id,
      slug: `task-${index + 1}`,
      title: `Task ${index + 1}`,
      brief: "Write the file.",
    });
    tasks.push(task.id);
  }
  const log = openLog({ backend: "jsonl", path: join(root, "log") });
  return { root, remote, store, log, tasks, events: [] };
}

function registryOf(w: World, plugins: readonly unknown[]): PluginRegistry {
  return new PluginRegistry(plugins as never, {
    home: w.root,
    cwd: w.remote.repository,
    store: w.store,
  });
}

/** Starts a run for each task, or continues the runs of an earlier call. */
async function drive(
  w: World,
  registry: PluginRegistry,
  runs: Map<string, string>,
): Promise<readonly string[]> {
  const outcomes: string[] = [];
  const found = registry.flow("dev");
  if (found === undefined) throw new Error("the dev flow is missing");
  for (const key of w.tasks) {
    let runId = runs.get(key);
    if (runId === undefined) {
      runId = (await w.log.startRun("dev", `task:${key}`)).runId;
      runs.set(key, runId);
    }
    const object = parseObjectKey(`task:${key}`);
    outcomes.push(
      await new Runner({
        log: w.log,
        flow: found.flow,
        runId,
        registry,
        ...(object === undefined ? {} : { object }),
        emit: async (_plugin, event) => {
          w.events.push(event);
        },
      }).run(),
    );
  }
  return outcomes;
}

async function visits(w: World, runId: string, step: string): Promise<number> {
  let count = 0;
  for await (const fact of w.log.read(runId)) {
    if (fact.kind === "step_entered" && (fact.payload as { step?: unknown }).step === step) {
      count += 1;
    }
  }
  return count;
}

async function taskOf(w: World, key: string) {
  const object = await w.store.get("task", key);
  if (object === undefined) throw new Error("task disappeared");
  return taskData(object.data);
}

function waitingReasons(w: World): readonly string[] {
  return w.events
    .filter((event) => event.type === "dev.waiting")
    .map((event) => String((event.data as { reason?: unknown } | undefined)?.reason));
}

/** Each waiting announcement with the task it belongs to, sorted by task. */
function waitingByTask(w: World): readonly { readonly task: string; readonly reason: string }[] {
  return w.events
    .filter((event) => event.type === "dev.waiting")
    .map((event) => {
      const data = event.data as { task?: unknown; reason?: unknown } | undefined;
      return { task: String(data?.task), reason: String(data?.reason) };
    })
    .sort((a, b) => a.task.localeCompare(b.task));
}

/** A clock the test moves by hand; every wait returns at once. */
function manualClock(start = 1_000_000_000): { advance(ms: number): void } {
  let now = start;
  reviewTestHooks.now = () => now;
  reviewTestHooks.wait = async () => true;
  return {
    advance(ms: number): void {
      now += ms;
    },
  };
}

const MINUTE = 60_000;

describe("an environment failure of the work step", () => {
  test("a stopped worker is retried once, right away, and the retry is in the task", async () => {
    const worker = scripted((call) => (call === 1 ? KILLED : DONE));
    const w = await world(1);
    const registry = registryOf(w, [createDevPlugin(), createPoolPlugin(), worker.plugin]);
    const runs = new Map<string, string>();
    expect(await drive(w, registry, runs)).toEqual(["waiting"]);
    const runId = runs.get(w.tasks[0] as string) as string;
    expect(worker.state.calls).toBe(2);
    expect(await visits(w, runId, "work")).toBe(2);
    expect(await visits(w, runId, "retry_work_failed")).toBe(1);
    const task = await taskOf(w, w.tasks[0] as string);
    expect(task.retry?.state).toBe("retrying");
    expect(task.retry?.cause).toBe("run stopped during work");
    // The second pass did nothing: that is the task's own result.
    expect(waitingReasons(w)).toEqual(["work did nothing"]);
    expect(task.phase).toBe("waiting");
  });

  test("the retry is an attempt in history with its reason", async () => {
    const worker = scripted((call) => (call === 1 ? KILLED : DONE));
    const w = await world(1);
    const registry = registryOf(w, [createDevPlugin(), createPoolPlugin(), worker.plugin]);
    const runs = new Map<string, string>();
    await drive(w, registry, runs);
    const reasons: string[] = [];
    for await (const fact of w.log.read(runs.get(w.tasks[0] as string) as string)) {
      if (fact.kind === "step_result") {
        const payload = fact.payload as { step?: string; data?: { reason?: string; cause?: string } };
        if (payload.step === "retry_work_failed") {
          reasons.push(`${payload.data?.reason}: ${payload.data?.cause}`);
        }
      }
    }
    expect(reasons).toEqual(["retry: run stopped during work"]);
  });

  test("a second stop in the same attempt waits for a person and says why", async () => {
    const worker = scripted(() => KILLED);
    const w = await world(1);
    const registry = registryOf(w, [createDevPlugin(), createPoolPlugin(), worker.plugin]);
    const runs = new Map<string, string>();
    expect(await drive(w, registry, runs)).toEqual(["waiting"]);
    expect(worker.state.calls).toBe(2);
    expect(waitingReasons(w)).toEqual(["run stopped during work"]);
    const task = await taskOf(w, w.tasks[0] as string);
    expect(task.retry?.state).toBe("asked");
    expect(task.phase).toBe("waiting");
  });

  test("a dropped model connection is retried once by dev/retry, not sent to a person", async () => {
    const worker = scripted((call) =>
      call === 1
        ? { result: "failed", data: { message: "The socket connection was closed unexpectedly" } }
        : DONE,
    );
    const w = await world(1);
    const registry = registryOf(w, [createDevPlugin(), createPoolPlugin(), worker.plugin]);
    const runs = new Map<string, string>();
    await drive(w, registry, runs);
    const runId = runs.get(w.tasks[0] as string) as string;
    expect(worker.state.calls).toBe(2);
    expect(await visits(w, runId, "retry_work_failed")).toBe(1);
    const task = await taskOf(w, w.tasks[0] as string);
    expect(task.retry?.cause).toBe("model connection dropped during work");
    expect(waitingReasons(w)).toEqual(["work did nothing"]);
  });

  test("a failure of the task's own work is not retried", async () => {
    const worker = scripted(() => ({
      result: "failed",
      data: { message: "the model said no" },
    }));
    const w = await world(1);
    const registry = registryOf(w, [createDevPlugin(), createPoolPlugin(), worker.plugin]);
    const runs = new Map<string, string>();
    expect(await drive(w, registry, runs)).toEqual(["waiting"]);
    expect(worker.state.calls).toBe(1);
    expect(waitingReasons(w)).toEqual(["work failed"]);
    expect((await taskOf(w, w.tasks[0] as string)).retry ?? null).toBeNull();
  });

  test("a step that is not loaded: the retry waits until it is, then the work runs", async () => {
    const clock = manualClock();
    const worker = scripted(() => DONE);
    const w = await world(1);
    const without = registryOf(w, [createDevPlugin(), worker.plugin]);
    const runs = new Map<string, string>();
    expect(await drive(w, without, runs)).toEqual(["blocked"]);
    clock.advance(10 * MINUTE);
    expect(await drive(w, without, runs)).toEqual(["blocked"]);
    expect(worker.state.calls).toBe(0);
    expect((await taskOf(w, w.tasks[0] as string)).retry?.state).toBe("waiting");
    expect(waitingReasons(w)).toEqual([]);

    const withPool = registryOf(w, [createDevPlugin(), createPoolPlugin(), worker.plugin]);
    expect(await drive(w, withPool, runs)).toEqual(["waiting"]);
    expect(worker.state.calls).toBe(1);
    expect(waitingReasons(w)).toEqual(["work did nothing"]);
    expect((await taskOf(w, w.tasks[0] as string)).retry?.state).toBe("ready");
  });

  test("the wait runs out: the task waits for a person, and the line names what is not loaded", async () => {
    const clock = manualClock();
    const worker = scripted(() => DONE);
    const w = await world(1, { retry: { environmentWaitMinutes: 5 } });
    const without = registryOf(w, [createDevPlugin(), worker.plugin]);
    const runs = new Map<string, string>();
    expect(await drive(w, without, runs)).toEqual(["blocked"]);
    clock.advance(4 * MINUTE);
    expect(await drive(w, without, runs)).toEqual(["blocked"]);
    clock.advance(2 * MINUTE);
    expect(await drive(w, without, runs)).toEqual(["waiting"]);
    expect(waitingReasons(w)).toEqual(["pool/agent is not loaded"]);
    const task = await taskOf(w, w.tasks[0] as string);
    expect(task.retry?.state).toBe("asked");
    expect(task.phase).toBe("waiting");
    expect(worker.state.calls).toBe(0);
  });
});

describe("a step that is not loaded, for several tasks", () => {
  test("within the bound every task stays running and nothing waits for a person; once loaded each continues", async () => {
    const clock = manualClock();
    const worker = scripted(() => DONE);
    const w = await world(2);
    const without = registryOf(w, [createDevPlugin(), worker.plugin]);
    const runs = new Map<string, string>();
    expect(await drive(w, without, runs)).toEqual(["blocked", "blocked"]);
    clock.advance(30 * MINUTE);
    expect(await drive(w, without, runs)).toEqual(["blocked", "blocked"]);
    expect(waitingReasons(w)).toEqual([]);
    for (const key of w.tasks) expect((await taskOf(w, key)).phase).toBe("running");

    const withPool = registryOf(w, [createDevPlugin(), createPoolPlugin(), worker.plugin]);
    expect(await drive(w, withPool, runs)).toEqual(["waiting", "waiting"]);
    expect(worker.state.calls).toBe(2);
    // Each task waits for a reason of its own (the fake worker changed
    // nothing), not because the step was missing.
    expect(waitingByTask(w)).toEqual(
      [...w.tasks].sort().map((task) => ({ task, reason: "work did nothing" })),
    );
  });
});

describe("settings that cannot be read", () => {
  test("the work step says so, and the retry waits until they can be read", async () => {
    const clock = manualClock();
    const w = await world(1);
    const registry = registryOf(w, [createDevPlugin(), createPoolPlugin(), scripted(() => DONE).plugin]);
    const key = w.tasks[0] as string;
    const object = { type: "task", id: key, data: {} };
    const path = join(w.remote.repository, ".operad", "dev.json");
    const valid = JSON.stringify({ name: "repository", worker: { use: "fake-harness/agent", args: [] } });
    writeFileSync(path, "{ not json");
    expect(settingsProblem(w.remote.repository)).toBeDefined();

    const failed = await registry.runStep("dev/work", {}, { runId: "r1", object });
    expect(failed.result).toBe("failed");
    expect(failed.data?.reason).toBe("settings_unreadable");

    const first = await registry.runStep(
      "dev/retry",
      { from: "work", result: "failed" },
      { runId: "r1", object },
    );
    expect(first.result).toBe("hold");
    expect((await taskOf(w, key)).retry?.cause).toBe("settings could not be read");

    const still = await registry.runStep("dev/retry_due", {}, { runId: "r1", object });
    expect(still.result).toBe("waiting");
    writeFileSync(path, valid);
    const ready = await registry.runStep("dev/retry_due", {}, { runId: "r1", object });
    expect(ready.result).toBe("ready");
    const after = await registry.runStep(
      "dev/retry",
      { from: "work", result: "waited" },
      { runId: "r1", object },
    );
    expect(after.result).toBe("again");
    clock.advance(1);
  });

  test("a stopped run whose settings still cannot be read waits for them instead of spending its retry", async () => {
    manualClock();
    const w = await world(1);
    const registry = registryOf(w, [createDevPlugin(), createPoolPlugin(), scripted(() => DONE).plugin]);
    const key = w.tasks[0] as string;
    const object = { type: "task", id: key, data: {} };
    writeFileSync(join(w.remote.repository, ".operad", "dev.json"), "{ not json");
    const first = await registry.runStep(
      "dev/retry",
      { from: "work", result: "interrupted" },
      { runId: "r3", object },
    );
    expect(first.result).toBe("hold");
    expect((await taskOf(w, key)).retry?.cause).toBe("settings could not be read");
  });

  test("the bound runs out and the task waits for a person with the cause", async () => {
    const clock = manualClock();
    const w = await world(1);
    const registry = registryOf(w, [createDevPlugin(), createPoolPlugin(), scripted(() => DONE).plugin]);
    const key = w.tasks[0] as string;
    const object = { type: "task", id: key, data: {} };
    writeFileSync(join(w.remote.repository, ".operad", "dev.json"), "{ not json");
    await registry.runStep("dev/work", {}, { runId: "r2", object });
    await registry.runStep("dev/retry", { from: "work", result: "failed" }, { runId: "r2", object });
    clock.advance(61 * MINUTE);
    expect((await registry.runStep("dev/retry_due", {}, { runId: "r2", object })).result).toBe("ready");
    const after = await registry.runStep(
      "dev/retry",
      { from: "work", result: "waited" },
      { runId: "r2", object },
    );
    expect(after.result).toBe("give_up");
    expect(after.data?.cause).toBe("settings could not be read");
    expect((await taskOf(w, key)).phase).toBe("waiting");
  });
});

describe("settings that cannot be read, in the worktree step", () => {
  test("a recovered worktree step waits for the settings, then runs again", async () => {
    const clock = manualClock();
    const w = await world(1);
    const registry = registryOf(w, [createDevPlugin(), createPoolPlugin(), scripted(() => DONE).plugin]);
    const key = w.tasks[0] as string;
    const found = registry.flow("dev");
    const steps = found?.flow.steps ?? [];
    const next = (id: string): Readonly<Record<string, string>> => {
      const step = steps.find((candidate) => candidate.id === id);
      return step === undefined || step.kind === "end" ? {} : (step.next as Readonly<Record<string, string>>);
    };
    // The hold edge of the retry steps leads to a wait, never back to the retry itself.
    for (const name of ["worktree", "reverify"]) {
      expect(next(`retry_${name}`).hold).toBe(`retry_${name}_wait`);
      expect(next(`retry_${name}_wait`).ready).toBe(`retry_${name}_after`);
      expect(next(`retry_${name}_after`).again).toBe(name);
    }
    const object = { type: "task", id: key, data: {} };
    const path = join(w.remote.repository, ".operad", "dev.json");
    const valid = JSON.stringify({ name: "repository", worker: { use: "fake-harness/agent", args: [] } });
    writeFileSync(path, "{ not json");
    const hold = await registry.runStep(
      "dev/retry",
      { from: "worktree", result: "interrupted" },
      { runId: "r4", object },
    );
    expect(hold.result).toBe("hold");
    expect((await registry.runStep("dev/retry_due", {}, { runId: "r4", object })).result).toBe("waiting");
    writeFileSync(path, valid);
    expect((await registry.runStep("dev/retry_due", {}, { runId: "r4", object })).result).toBe("ready");
    const after = await registry.runStep(
      "dev/retry",
      { from: "worktree", result: "waited" },
      { runId: "r4", object },
    );
    expect(after.result).toBe("again");
    clock.advance(1);
  });
});

describe("a spent retry hands the task to a person", () => {
  test("a recovered run that gives up says waiting, not the phase it had", async () => {
    manualClock();
    const w = await world(1);
    const registry = registryOf(w, [createDevPlugin(), createPoolPlugin(), scripted(() => DONE).plugin]);
    const key = w.tasks[0] as string;
    const object = { type: "task", id: key, data: {} };
    const before = await taskOf(w, key);
    await w.store.put(
      "task",
      key,
      {
        ...before,
        phase: "review",
        retry: { attempt: before.attempts, step: "review", cause: "database is locked", at: 1, state: "retrying" },
      },
      "test",
    );
    const out = await registry.runStep(
      "dev/retry",
      { from: "review", result: "interrupted" },
      { runId: "r9", object },
    );
    expect(out.result).toBe("give_up");
    expect((await taskOf(w, key)).phase).toBe("waiting");
  });
});

describe("a real process killed by a signal", () => {
  test("the work retries once by itself", async () => {
    const root = await tempRoot();
    const marker = join(root, "killed-once");
    const wrapper = join(root, "kill-once.ts");
    const fake = fileURLToPath(new URL("../../harness-pi/test/fake-lines-worker.ts", import.meta.url));
    writeFileSync(
      wrapper,
      [
        `import { existsSync, writeFileSync } from "node:fs";`,
        `const first = !existsSync(${JSON.stringify(marker)});`,
        `if (first) writeFileSync(${JSON.stringify(marker)}, "1");`,
        // The first run kills itself with a signal; the second finishes without a change.
        `process.env["FAKE_PI_MODE"] = first ? "kill" : "done";`,
        `await import(${JSON.stringify(fake)});`,
      ].join("\n"),
    );
    const module = (await import(
      new URL("../../harness-pi/src/index.ts", import.meta.url).href
    )) as {
      readonly createPiHarnessPlugin: (options: {
        readonly command: string;
        readonly args: readonly string[];
      }) => unknown;
    };
    const pi = module.createPiHarnessPlugin({ command: process.execPath, args: [wrapper] });
    const w = await world(1, { worker: { use: "harness-pi/agent", args: [] } });
    const registry = registryOf(w, [createDevPlugin(), createPoolPlugin(), createShellPlugin(), pi]);
    const runs = new Map<string, string>();
    expect(await drive(w, registry, runs)).toEqual(["waiting"]);
    const runId = runs.get(w.tasks[0] as string) as string;
    expect(await visits(w, runId, "work")).toBe(2);
    expect(await visits(w, runId, "retry_work_failed")).toBe(1);
    const task = await taskOf(w, w.tasks[0] as string);
    expect(task.retry?.cause).toBe("run stopped during work");
    expect(task.retry?.state).toBe("retrying");
    expect(waitingReasons(w)).toEqual(["work did nothing"]);
  }, 60_000);
});
