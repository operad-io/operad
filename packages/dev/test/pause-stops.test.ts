import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cancelRun,
  definePlugin,
  openLog,
  parseObjectKey,
  PluginRegistry,
  Runner,
  type StepContext,
  type FlowDefinition,
  type PluginStepResult,
} from "@operad-io/engine";
import { runLine } from "@operad-io/engine/platform";
import { createPoolPlugin } from "@operad-io/pool";
import { createShellPlugin } from "@operad-io/shell";
import {
  addPlan,
  addRepository,
  addTask,
  cancelTask,
  createDevPlugin,
  getTask,
  pauseTask,
  resumeTask,
  setTaskPhase,
  taskData,
} from "../src/index.ts";
import { withCheckPlace } from "../src/places.ts";
import { commitIn, gitOrThrow, makeRemote } from "./git-support.ts";
import { cleanupTempRoots, guardLockHandles, osTempRoot, storeAt, tempRoot } from "./support.ts";

setDefaultTimeout(60_000);
afterAll(cleanupTempRoots);
guardLockHandles();

/** Resolves when the file exists; a look every 20 ms, there is no event to wait for. */
async function fileAppears(path: string): Promise<string> {
  while (!existsSync(path)) await new Promise((done) => setTimeout(done, 20));
  for (;;) {
    const text = readFileSync(path, "utf8").trim();
    if (text !== "") return text;
    await new Promise((done) => setTimeout(done, 20));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The shell's pid and its child's, written by the waiting command. */
async function pidsIn(path: string): Promise<number[]> {
  return (await fileAppears(path)).split(/\s+/).map(Number);
}

/** Resolves when every pid is gone. */
async function allGone(pids: readonly number[]): Promise<void> {
  for (const pid of pids) await gone(pid);
}

/** Resolves when `pid` is gone. */
async function gone(pid: number): Promise<void> {
  while (alive(pid)) await new Promise((done) => setTimeout(done, 20));
}

type Stop = "pause" | "cancel";

async function setup(options: { readonly check: boolean }) {
  const root = await tempRoot();
  const home = await osTempRoot();
  const remote = await makeRemote(root);
  const store = storeAt(root);
  const pidFile = join(root, "pid");
  // The shell and a child of it, both in the command's process group; `wait` never ends.
  const waiting = `sleep 600 & echo "$$ $!" > '${pidFile}'; wait`;
  const gate = options.check ? { commands: [waiting], commandTimeoutSecs: 600 } : { commands: [] };
  mkdirSync(join(remote.repository, ".operad"), { recursive: true });
  writeFileSync(
    join(remote.repository, ".operad", "dev.json"),
    JSON.stringify({
      name: "repository",
      remote: "origin",
      mainBranch: "main",
      worktreeRoot: ".operad-worktrees",
      worker: { use: "fake-harness/agent", args: [] },
      gate,
    }),
  );
  const repository = await addRepository(store, { path: remote.repository, name: "repository" });
  const plan = await addPlan(store, { repository, slug: "plan", title: "Plan", request: "do it" });
  const task = await addTask(store, { plan: plan.id, slug: "task", title: "Task", brief: "Write." });
  const taskId = task.id.slice(task.id.indexOf("/") + 1);
  gitOrThrow(remote.repository, ["branch", `work/${taskId}`, "main"]);
  const path = join(root, "pre");
  gitOrThrow(remote.repository, ["worktree", "add", path, `work/${taskId}`]);
  await commitIn(path, "f.txt", "x\n", "earlier work");
  gitOrThrow(remote.repository, ["worktree", "remove", "--force", path]);

  const harness = { started: 0, aborted: 0 };
  const worker = definePlugin({
    name: "fake-harness",
    kind: "harness",
    version: "0.0.0",
    steps: [
      {
        name: "agent",
        results: ["done", "failed", "interrupted"],
        run: async (ctx: StepContext): Promise<PluginStepResult> => {
          harness.started += 1;
          if (options.check) return { result: "done", data: {} };
          const outcome = await runLine({
            line: waiting,
            cwd: root,
            signal: ctx.signal,
            logger: ctx.logger,
          });
          if (outcome.cancelled) harness.aborted += 1;
          return { result: outcome.cancelled ? "interrupted" : "done", data: {} };
        },
      },
    ],
  });
  const registry = new PluginRegistry(
    [createDevPlugin(), createPoolPlugin(), createShellPlugin(), worker] as never,
    { home, cwd: remote.repository, store },
  );
  const log = openLog({ backend: "jsonl", path: join(root, "log") });
  const found = registry.flow("dev");
  if (found === undefined) throw new Error("the dev flow is missing");
  const flow: FlowDefinition = found.flow;
  const control = {
    cancel: async (runId: string, graph?: FlowDefinition): Promise<void> => {
      await cancelRun({ log, flow: () => flow, runId, graph });
    },
  };
  /** Starts a run of the task as the scheduler does: the task is running and names it. */
  const start = async (): Promise<{ readonly runId: string; readonly ended: Promise<string> }> => {
    const { runId } = await log.startRun("dev", `task:${task.id}`);
    await setTaskPhase(store, task.id, "running", { run: runId });
    const object = parseObjectKey(`task:${task.id}`);
    const ended = new Runner({
      log,
      flow,
      runId,
      registry,
      ...(object === undefined ? {} : { object }),
    }).run();
    return { runId, ended };
  };
  const data = async () => taskData((await getTask(store, task.id)).data);
  return { root, home, store, task, pidFile, harness, control, start, data };
}

describe("pause and cancel stop what the step started", () => {
  for (const stop of ["pause", "cancel"] as const satisfies readonly Stop[]) {
    test(`${stop} while the check command runs ends its processes and frees the place`, async () => {
      const s = await setup({ check: true });
      const first = await s.start();
      const pid = await pidsIn(s.pidFile);
      expect(pid.every(alive)).toBe(true);

      // A second check that wants a place waits: one of the two is the check, the other ours.
      const places = { home: s.home, checks: 2, log: () => {} };
      let release: () => void = () => {};
      const holder = new Promise<void>((done) => (release = done));
      let taken: () => void = () => {};
      const holding = new Promise<void>((done) => (taken = done));
      const mine = withCheckPlace(places, async () => {
        taken();
        await holder;
      });
      await holding;
      let second = false;
      const waiter = withCheckPlace(places, () => {
        second = true;
      });

      const before = await s.data();
      if (stop === "pause") await pauseTask(s.store, s.task.id, { runs: s.control });
      else await cancelTask(s.store, s.task.id, { runs: s.control });
      await first.ended;
      await allGone(pid);
      await waiter;
      expect(second).toBe(true);
      release();
      await mine;

      const after = await s.data();
      expect(after.phase).toBe(stop === "pause" ? "paused" : "cancelled");
      expect(after.attempts).toBe(before.attempts);
      expect(after.attempt?.branch).toBe(before.attempt?.branch);
      if (stop === "pause") {
        expect(existsSync(after.attempt?.worktree ?? "")).toBe(true);
        rmSync(s.pidFile);
        await resumeTask(s.store, s.task.id);
        const again = await s.start();
        const next = await pidsIn(s.pidFile);
        expect(next).not.toEqual(pid);
        await pauseTask(s.store, s.task.id, { runs: s.control });
        await again.ended;
        await allGone(next);
      }
    });
  }

  for (const stop of ["pause", "cancel"] as const satisfies readonly Stop[]) {
    test(`${stop} while the worker step runs ends its processes`, async () => {
      const s = await setup({ check: false });
      const first = await s.start();
      const pid = await pidsIn(s.pidFile);
      if (stop === "pause") await pauseTask(s.store, s.task.id, { runs: s.control });
      else await cancelTask(s.store, s.task.id, { runs: s.control });
      await first.ended;
      await allGone(pid);
      expect(s.harness.aborted).toBe(1);
      expect((await s.data()).phase).toBe(stop === "pause" ? "paused" : "cancelled");
      if (stop === "pause") {
        rmSync(s.pidFile);
        await resumeTask(s.store, s.task.id);
        const again = await s.start();
        const next = await pidsIn(s.pidFile);
        expect(next).not.toEqual(pid);
        await pauseTask(s.store, s.task.id, { runs: s.control });
        await again.ended;
        await allGone(next);
        expect(s.harness.started).toBe(2);
      }
    });
  }
});
