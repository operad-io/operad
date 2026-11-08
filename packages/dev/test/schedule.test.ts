import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listPending,
  openLog,
  parseObjectKey,
  PluginRegistry,
  readState,
  readStoredStart,
  recordAnswer,
  Runner,
  serveOnce,
  type RunInfo,
  type RunLookup,
} from "@operad-io/engine";
import plugin from "../src/index.ts";
import {
  addPlan,
  addRepository,
  addTask,
  confirmPlan,
  getPlan,
  getTask,
  setAuto,
  setPriority,
  claimTaskStart,
  setTaskPhase,
  updateTask,
  setConcurrency,
} from "../src/service.ts";
import { taskViews } from "../src/views.ts";
import {
  bareId,
  planData,
  taskData,
  type AutoMode,
  type Priority,
  type RepositoryData,
  type TaskPhase,
} from "../src/model.ts";
import { schedulerTestHooks } from "../src/schedule.ts";
import {
  cleanupTempRoots,
  guardLockHandles,
  makeGitRepository,
  storeAt,
  tempRoot,
} from "./support.ts";

afterAll(cleanupTempRoots);
afterEach(() => {
  schedulerTestHooks.write = undefined;
});
guardLockHandles();

const ACTOR = { via: "test", id: "tester" } as const;

const CRASH_CHILD = fileURLToPath(
  new URL("./fixtures/schedule-crash-child.ts", import.meta.url),
);

const CANCEL_CHILD = fileURLToPath(
  new URL("./fixtures/schedule-cancel-child.ts", import.meta.url),
);

interface Fixture {
  readonly root: string;
  readonly repositoryPath: string;
  readonly store: ReturnType<typeof storeAt>;
  readonly registry: PluginRegistry;
  readonly repository: RepositoryData;
  readonly answers: { readonly runId: string; readonly choice: string }[];
  readonly cancelled: string[];
  readonly lines: string[];
}

async function setup(
  options: {
    readonly concurrency?: number | undefined;
    /** Extra dev.json fields, such as workers and pools. */
    readonly devJson?: Readonly<Record<string, unknown>> | undefined;
  } = {},
): Promise<Fixture> {
  const root = await tempRoot();
  const repositoryPath = await makeGitRepository(root);
  const store = storeAt(root);
  const answers: { readonly runId: string; readonly choice: string }[] = [];
  const cancelled: string[] = [];
  const registry = new PluginRegistry([plugin], {
    home: root,
    cwd: repositoryPath,
    store,
    storeRoot: store.root,
    onAnswer: async (runId, choice) => {
      answers.push({ runId, choice });
    },
    onCancelRun: (runId) => {
      cancelled.push(runId);
    },
  });
  const repository = await addRepository(store, { path: repositoryPath });
  if (options.concurrency !== undefined || options.devJson !== undefined) {
    writeFileSync(
      join(repositoryPath, ".operad", "dev.json"),
      `${JSON.stringify({
        name: repository.name,
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
        ...options.devJson,
      })}\n`,
    );
  }
  const lines: string[] = [];
  schedulerTestHooks.write = (line) => lines.push(line);
  return { root, repositoryPath, store, registry, repository, answers, cancelled, lines };
}

interface PlanOptions {
  readonly slug: string;
  readonly auto?: AutoMode | undefined;
  readonly priority?: Priority | undefined;
  readonly concurrency?: number | undefined;
}

async function makePlan(
  fixture: Fixture,
  options: PlanOptions,
): Promise<{ readonly key: string; readonly id: string }> {
  const plan = await addPlan(fixture.store, {
    repository: fixture.repository,
    slug: options.slug,
    title: options.slug,
  });
  if (options.auto !== undefined) {
    await setAuto(fixture.store, plan.id, options.auto);
  }
  if (options.priority !== undefined) {
    await setPriority(fixture.store, plan.id, options.priority);
  }
  if (options.concurrency !== undefined) {
    const data = planData((await getPlan(fixture.store, plan.id)).data);
    await fixture.store.put(
      "plan",
      plan.id,
      { ...data, concurrency: options.concurrency },
      "test",
    );
  }
  return { key: plan.id, id: bareId(plan.id) };
}

async function makeTask(
  fixture: Fixture,
  planKey: string,
  slug: string,
  after: readonly string[] = [],
): Promise<{ readonly key: string; readonly id: string }> {
  const object = await addTask(fixture.store, {
    plan: planKey,
    slug,
    title: slug,
    after,
  });
  return { key: object.id, id: bareId(object.id) };
}

async function confirm(fixture: Fixture, planKey: string): Promise<void> {
  await confirmPlan(fixture.store, planKey);
}

async function putTask(
  fixture: Fixture,
  key: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const object = await getTask(fixture.store, key);
  await fixture.store.put(
    "task",
    key,
    { ...taskData(object.data), ...patch },
    "test",
  );
}

async function phase(
  fixture: Fixture,
  key: string,
  next: TaskPhase,
  run?: string,
): Promise<void> {
  await setTaskPhase(
    fixture.store,
    key,
    next,
    run === undefined ? {} : { run },
  );
}

async function tick(fixture: Fixture) {
  await fixture.registry.tick();
  return fixture.registry.takeStartedRuns();
}

function startedId(request: { readonly object?: { readonly id: string } | undefined }): string {
  return request.object?.id ?? "";
}

