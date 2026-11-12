import { createPoolPlugin } from "@operad-io/pool";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  definePlugin,
  openLog,
  parseObjectKey,
  PluginRegistry,
  Runner,
  type PluginStepResult,
  type StepEvent,
} from "@operad-io/engine";
import { createShellPlugin } from "@operad-io/shell";
import { addPlan, addRepository, addTask, createDevPlugin, taskData } from "../../src/index.ts";
import { commitIn, gitOrThrow, makeRemote } from "../git-support.ts";
import { cleanupTempRoots, guardLockHandles, storeAt, tempRoot } from "../support.ts";

setDefaultTimeout(60_000);
afterAll(cleanupTempRoots);
guardLockHandles();

const NOTE = "the branch already has unchecked work; checking it";

interface Run {
  readonly outcome: string;
  readonly reasons: readonly string[];
  readonly steps: readonly string[];
  readonly whys: readonly string[];
  readonly verified: unknown;
  readonly head: string;
  readonly replayed: readonly boolean[];
  /** The commit each review call found checked out. */
  readonly reviewed: readonly string[];
}

/** Runs the dev flow once; the branch has `commits` made before the run and the worker commits nothing. */
async function run(options: {
  readonly commits: number;
  /** An earlier verify of the branch head, recorded in the task before the run. */
  readonly verify?: "pass" | "fail";
  /** Record that verify as made by the run itself, as in a rework round of one run. */
  readonly sameRun?: boolean;
  /** Commits the worker makes in its worktree before it ends. */
  readonly workerCommits?: number;
}): Promise<Run> {
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
      gate: { commands: ["true"], commandTimeoutSecs: 60 },
      reviewer: {
        use: "fake-reviewer/agent",
        args: [],
        fixLevel: "major",
        retrySecs: 120,
        maxFileDiffBytes: 200_000,
        maxDiffBytes: 1_000_000,
      },
    }),
  );
  const plan = await addPlan(store, { repository, slug: "plan", title: "Plan", request: "do it" });
  const task = await addTask(store, { plan: plan.id, slug: "task", title: "Task", brief: "Write." });
  const taskId = task.id.slice(task.id.indexOf("/") + 1);
  // Work committed on the task branch by an earlier run.
  if (options.commits > 0) {
    gitOrThrow(remote.repository, ["branch", `work/${taskId}`, "main"]);
    const path = join(root, "pre");
    gitOrThrow(remote.repository, ["worktree", "add", path, `work/${taskId}`]);
    for (let index = 0; index < options.commits; index += 1) {
      await commitIn(path, `f${index}.txt`, "x\n", `earlier work ${index}`);
    }
    gitOrThrow(remote.repository, ["worktree", "remove", "--force", path]);
  }
  const seed = async (runId: string): Promise<void> => {
    if (options.verify === undefined) return;
    const head = gitOrThrow(remote.repository, ["rev-parse", `work/${taskId}`]);
    const stored = await store.get("task", task.id);
    if (stored === undefined) throw new Error("task disappeared");
    const current = taskData(stored.data);
    await store.put(
      "task",
      task.id,
      {
        ...current,
        attempt: {
          ...current.attempt,
          number: 1,
          run: runId,
          verified: head,
          verify: { result: options.verify, run: runId },
        },
      },
      "test:verified",
    );
  };
  if (options.sameRun !== true) await seed("earlier-run");
  const worker = definePlugin({
    name: "fake-harness",
    kind: "harness",
    version: "0.0.0",
    steps: [
      {
        name: "agent",
        results: ["done", "failed", "interrupted"],
        run: async (): Promise<PluginStepResult> => {
          for (let index = 0; index < (options.workerCommits ?? 0); index += 1) {
            const stored = await store.get("task", task.id);
            const path = stored === undefined ? undefined : taskData(stored.data).attempt?.worktree;
            if (typeof path !== "string") throw new Error("the worker has no worktree");
            await commitIn(path, `w${index}.txt`, "y\n", `worker commit ${index}`);
          }
          return { result: "done", data: {} };
        },
      },
    ],
  });
  const reviewed: string[] = [];
  const reviewer = definePlugin({
    name: "fake-reviewer",
    kind: "harness",
    version: "0.0.0",
    steps: [
      {
        name: "agent",
        results: ["done", "failed", "interrupted"],
        run: (_ctx, params): PluginStepResult => {
          const input = params as { readonly cwd: string; readonly resultPath: string };
          const seen = gitOrThrow(input.cwd, ["rev-parse", "HEAD"]);
          reviewed.push(seen);
          writeFileSync(
            input.resultPath,
            JSON.stringify({ findings: [], verified: ["the diff"], sha: seen }),
          );
          return { result: "done", data: {} };
        },
      },
    ],
  });
  const registry = new PluginRegistry(
    [createDevPlugin(), createPoolPlugin(), createShellPlugin(), worker, reviewer] as never,
    { home: root, cwd: remote.repository, store },
  );
  const log = openLog({ backend: "sqlite", path: join(root, "log", "log.sqlite") });
  const found = registry.flow("dev");
  if (found === undefined) throw new Error("the dev flow is missing");
  const { runId } = await log.startRun("dev", `task:${task.id}`);
  if (options.sameRun === true) await seed(runId);
  const events: StepEvent[] = [];
  const object = parseObjectKey(`task:${task.id}`);
  const outcome = await new Runner({
    log,
    flow: found.flow,
    runId,
    registry,
    ...(object === undefined ? {} : { object }),
    emit: async (_plugin, event) => {
      events.push(event);
    },
  }).run();
  const steps: string[] = [];
  const whys: string[] = [];
  const replayed: boolean[] = [];
  for await (const fact of log.read(runId)) {
    const payload = fact.payload as { step?: string; data?: { message?: unknown } };
    if (fact.kind === "step_entered" && typeof payload.step === "string") steps.push(payload.step);
    if (fact.kind === "step_result" && payload.step === "verify") {
      replayed.push((payload.data as { replayed?: unknown } | undefined)?.replayed === true);
    }
    if (fact.kind === "step_result" && payload.step === "work") {
      whys.push(String(payload.data?.message ?? ""));
    }
  }
  const stored = await store.get("task", task.id);
  if (stored === undefined) throw new Error("task disappeared");
  const data = taskData(stored.data);
  const path = data.attempt?.worktree ?? "";
  return {
    outcome,
    reasons: events
      .filter((event) => event.type === "dev.waiting")
      .map((event) => String((event.data as { reason?: unknown } | undefined)?.reason)),
    steps,
    whys,
    replayed,
    reviewed,
    verified: data.attempt?.verified ?? null,
    head: path === "" ? "" : gitOrThrow(path, ["rev-parse", "HEAD"]),
  };
}

