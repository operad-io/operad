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
import { addPlan, addRepository, addTask, createDevPlugin, taskData } from "../src/index.ts";
import { commitIn, gitOrThrow, makeRemote } from "./git-support.ts";
import { cleanupTempRoots, guardLockHandles, storeAt, tempRoot } from "./support.ts";

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
}

/** Runs the dev flow once; the branch has `commits` made before the run and the worker commits nothing. */
async function run(options: { readonly commits: number; readonly verifyBefore?: boolean }): Promise<Run> {
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
  const worker = definePlugin({
    name: "fake-harness",
    kind: "harness",
    version: "0.0.0",
    steps: [
      {
        name: "agent",
        results: ["done", "failed", "interrupted"],
        run: (): PluginStepResult => ({ result: "done", data: {} }),
      },
    ],
  });
  const registry = new PluginRegistry(
    [createDevPlugin(), createPoolPlugin(), createShellPlugin(), worker] as never,
    { home: root, cwd: remote.repository, store },
  );
  const log = openLog({ backend: "jsonl", path: join(root, "log") });
  const found = registry.flow("dev");
  if (found === undefined) throw new Error("the dev flow is missing");
  const { runId } = await log.startRun("dev", `task:${task.id}`);
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
  for await (const fact of log.read(runId)) {
    const payload = fact.payload as { step?: string; data?: { message?: unknown } };
    if (fact.kind === "step_entered" && typeof payload.step === "string") steps.push(payload.step);
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
});