describe("dev scheduling", () => {
  test("concurrency 1 starts one task and frees the slot on merge", async () => {
    const fixture = await setup({ concurrency: 1 });
    const plan = await makePlan(fixture, { slug: "plan", auto: "run" });
    const first = await makeTask(fixture, plan.key, "first");
    const second = await makeTask(fixture, plan.key, "second");
    await confirm(fixture, plan.key);

    const one = await tick(fixture);
    expect(one.length).toBe(1);
    expect(startedId(one[0] as { object?: { id: string } })).toBe(first.key);
    expect(taskData((await getTask(fixture.store, first.key)).data).phase).toBe(
      "running",
    );
    expect(fixture.lines).toEqual([`${first.id} ready -> running`]);

    // The run records itself in its worktree step; the second tick leaves it.
    await putTask(fixture, first.key, { run: "run-1" });
    expect(await tick(fixture)).toEqual([]);
    expect(taskData((await getTask(fixture.store, second.key)).data).phase).toBe(
      "ready",
    );

    await phase(fixture, first.key, "merged");
    const two = await tick(fixture);
    expect(two.length).toBe(1);
    expect(startedId(two[0] as { object?: { id: string } })).toBe(second.key);
  });

  test("concurrency 2 starts two tasks and the repository limit still wins", async () => {
    const fixture = await setup({ concurrency: 2 });
    const plan = await makePlan(fixture, {
      slug: "plan",
      auto: "run",
      concurrency: 2,
    });
    await makeTask(fixture, plan.key, "first");
    await makeTask(fixture, plan.key, "second");
    await makeTask(fixture, plan.key, "third");
    await confirm(fixture, plan.key);

    expect((await tick(fixture)).length).toBe(2);

    const limited = await setup({ concurrency: 1 });
    const limitedPlan = await makePlan(limited, {
      slug: "plan",
      auto: "run",
      concurrency: 2,
    });
    await makeTask(limited, limitedPlan.key, "first");
    await makeTask(limited, limitedPlan.key, "second");
    await confirm(limited, limitedPlan.key);
    expect((await tick(limited)).length).toBe(1);
  });

  test("the running-task cap is the sum of the default pool's counts", async () => {
    const workers = {
      claude: { use: "harness-claude/agent", count: 2 },
      pi: { use: "harness-pi/agent", count: 1 },
      codex: { use: "harness-codex/agent", count: 5 },
    };
    const fixture = await setup({
      devJson: { workers, pools: { default: ["claude", "pi"], design: ["codex"] } },
    });
    const plan = await makePlan(fixture, { slug: "plan", auto: "run", concurrency: 9 });
    for (const slug of ["a", "b", "c", "d"]) await makeTask(fixture, plan.key, slug);
    await confirm(fixture, plan.key);
    // 2 + 1 from default; the design pool's 5 does not count.
    expect((await tick(fixture)).length).toBe(3);
  });

  test("concurrency caps the sum of the default pool's counts further", async () => {
    const fixture = await setup({
      concurrency: 2,
      devJson: {
        workers: {
          claude: { use: "harness-claude/agent", count: 2 },
          pi: { use: "harness-pi/agent", count: 2 },
        },
      },
    });
    const plan = await makePlan(fixture, { slug: "plan", auto: "run", concurrency: 9 });
    for (const slug of ["a", "b", "c"]) await makeTask(fixture, plan.key, slug);
    await confirm(fixture, plan.key);
    expect((await tick(fixture)).length).toBe(2);
  });

  test("a task starts only after every task it follows has merged", async () => {
    const fixture = await setup({ concurrency: 2 });
    const plan = await makePlan(fixture, {
      slug: "plan",
      auto: "run",
      concurrency: 2,
    });
    const first = await makeTask(fixture, plan.key, "first");
    const second = await makeTask(fixture, plan.key, "second", [first.id]);
    await confirm(fixture, plan.key);

    const one = await tick(fixture);
    expect(one.length).toBe(1);
    expect(startedId(one[0] as { object?: { id: string } })).toBe(first.key);

    await phase(fixture, first.key, "merged");
    const two = await tick(fixture);
    expect(two.length).toBe(1);
    expect(startedId(two[0] as { object?: { id: string } })).toBe(second.key);
  });

  test("the highest priority plan starts first", async () => {
    const fixture = await setup({ concurrency: 1 });
    const low = await makePlan(fixture, {
      slug: "low",
      auto: "run",
      priority: "P4",
    });
    const high = await makePlan(fixture, {
      slug: "high",
      auto: "run",
      priority: "P0",
    });
    const lowTask = await makeTask(fixture, low.key, "low-task");
    await makeTask(fixture, high.key, "high-task");
    await confirm(fixture, low.key);
    await confirm(fixture, high.key);

    const started = await tick(fixture);
    expect(started.length).toBe(1);
    expect(startedId(started[0] as { object?: { id: string } })).not.toBe(
      lowTask.key,
    );
    expect(fixture.lines.some((line) => line.includes("high-task"))).toBe(true);
  });

  test("auto off starts nothing and auto run starts the ready task", async () => {
    const off = await setup();
    const offPlan = await makePlan(off, { slug: "plan", auto: "off" });
    await makeTask(off, offPlan.key, "task");
    await confirm(off, offPlan.key);
    expect(await tick(off)).toEqual([]);
    expect(off.lines).toEqual([]);

    const run = await setup();
    const runPlan = await makePlan(run, { slug: "plan", auto: "run" });
    await makeTask(run, runPlan.key, "task");
    await confirm(run, runPlan.key);
    expect((await tick(run)).length).toBe(1);
  });

  test("auto merge answers a passed review once and never answers other waits", async () => {
    const passed = await setup();
    const plan = await makePlan(passed, { slug: "plan", auto: "merge" });
    const task = await makeTask(passed, plan.key, "task");
    await confirm(passed, plan.key);
    await phase(passed, task.key, "waiting", "run-1");
    await putTask(passed, task.key, {
      attempt: { number: 1, run: "run-1", review: { result: "pass" } },
    });

    await tick(passed);
    expect(passed.answers).toEqual([{ runId: "run-1", choice: "merge" }]);
    expect(passed.lines).toEqual([`${task.id} waiting -> integrating`]);
    expect(
      taskData((await getTask(passed.store, task.key)).data).autoMergeAttempt,
    ).toBe(1);

    // The integrate step records the landed merge; the next tick reports it,
    // and no later tick reports it again.
    await putTask(passed, task.key, {
      phase: "merged",
      attempt: {
        number: 1,
        run: "run-1",
        review: { result: "pass" },
        integration: { result: "merged" },
      },
    });
    await tick(passed);
    expect(passed.lines).toEqual([
      `${task.id} waiting -> integrating`,
      `${task.id} integrating -> merged`,
      `${plan.id} confirmed -> finished`,
    ]);
    await tick(passed);
    expect(passed.lines).toEqual([
      `${task.id} waiting -> integrating`,
      `${task.id} integrating -> merged`,
      `${plan.id} confirmed -> finished`,
    ]);

    await tick(passed);
    expect(passed.answers.length).toBe(1);

    const waits: readonly {
      readonly name: string;
      readonly attempt: Record<string, unknown>;
    }[] = [
      { name: "nothing", attempt: { number: 1, run: "run-1", result: "nothing" } },
      { name: "failed", attempt: { number: 1, run: "run-1", result: "failed" } },
      {
        name: "rework limit",
        attempt: {
          number: 1,
          run: "run-1",
          review: { result: "fail" },
          rework: { result: "ask", source: "review", streak: 3 },
        },
      },
      {
        name: "failed integrate",
        attempt: {
          number: 1,
          run: "run-1",
          review: { result: "pass" },
          integration: { result: "failed" },
        },
      },
    ];
    for (const wait of waits) {
      const other = await setup();
      const otherPlan = await makePlan(other, { slug: "plan", auto: "merge" });
      const otherTask = await makeTask(other, otherPlan.key, "task");
      await confirm(other, otherPlan.key);
      await phase(other, otherTask.key, "waiting", "run-1");
      await putTask(other, otherTask.key, { attempt: wait.attempt });
      await tick(other);
      expect({ name: wait.name, answers: other.answers }).toEqual({
        name: wait.name,
        answers: [],
      });
    }
  });

  test("start starts one ready task while its plan is at auto off", async () => {
    const fixture = await setup();
    const plan = await makePlan(fixture, { slug: "plan", auto: "off" });
    const task = await makeTask(fixture, plan.key, "task");
    await confirm(fixture, plan.key);

    const run = await fixture.registry.runCommand(["dev", "start", task.id]);
    expect(run?.value).toBe(`start requested for ${task.id}`);

    const started = await tick(fixture);
    expect(started.length).toBe(1);
    expect(startedId(started[0] as { object?: { id: string } })).toBe(task.key);
    expect(fixture.lines).toEqual([`${task.id} ready -> running`]);
  });

  test("a claim whose start never landed returns to ready and starts again", async () => {
    const fixture = await setup();
    const plan = await makePlan(fixture, { slug: "plan", auto: "run" });
    const task = await makeTask(fixture, plan.key, "task");
    await confirm(fixture, plan.key);

    // A real child runs one tick and kills itself inside the kernel's start
    // handler: the claim is on disk, the queued start never became a run.
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        CRASH_CHILD,
        fixture.store.root,
        fixture.repositoryPath,
      ],
      cwd: fixture.repositoryPath,
      stdout: "ignore",
      stderr: "ignore",
    });
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    const claimed = taskData((await getTask(fixture.store, task.key)).data);
    expect(claimed.phase).toBe("running");
    expect(claimed.run).toBeNull();

    const started = await tick(fixture);
    expect(started.length).toBe(1);
    expect(startedId(started[0] as { object?: { id: string } })).toBe(task.key);
    expect(taskData((await getTask(fixture.store, task.key)).data).phase).toBe(
      "running",
    );
    expect(fixture.lines).toEqual([
      `${task.id} running -> ready`,
      `${task.id} ready -> running`,
    ]);

    // A task whose run recorded itself is never claimed again.
    await putTask(fixture, task.key, { run: "run-1" });
    expect(await tick(fixture)).toEqual([]);
  });

  test("a claim whose run the kernel holds is not released before the run records itself", async () => {
    const fixture = await setup({ concurrency: 1 });
    const plan = await makePlan(fixture, { slug: "plan", auto: "run" });
    const task = await makeTask(fixture, plan.key, "task");
    await confirm(fixture, plan.key);

    const started = await tick(fixture);
    expect(started.length).toBe(1);
    const claimed = taskData((await getTask(fixture.store, task.key)).data);
    expect(claimed.phase).toBe("running");
    expect(claimed.run).toBeNull();

    // The kernel already holds the run; its first step has not written the
    // run id yet. The next tick must leave the claim alone, or the step finds
    // its claim gone, cancels, and the task starts again on every tick.
    const runs: RunLookup = {
      active: async (object?: string): Promise<readonly RunInfo[]> =>
        object === `task:${task.key}`
          ? [
              {
                runId: "run-1",
                flow: "dev",
                object,
                active: true,
                startedAt: 0,
                endedAt: null,
                lastSeq: 1,
                startInputId: null,
              },
            ]
          : [],
      state: async () => undefined,
      lastStep: async () => null,
    };
    await fixture.registry.tick(runs);
    expect(fixture.registry.takeStartedRuns()).toEqual([]);
    const after = taskData((await getTask(fixture.store, task.key)).data);
    expect(after.phase).toBe("running");
    expect(after.claim?.token).toBe(claimed.claim?.token);
    expect(fixture.lines).toEqual([`${task.id} ready -> running`]);
  });

  test("a manual start survives a crash before the run records itself", async () => {
    const fixture = await setup();
    const plan = await makePlan(fixture, { slug: "plan", auto: "off" });
    const task = await makeTask(fixture, plan.key, "task");
    await confirm(fixture, plan.key);
    await fixture.registry.runCommand(["dev", "start", task.id]);

    // The child claims the task and dies in the kernel's start handler: the
    // owner's request is still on the task and the run was never recorded.
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        CRASH_CHILD,
        fixture.store.root,
        fixture.repositoryPath,
      ],
      cwd: fixture.repositoryPath,
      stdout: "ignore",
      stderr: "ignore",
    });
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    const claimed = taskData((await getTask(fixture.store, task.key)).data);
    expect(claimed.phase).toBe("running");
    expect(claimed.run).toBeNull();
    expect(claimed.startRequested).toBe(true);

    // Recovery gives the claim back and the request starts the task once, even
    // though the plan is at auto off.
    const started = await tick(fixture);
    expect(started.length).toBe(1);
    expect(startedId(started[0] as { object?: { id: string } })).toBe(task.key);
    expect(fixture.lines).toEqual([
      `${task.id} running -> ready`,
      `${task.id} ready -> running`,
    ]);

    // Once the run records itself the request has been met: no third start.
    await putTask(fixture, task.key, { run: "run-1" });
    expect(await tick(fixture)).toEqual([]);
  });

  test("a cancelled task never starts work", async () => {
    const fixture = await setup();
    const log = openLog({ backend: "jsonl", path: join(fixture.root, "log") });
    try {
      const plan = await makePlan(fixture, { slug: "plan", auto: "run" });
      const task = await makeTask(fixture, plan.key, "task");
      await confirm(fixture, plan.key);

      // A tick writes the claim and queues the start; it is not drained, so
      // the run does not exist yet when the other process cancels.
      await fixture.registry.tick();
      const claimed = taskData((await getTask(fixture.store, task.key)).data);
      expect(claimed.phase).toBe("running");
      expect(claimed.run).toBeNull();
      expect(claimed.claim?.token).toBeString();

      const child = Bun.spawn({
        cmd: [
          process.execPath,
          CANCEL_CHILD,
          fixture.store.root,
          fixture.repositoryPath,
          task.key,
        ],
        cwd: fixture.repositoryPath,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(0);

      const spawned: string[] = [];
      await serveOnce({
        log,
        registry: fixture.registry,
        lockRoot: fixture.store.root,
        storeRoot: fixture.store.root,
        home: fixture.root,
        spawnRun: async (runId) => {
          spawned.push(runId);
          const found = fixture.registry.flow("dev");
          if (found === undefined) throw new Error("the dev flow is missing");
          const run = (await log.runs()).find(
            (candidate) => candidate.runId === runId,
          );
          if (run === undefined) throw new Error(`no run ${runId}`);
          const object = parseObjectKey(run.object);
          const startInput = readStoredStart(fixture.store.root, runId);
          await new Runner({
            log,
            flow: found.flow,
            runId,
            registry: fixture.registry,
            lockRoot: fixture.store.root,
            ...(object === undefined ? {} : { object }),
            ...(startInput === undefined ? {} : { startInput }),
          }).run();
        },
      });

      expect(spawned).toHaveLength(1);
      const runId = spawned[0] as string;
      const state = await readState(log, runId);
      expect(state.status).toBe("ended");
      expect(state.endedStatus).toBe("cancelled");

      const cancelled = taskData(
        (await getTask(fixture.store, task.key)).data,
      );
      expect(cancelled.phase).toBe("cancelled");
      expect(
        existsSync(join(fixture.repositoryPath, ".operad-worktrees", task.id)),
      ).toBe(false);
    } finally {
      await log.close();
    }
  });

  test("start still respects the repository concurrency", async () => {
    const fixture = await setup({ concurrency: 1 });
    const plan = await makePlan(fixture, { slug: "plan", auto: "off" });
    const first = await makeTask(fixture, plan.key, "first");
    const second = await makeTask(fixture, plan.key, "second");
    await confirm(fixture, plan.key);
    await fixture.registry.runCommand(["dev", "start", first.id]);
    await fixture.registry.runCommand(["dev", "start", second.id]);

    const one = await tick(fixture);
    expect(one.length).toBe(1);
    expect(startedId(one[0] as { object?: { id: string } })).toBe(first.key);

    await putTask(fixture, first.key, { run: "run-1" });
    await phase(fixture, first.key, "merged");
    const two = await tick(fixture);
    expect(two.length).toBe(1);
    expect(startedId(two[0] as { object?: { id: string } })).toBe(second.key);
  });

  test("start still respects a dependency", async () => {
    const fixture = await setup({ concurrency: 2 });
    const plan = await makePlan(fixture, { slug: "plan", auto: "off" });
    const first = await makeTask(fixture, plan.key, "first");
    const second = await makeTask(fixture, plan.key, "second", [first.id]);
    await confirm(fixture, plan.key);
    await fixture.registry.runCommand(["dev", "start", second.id]);

    expect(await tick(fixture)).toEqual([]);
    expect(taskData((await getTask(fixture.store, second.key)).data).phase).toBe(
      "ready",
    );

    await phase(fixture, first.key, "cancelled");
    const blocked = await tick(fixture);
    expect(blocked.length).toBe(1);
    expect(startedId(blocked[0] as { object?: { id: string } })).toBe(
      second.key,
    );
    expect(blocked[0]?.params).toEqual({
      blockedBy: first.id,
      token: expect.any(String),
    });
    expect(fixture.lines).toEqual([`${second.id} ready -> waiting`]);
  });

  test("a cancelled dependency leaves the dependent task as a person wait", async () => {
    const fixture = await setup({ concurrency: 2 });
    const plan = await makePlan(fixture, {
      slug: "plan",
      auto: "run",
      concurrency: 2,
    });
    const first = await makeTask(fixture, plan.key, "first");
    const second = await makeTask(fixture, plan.key, "second", [first.id]);
    await confirm(fixture, plan.key);
    await phase(fixture, first.key, "cancelled");

    const started = await tick(fixture);
    expect(started.length).toBe(1);
    expect(startedId(started[0] as { object?: { id: string } })).toBe(
      second.key,
    );
    expect(started[0]?.params).toEqual({
      blockedBy: first.id,
      token: expect.any(String),
    });
    expect(fixture.lines).toEqual([`${second.id} ready -> waiting`]);

    // The flow's worktree step turns that start into a logged person wait.
    const claimed = taskData((await getTask(fixture.store, second.key)).data);
    const stopped = await fixture.registry.runStep("dev/worktree", {}, {
      runId: "run-blocked",
      object: { type: "task", id: second.key, data: {} },
      params: {
        blockedBy: first.id,
        ...(claimed.claim === undefined || claimed.claim === null
          ? {}
          : { token: claimed.claim.token }),
      },
    });
    expect(stopped.result).toBe("blocked");
    const waiting = taskData((await getTask(fixture.store, second.key)).data);
    expect(waiting.phase).toBe("waiting");
    expect(waiting.run).toBe("run-blocked");
    expect(await tick(fixture)).toEqual([]);
  });

  test("a cancelled dependency is a pending item a person can answer", async () => {
    const fixture = await setup({ concurrency: 2 });
    const log = openLog({ backend: "jsonl", path: join(fixture.root, "log") });
    try {
      const plan = await makePlan(fixture, {
        slug: "plan",
        auto: "run",
        concurrency: 2,
      });
      const first = await makeTask(fixture, plan.key, "first");
      const second = await makeTask(fixture, plan.key, "second", [first.id]);
      await confirm(fixture, plan.key);
      await phase(fixture, first.key, "cancelled");

      const spawned: string[] = [];
      await serveOnce({
        log,
        registry: fixture.registry,
        lockRoot: fixture.store.root,
        storeRoot: fixture.store.root,
        home: fixture.root,
        spawnRun: async (runId) => {
          spawned.push(runId);
          const found = fixture.registry.flow("dev");
          if (found === undefined) throw new Error("the dev flow is missing");
          const run = (await log.runs()).find(
            (candidate) => candidate.runId === runId,
          );
          if (run === undefined) throw new Error(`no run ${runId}`);
          const object = parseObjectKey(run.object);
          const startInput = readStoredStart(fixture.store.root, runId);
          await new Runner({
            log,
            flow: found.flow,
            runId,
            registry: fixture.registry,
            lockRoot: fixture.store.root,
            ...(object === undefined ? {} : { object }),
            ...(startInput === undefined ? {} : { startInput }),
          }).run();
        },
      });

      expect(spawned).toHaveLength(1);
      const pending = await listPending(log, fixture.registry);
      expect(pending).toHaveLength(1);
      const item = pending[0];
      if (item === undefined) throw new Error("no pending item");
      expect(item.choices).toEqual(["merge", "reject", "rework", "reverify"]);
      expect(
        item.actions.map((action) => `${action.plugin}:${action.action}`),
      ).toEqual(["dev:cancel", "dev:merge", "dev:reject", "dev:rework", "dev:reverify"]);

      // The normal task action reaches the run: the wait has an answer handler.
      const answers: string[] = [];
      const answering = new PluginRegistry([plugin], {
        home: fixture.root,
        cwd: fixture.repositoryPath,
        store: fixture.store,
        storeRoot: fixture.store.root,
        onAnswer: async (runId, choice) => {
          answers.push(`${runId}:${choice}`);
        },
      });
      await answering.runAction(
        "dev/reject",
        { note: "start it" },
        {
          object: await getTask(fixture.store, second.key),
          runId: item.runId,
          actor: ACTOR,
        },
      );
      expect(answers).toEqual([`${item.runId}:reject`]);
    } finally {
      await log.close();
    }
  });

  test("serve repairs a task whose run ended without an edge, and reject runs again", async () => {
    const fixture = await setup();
    const plan = await makePlan(fixture, { slug: "plan", auto: "off" });
    const task = await makeTask(fixture, plan.key, "task");
    await confirm(fixture, plan.key);
    const log = openLog({ backend: "jsonl", path: join(fixture.root, "log") });
    try {
      // The state T-0001 was left in: the run stopped in `work` with a result
      // that had no edge, and the task still said waiting with that run id.
      const broken = await log.startRun("dev", `task:${task.key}`);
      await log.append(broken.runId, 0, [
        { kind: "run_started", payload: { flow: "dev" }, cause: "seed" },
        {
          kind: "step_entered",
          payload: { step: "work", visit: 1, kind: "plugin" },
          cause: 1,
        },
        {
          kind: "run_ended",
          payload: { status: "failed", reason: "no edge for result interrupted" },
          cause: 2,
        },
      ]);
      await log.endRun(broken.runId);
      await phase(fixture, task.key, "waiting", broken.runId);

      let registry: PluginRegistry;
      const answers: { readonly runId: string; readonly choice: string }[] = [];
      registry = new PluginRegistry([plugin], {
        home: fixture.root,
        cwd: fixture.repositoryPath,
        store: fixture.store,
        storeRoot: fixture.store.root,
        onAnswer: async (runId, choice, note, actor) => {
          answers.push({ runId, choice });
          await recordAnswer({
            log,
            runId,
            choice,
            ...(note === undefined ? {} : { note }),
            actor,
          });
        },
      });

      const spawn = async (runId: string, options: { readonly recover: boolean }) => {
        const found = registry.flow("dev");
        if (found === undefined) throw new Error("the dev flow is missing");
        const run = (await log.runs()).find(
          (candidate) => candidate.runId === runId,
        );
        if (run === undefined) throw new Error(`no run ${runId}`);
        const object = parseObjectKey(run.object);
        const startInput = readStoredStart(fixture.store.root, runId);
        await new Runner({
          log,
          flow: found.flow,
          runId,
          registry,
          lockRoot: fixture.store.root,
          recover: options.recover,
          ...(object === undefined ? {} : { object }),
          ...(startInput === undefined ? {} : { startInput }),
        }).run();
      };

      await serveOnce({
        log,
        registry,
        lockRoot: fixture.store.root,
        storeRoot: fixture.store.root,
        home: fixture.root,
        spawnRun: spawn,
      });

      const repaired = taskData((await getTask(fixture.store, task.key)).data);
      expect(repaired.phase).toBe("waiting");
      expect(repaired.run).not.toBe(broken.runId);
      expect(fixture.lines).toEqual([
        `${task.id} waiting -> waiting (run stopped during work)`,
      ]);

      const pending = await listPending(log, registry);
      expect(pending).toHaveLength(1);
      const item = pending[0];
      if (item === undefined) throw new Error("no pending item");
      expect(item.prompt).toContain(
        "the run stopped during work; reject to run it again",
      );
      expect(
        item.actions.map((action) => `${action.plugin}:${action.action}`),
      ).toContain("dev:reject");

      // Rejecting records the answer only; the next serve pass runs a new
      // attempt from the worktree step.
      await registry.runAction(
        "dev/reject",
        { note: "try again" },
        {
          object: await getTask(fixture.store, task.key),
          runId: item.runId,
          actor: ACTOR,
        },
      );
      expect(answers).toEqual([{ runId: item.runId, choice: "reject" }]);
      const before = taskData((await getTask(fixture.store, task.key)).data);
      await serveOnce({
        log,
        registry,
        lockRoot: fixture.store.root,
        storeRoot: fixture.store.root,
        home: fixture.root,
        spawnRun: spawn,
      });
      const after = taskData((await getTask(fixture.store, task.key)).data);
      expect(after.attempts).toBe(before.attempts + 1);
      expect(after.attempt?.worktree).toBeTruthy();
    } finally {
      await log.close();
    }
  });

  test("a finished plan is reported once", async () => {
    const fixture = await setup();
    const plan = await makePlan(fixture, { slug: "plan", auto: "off" });
    const first = await makeTask(fixture, plan.key, "first");
    const second = await makeTask(fixture, plan.key, "second");
    await confirm(fixture, plan.key);
    await phase(fixture, first.key, "merged");
    await phase(fixture, second.key, "merged");

    await tick(fixture);
    expect(fixture.lines).toEqual([`${plan.id} confirmed -> finished`]);
    expect(
      planData((await getPlan(fixture.store, plan.key)).data).finishedReported,
    ).toBe(true);

    await tick(fixture);
    expect(fixture.lines).toEqual([`${plan.id} confirmed -> finished`]);
  });

  test("a task cancelled mid-run cancels its run through the kernel", async () => {
    const fixture = await setup();
    const plan = await makePlan(fixture, { slug: "plan", auto: "run" });
    const task = await makeTask(fixture, plan.key, "task");
    await confirm(fixture, plan.key);

    expect((await tick(fixture)).length).toBe(1);
    await phase(fixture, task.key, "running", "run-1");

    await fixture.registry.runAction("dev/cancel", {}, {
      object: await getTask(fixture.store, task.key),
      actor: ACTOR,
    });
    expect(fixture.cancelled).toEqual(["run-1"]);
    expect(taskData((await getTask(fixture.store, task.key)).data).phase).toBe(
      "cancelled",
    );
    expect(await tick(fixture)).toEqual([]);
  });

  test("each registered repository is scheduled on its own", async () => {
    const fixture = await setup();
    const secondPath = await makeGitRepository(fixture.repositoryPath, "second");
    const second = await addRepository(fixture.store, { path: secondPath });

    const firstPlan = await makePlan(fixture, { slug: "one", auto: "run" });
    await makeTask(fixture, firstPlan.key, "first");
    await confirm(fixture, firstPlan.key);

    const secondPlan = await addPlan(fixture.store, {
      repository: second,
      slug: "two",
      title: "two",
    });
    await setAuto(fixture.store, secondPlan.id, "run");
    await addTask(fixture.store, {
      plan: secondPlan.id,
      slug: "second",
      title: "second",
    });
    await confirmPlan(fixture.store, secondPlan.id);

    const started = await tick(fixture);
    expect(started.length).toBe(2);
  });

  test("an area holds back a second task while concurrency allows three", async () => {
    const fixture = await setup({ concurrency: 3 });
    const plan = await makePlan(fixture, { slug: "plan", auto: "run", concurrency: 3 });
    const first = await addTask(fixture.store, { plan: plan.key, slug: "a-one", title: "a-one", area: "core" });
    const second = await addTask(fixture.store, { plan: plan.key, slug: "a-two", title: "a-two", area: "core" });
    const free = await makeTask(fixture, plan.key, "free");
    await confirm(fixture, plan.key);

    const started = (await tick(fixture)).map((request) => startedId(request));
    expect(started.sort()).toEqual([first.id, free.key].sort());
    const held = taskData((await getTask(fixture.store, second.id)).data);
    expect(held.phase).toBe("ready");
    expect(taskViews.row(await getTask(fixture.store, second.id)).note).toBe(
      `waiting for area core (${bareId(first.id)})`,
    );

    // The holder is still running: later ticks keep holding the second task.
    await putTask(fixture, first.id, { run: "run-1" });
    await putTask(fixture, free.key, { run: "run-2" });
    expect(await tick(fixture)).toEqual([]);

    await phase(fixture, first.id, "merged");
    const next = await tick(fixture);
    expect(next.map((request) => startedId(request))).toEqual([second.id]);
    const running = await getTask(fixture.store, second.id);
    expect(taskData(running.data).areaHeldBy).toBeUndefined();
    expect(taskViews.row(running).note).toBe("area: core");
  });

  test("a task in the review phase still holds its area", async () => {
    const fixture = await setup({ concurrency: 3 });
    const plan = await makePlan(fixture, { slug: "plan", auto: "run", concurrency: 3 });
    const first = await addTask(fixture.store, { plan: plan.key, slug: "a-one", title: "a-one", area: "core" });
    await addTask(fixture.store, { plan: plan.key, slug: "a-two", title: "a-two", area: "core" });
    await confirm(fixture, plan.key);
    await tick(fixture);
    await putTask(fixture, first.id, { run: "run-1", phase: "review" });
    expect(await tick(fixture)).toEqual([]);
  });

  test("the same area in another repository does not block", async () => {
    const fixture = await setup();
    const secondPath = await makeGitRepository(fixture.repositoryPath, "second");
    const second = await addRepository(fixture.store, { path: secondPath });
    const firstPlan = await makePlan(fixture, { slug: "one", auto: "run" });
    await addTask(fixture.store, { plan: firstPlan.key, slug: "first", title: "first", area: "core" });
    await confirm(fixture, firstPlan.key);
    const secondPlan = await addPlan(fixture.store, { repository: second, slug: "two", title: "two" });
    await setAuto(fixture.store, secondPlan.id, "run");
    await addTask(fixture.store, { plan: secondPlan.id, slug: "second", title: "second", area: "core" });
    await confirmPlan(fixture.store, secondPlan.id);
    expect((await tick(fixture)).length).toBe(2);
  });

  test("changing the area of a ready task takes effect on the next tick", async () => {
    const fixture = await setup({ concurrency: 3 });
    const plan = await makePlan(fixture, { slug: "plan", auto: "run", concurrency: 3 });
    const first = await addTask(fixture.store, { plan: plan.key, slug: "a-one", title: "a-one", area: "core" });
    const second = await addTask(fixture.store, { plan: plan.key, slug: "a-two", title: "a-two", area: "core" });
    await confirm(fixture, plan.key);
    await tick(fixture);
    await putTask(fixture, first.id, { run: "run-1" });
    expect(taskData((await getTask(fixture.store, second.id)).data).areaHeldBy).toBe(
      bareId(first.id),
    );

    await updateTask(fixture.store, second.id, { area: "docs" });
    const changed = taskData((await getTask(fixture.store, second.id)).data);
    expect(changed.area).toBe("docs");
    expect(changed.areaHeldBy).toBeUndefined();
    expect(changed.brief).toContain("area: docs");
    expect((await tick(fixture)).map((request) => startedId(request))).toEqual([second.id]);
    await putTask(fixture, second.id, { run: "run-2" });

    // Clearing the area also frees a held task.
    const third = await addTask(fixture.store, { plan: plan.key, slug: "a-three", title: "a-three", area: "core" });
    await phase(fixture, third.id, "ready");
    await tick(fixture);
    expect(taskData((await getTask(fixture.store, third.id)).data).phase).toBe("ready");
    await updateTask(fixture.store, third.id, { area: "" });
    expect(taskData((await getTask(fixture.store, third.id)).data).area).toBeUndefined();
    expect((await tick(fixture)).map((request) => startedId(request))).toEqual([third.id]);
  });

  test("two schedulers on one store never start two tasks of one area", async () => {
    const fixture = await setup({ concurrency: 3 });
    const plan = await makePlan(fixture, { slug: "plan", auto: "run", concurrency: 3 });
    const first = await addTask(fixture.store, { plan: plan.key, slug: "a-one", title: "a-one", area: "core" });
    const second = await addTask(fixture.store, { plan: plan.key, slug: "a-two", title: "a-two", area: "core" });
    await confirm(fixture, plan.key);

    const other = new PluginRegistry([plugin], {
      home: fixture.root,
      cwd: fixture.repositoryPath,
      store: fixture.store,
      storeRoot: fixture.store.root,
      onAnswer: async () => {},
      onCancelRun: () => {},
    });
    await Promise.all([fixture.registry.tick(), other.tick()]);
    const started = [...fixture.registry.takeStartedRuns(), ...other.takeStartedRuns()];
    expect(started.length).toBe(1);
    const phases = await Promise.all(
      [first.id, second.id].map(
        async (key) => taskData((await getTask(fixture.store, key)).data).phase,
      ),
    );
    expect(phases.sort()).toEqual(["ready", "running"]);

    // The claim itself is the decision: both claims at once, one wins.
    const fresh = await setup({ concurrency: 3 });
    const freshPlan = await makePlan(fresh, { slug: "plan", auto: "off" });
    const one = await addTask(fresh.store, { plan: freshPlan.key, slug: "one", title: "one", area: "core" });
    const two = await addTask(fresh.store, { plan: freshPlan.key, slug: "two", title: "two", area: "core" });
    await phase(fresh, one.id, "ready");
    await phase(fresh, two.id, "ready");
    const claims = await Promise.all([
      claimTaskStart(fresh.store, one.id),
      claimTaskStart(fresh.store, two.id),
    ]);
    expect(claims.filter((claim) => claim !== undefined).length).toBe(1);
  });

  test("a claim is refused while a task of the area is running or reviewing", async () => {
    const fixture = await setup({ concurrency: 3 });
    const plan = await makePlan(fixture, { slug: "plan", auto: "off" });
    const holder = await addTask(fixture.store, { plan: plan.key, slug: "holder", title: "holder", area: "core" });
    const waiting = await addTask(fixture.store, { plan: plan.key, slug: "waiting", title: "waiting", area: "core" });
    await phase(fixture, waiting.id, "ready");
    for (const held of ["running", "review"] as const) {
      await putTask(fixture, holder.id, { phase: held, run: "run-1" });
      expect(await claimTaskStart(fixture.store, waiting.id)).toBeUndefined();
    }
    await putTask(fixture, holder.id, { phase: "waiting", run: "run-1" });
    expect(await claimTaskStart(fixture.store, waiting.id)).toBeDefined();
  });

  test("a plan raised to 2 starts two ready tasks of different areas in one tick, at 1 only one", async () => {
    const fixture = await setup({ concurrency: 4 });
    const plan = await makePlan(fixture, { slug: "plan", auto: "run" });
    await addTask(fixture.store, { plan: plan.key, slug: "a", title: "a", area: "one" });
    await addTask(fixture.store, { plan: plan.key, slug: "b", title: "b", area: "two" });
    await confirm(fixture, plan.key);
    expect((await tick(fixture)).length).toBe(1);

    const other = await setup({ concurrency: 4 });
    const wide = await makePlan(other, { slug: "wide", auto: "run" });
    await setConcurrency(other.store, wide.key, 2);
    await addTask(other.store, { plan: wide.key, slug: "c", title: "c", area: "three" });
    await addTask(other.store, { plan: wide.key, slug: "d", title: "d", area: "four" });
    await confirm(other, wide.key);
    expect((await tick(other)).length).toBe(2);
  });

  test("lowering a plan below its running count cancels nothing and starts nothing until under it", async () => {
    const fixture = await setup({ concurrency: 4 });
    const plan = await makePlan(fixture, { slug: "plan", auto: "run" });
    await setConcurrency(fixture.store, plan.key, 3);
    const tasks = [
      await addTask(fixture.store, { plan: plan.key, slug: "a", title: "a", area: "one" }),
      await addTask(fixture.store, { plan: plan.key, slug: "b", title: "b", area: "two" }),
      await addTask(fixture.store, { plan: plan.key, slug: "c", title: "c", area: "three" }),
      await addTask(fixture.store, { plan: plan.key, slug: "d", title: "d", area: "four" }),
    ];
    await confirm(fixture, plan.key);
    const started = (await tick(fixture)).map((request) => startedId(request));
    expect(started.length).toBe(3);
    let run = 0;
    for (const id of started) await putTask(fixture, id, { run: `run-${(run += 1)}` });

    await setConcurrency(fixture.store, plan.key, 1);
    expect(await tick(fixture)).toEqual([]);
    expect(fixture.cancelled).toEqual([]);

    // Two of the three finish: one still runs, which fills the new count.
    await phase(fixture, started[0] ?? "", "merged");
    await phase(fixture, started[1] ?? "", "merged");
    expect(await tick(fixture)).toEqual([]);
    await phase(fixture, started[2] ?? "", "merged");
    const next = await tick(fixture);
    expect(next.length).toBe(1);
    expect(tasks.map((task) => task.id)).toContain(startedId(next[0] as { object?: { id: string } }));
  });

  test("a plan at 5 in a repository at 3 runs 3, and one area never runs twice", async () => {
    const fixture = await setup({ concurrency: 3 });
    const plan = await makePlan(fixture, { slug: "plan", auto: "run" });
    await setConcurrency(fixture.store, plan.key, 5);
    for (const slug of ["a", "b", "c", "d"]) {
      await addTask(fixture.store, { plan: plan.key, slug, title: slug, area: slug });
    }
    await confirm(fixture, plan.key);
    expect((await tick(fixture)).length).toBe(3);

    const same = await setup({ concurrency: 4 });
    const samePlan = await makePlan(same, { slug: "plan", auto: "run" });
    await setConcurrency(same.store, samePlan.key, 4);
    for (const slug of ["a", "b"]) {
      await addTask(same.store, { plan: samePlan.key, slug, title: slug, area: "core" });
    }
    await confirm(same, samePlan.key);
    expect((await tick(same)).length).toBe(1);
  });
});