describe("work that ends with no new commit", () => {
  test("a branch with unchecked work goes on to verify, and says why", async () => {
    const result = await run({ commits: 1 });
    expect(result.steps).toContain("verify");
    expect(result.whys).toEqual([NOTE]);
    expect(result.reasons).not.toContain("work did nothing");
    expect(result.verified).toBe(result.head);
  });

  test("a branch with nothing beyond main ends nothing and waits", async () => {
    const result = await run({ commits: 0 });
    expect(result.steps).not.toContain("verify");
    expect(result.reasons).toEqual(["work did nothing"]);
  });

  test("a head that already passed verify goes to wait, with no second verify", async () => {
    const result = await run({ commits: 1, verify: "pass" });
    expect(result.steps).toContain("work");
    expect(result.steps).not.toContain("verify");
    expect(result.reasons).toEqual(["work did nothing"]);
  });

  test("a head whose verify failed goes to verify again", async () => {
    const result = await run({ commits: 1, verify: "fail" });
    expect(result.steps.indexOf("verify")).toBeGreaterThan(result.steps.indexOf("work"));
    expect(result.whys).toEqual([NOTE]);
    expect(result.reasons).not.toContain("work did nothing");
  });

  test("a worker that commits twice, the second just before it ends, gets that commit verified and reviewed", async () => {
    const result = await run({ commits: 1, verify: "pass", sameRun: true, workerCommits: 2 });
    expect(result.steps.indexOf("verify")).toBeGreaterThan(result.steps.indexOf("work"));
    expect(result.steps.indexOf("review")).toBeGreaterThan(result.steps.indexOf("verify"));
    expect(result.replayed).toEqual([false]);
    expect(result.verified).toBe(result.head);
    expect(result.reviewed).toEqual([result.head]);
  });
});
