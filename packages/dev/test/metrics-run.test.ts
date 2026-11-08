import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  currentRunStep,
  decide,
  evolve,
  FilePluginStore,
  initialState,
  openLog,
  PluginRegistry,
  type Effect,
  type Input,
  type KernelState,
  type LogBackend,
} from "@operad-io/engine";
import plugin from "../src/index.ts";
import { addPlan, addRepository, addTask, getTask } from "../src/service.ts";
import { taskData } from "../src/model.ts";
import { metrics } from "../src/views.ts";
import { cleanupTempRoots, guardLockHandles, makeGitRepository, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const T0 = 1_000_000;
const SECOND = 1000;

/**
 * One task and one run of the real dev flow. The run's facts come from the
 * kernel's own `decide` and `evolve` and are written to a real log; the
 * task's facts are written the way the dev steps write them. Metrics reads
 * the run's step through `currentRunStep`, the source `operad running` uses.
 */
async function world() {
  const root = await tempRoot();
  const repositoryPath = await makeGitRepository(root);
  let now = T0;
  const store = new FilePluginStore({ root: join(root, "store"), clock: () => now });
  const repository = await addRepository(store, { path: repositoryPath });
  const plan = await addPlan(store, { repository, slug: "p", title: "P", request: "r" });
  const task = await addTask(store, { plan: plan.id, slug: "one", title: "One", brief: "b" });
  const stored = taskData((await getTask(store, task.id)).data);
  const registry = new PluginRegistry([plugin], {
    home: root,
    cwd: repositoryPath,
    store,
    storeRoot: store.root,
  });
  const found = registry.flow("dev");
  if (found === undefined) throw new Error("the dev flow is missing");
  const flow = found.flow;
  const log: LogBackend = openLog({ backend: "jsonl", path: join(store.root, "log"), clock: () => now });
  const info = await log.startRun("dev", `task:${task.id}`);
  const runId = info.runId;
  let state: KernelState = initialState();
  let effectId = "";
  let waitId = "";
  let inputs = 0;

  const feed = async (build: (inputId: string) => Input): Promise<void> => {
    inputs += 1;
    const recorded = await log.recordInput(runId, "test", String(inputs), {});
    const decision = decide(flow, state, build(recorded.inputId), now);
    await log.append(runId, state.lastSeq, decision.facts);
    for (const fact of decision.facts) state = evolve(state, fact);
    for (const effect of decision.effects as readonly Effect[]) {
      if (effect.kind === "notify_pending") waitId = effect.waitId;
      else effectId = effect.effectId;
    }
    if (state.status === "ended") await log.endRun(runId);
  };

  return {
    at(ms: number): void {
      now = T0 + ms * SECOND;
    },
    async start(): Promise<void> {
      await feed((inputId) => ({ kind: "start", inputId }));
    },
    async result(result: string): Promise<void> {
      await feed((inputId) => ({ kind: "step_result", effectId, result, inputId }));
    },
    async answer(choice: string): Promise<void> {
      await feed((inputId) => ({
        kind: "person_answer",
        waitId,
        choice,
        actor: { via: "test", id: "t" },
        inputId,
      }));
    },
    /** Writes the task as a dev step does, with the run that is on it. */
    async put(cause: string, attempt: Record<string, unknown>, phase = "running"): Promise<void> {
      await store.put("task", task.id, { ...stored, phase, run: runId, attempt }, cause);
    },
    /** The Metrics text at the given second. */
    async show(ms: number): Promise<{ row: string; line: string; text: string }> {
      this.at(ms);
      const text = await metrics(
        { store, runStep: (id: string) => currentRunStep(log, id) } as never,
        await getTask(store, task.id),
        now,
      );
      const rows = text.split("\n");
      return {
        row: rows.find((row) => row.startsWith("| 1 |")) ?? "",
        line: rows.find((row) => row.startsWith("**#1**")) ?? "",
        text,
      };
    },
    log,
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** The run starts, prepares the worktree (2s), and the worker works for 60s. */
async function toVerify(w: World): Promise<void> {
  await w.put("test:start", { number: 1 });
  await w.start();
  w.at(2);
  await w.put("dev:worktree", { number: 1 });
  await w.result("ready");
  w.at(62);
  await w.put("dev:work", { number: 1, workMs: 60 * SECOND });
  await w.result("done");
}

/** Through verify (10s) and a passing review (20s) to the person wait. */
async function toWait(w: World): Promise<void> {
  await toVerify(w);
  w.at(72);
  await w.put("dev:verify", { number: 1, verify: { result: "pass" } });
  await w.result("pass");
  w.at(92);
  await w.put("dev:review", { number: 1, review: { result: "passed" } }, "waiting");
  await w.result("pass");
  await w.result("done");
}

interface Case {
  readonly name: string;
  readonly run: (w: World) => Promise<{ row: string; line: string }>;
  readonly row: string;
  readonly line: string;
}

const CASES: readonly Case[] = [
  {
    name: "a normal run: verify is the run's step",
    run: async (w) => {
      await toVerify(w);
      return w.show(92);
    },
    row: "| running verify |",
    line: "**#1** worktree 2s · work 1m00s · verify 30s (running)",
  },
  {
    name: "a retried review: the retry wait runs, then the review with its pending run",
    run: async (w) => {
      await toVerify(w);
      w.at(72);
      await w.put("dev:verify", { number: 1, verify: { result: "pass" } });
      await w.result("pass");
      w.at(92);
      await w.put("dev:review", { number: 1, review: { result: "unavailable" } }, "waiting");
      await w.result("unavailable");
      const waiting = await w.show(97);
      expect(waiting.row).toContain("| running review retry |");
      expect(waiting.line).toContain("review 20s · review retry 5s (running)");
      await w.result("ready");
      w.at(104);
      await w.put(
        "dev:review",
        { number: 1, review: { result: "unavailable" }, reviewPending: { round: 2 } },
        "waiting",
      );
      return w.show(107);
    },
    row: "| running review |",
    line: "worktree 2s · work 1m00s · verify 10s · review 35s (running)",
  },
  {
    name: "a work retry after an unavailable model: the wait runs and verify never did",
    run: async (w) => {
      await w.put("test:start", { number: 1 });
      await w.start();
      w.at(2);
      await w.put("dev:worktree", { number: 1 });
      await w.result("ready");
      w.at(42);
      await w.put("dev:work", { number: 1, result: "unavailable", workRetryAt: T0 + 600 * SECOND, workMs: 40 * SECOND });
      await w.result("unavailable");
      return w.show(47);
    },
    row: "| running work retry |",
    line: "**#1** worktree 2s · work 40s · work retry 5s (running)",
  },
  {
    name: "a reverify after a person's answer",
    run: async (w) => {
      await toWait(w);
      const waiting = await w.show(100);
      expect(waiting.row).toContain("| review passed |");
      expect(waiting.line).not.toContain("(running)");
      w.at(110);
      await w.answer("reverify");
      return w.show(114);
    },
    row: "| running reverify |",
    line: "work 1m00s · reverify 4s (running) · verify 10s · review 20s",
  },
  {
    name: "a rework after a person's answer starts a worktree, not integrate",
    run: async (w) => {
      await toWait(w);
      w.at(110);
      await w.answer("rework");
      return w.show(114);
    },
    row: "| running worktree |",
    line: "worktree 6s (running) · work 1m00s · verify 10s · review 20s",
  },
  {
    name: "an integrate in flight while the task waits",
    run: async (w) => {
      await toWait(w);
      w.at(110);
      await w.answer("merge");
      // The merge action writes the task when it answers the wait.
      await w.put("dev:task-merge", { number: 1, review: { result: "passed" } }, "waiting");
      w.at(113);
      await w.put(
        "dev:integrate",
        { number: 1, review: { result: "passed" }, integrating: "run", integration: { result: "pending" } },
        "waiting",
      );
      return w.show(117);
    },
    row: "| running integrate |",
    line: "review 20s · integrate 7s (running)",
  },
  {
    name: "a failed worktree ends the run: nothing runs and no later step is shown",
    run: async (w) => {
      await w.put("test:start", { number: 1 });
      await w.start();
      w.at(5);
      await w.put("dev:worktree", { number: 1, result: "failed" });
      await w.result("failed");
      return w.show(30);
    },
    row: "| worktree failed |",
    line: "**#1** worktree 5s",
  },
  {
    name: "a failed gate: the rework step runs, then the person wait shows the failure",
    run: async (w) => {
      await toVerify(w);
      w.at(72);
      await w.put("dev:verify", { number: 1, verify: { result: "fail" } });
      await w.result("fail");
      const reworking = await w.show(74);
      expect(reworking.row).toContain("| running rework |");
      expect(reworking.line).toContain("verify 10s · rework 2s (running)");
      await w.result("ask");
      await w.result("done");
      return w.show(80);
    },
    row: "| verify failed |",
    line: "**#1** worktree 2s · work 1m00s · verify 10s",
  },
];

describe("metrics follow the run's own step", () => {
  for (const item of CASES) {
    test(item.name, async () => {
      const w = await world();
      try {
        const seen = await item.run(w);
        expect(seen.row).toContain(item.row);
        expect(seen.line).toContain(item.line.replace("**#1** ", ""));
        if (!item.row.startsWith("| running")) expect(seen.line).not.toContain("(running)");
      } finally {
        await w.log.close();
      }
    });
  }

  test("a task cancelled while its worker runs keeps the time up to the cancel", async () => {
    const w = await world();
    try {
      await w.put("test:start", { number: 1 });
      await w.start();
      w.at(2);
      await w.put("dev:worktree", { number: 1 });
      await w.result("ready");
      // The worker runs for twenty minutes, then the task is cancelled.
      w.at(1200);
      await w.put("dev:task-cancel", { number: 1 }, "cancelled");
      await w.log.endRun((await w.log.runs())[0]?.runId ?? "");
      const seen = await w.show(1500);
      expect(seen.row).toBe("| 1 | 20m | – | cancelled |");
      expect(seen.text).toContain("| total | 20m | – | |");
      expect(seen.text).not.toContain("(running)");
    } finally {
      await w.log.close();
    }
  });

  test("a run that is not active shows nothing as running, whatever the phase says", async () => {
    const w = await world();
    try {
      await toVerify(w);
      w.at(72);
      await w.put("dev:verify", { number: 1, verify: { result: "pass" } });
      // The run ends (cancelled) while the task still says it is running.
      await w.log.endRun((await w.log.runs())[0]?.runId ?? "");
      const seen = await w.show(80);
      expect(seen.text).not.toContain("running");
      expect(seen.text).not.toContain("(running)");
    } finally {
      await w.log.close();
    }
  });
});
