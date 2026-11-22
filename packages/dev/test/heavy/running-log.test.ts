import { createPoolPlugin } from "@operad-io/pool";
import { afterAll, describe, expect, test } from "bun:test";
import { createChatPlugin } from "@operad-io/chat";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin, PluginRegistry, type PluginStepResult } from "@operad-io/engine";
import { addPlan, addRepository, addTask, createDevPlugin, taskData } from "../../src/index.ts";
import { getTask } from "../../src/service.ts";
import { taskViews } from "../../src/views.ts";
import { makeRemote } from "../git-support.ts";
import { cleanupTempRoots, guardLockHandles, storeAt, tempRoot } from "../support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

/** A recorded sample of a codex worker's log: deltas only, then a tool call. */
const CODEX_SAMPLE = [
  { type: "session", sessionId: "s", receivedAt: 1 },
  { type: "text_delta", text: "I will ", receivedAt: 2 },
  { type: "text_delta", text: "edit the file.", receivedAt: 3 },
  { type: "tool_execution_start", toolCallId: "e1", toolName: "edit", at: 4, input: "/w/a.py" },
  { type: "tool_output", toolCallId: "e1", text: "TOOL OUTPUT IS NOT SHOWN", receivedAt: 5 },
  { type: "tool_execution_end", toolCallId: "e1", toolName: "edit", isError: false, durationMs: 41, receivedAt: 6 },
]
  .map((line) => JSON.stringify(line))
  .join("\n");

describe("the log of a running work step whose stage has its own pool", () => {
  test("shows the log of the pool's codex worker while it runs, not the default worker's", async () => {
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
        workers: { radian: { use: "fake-radian/agent" }, codex: { use: "fake-codex/agent" } },
        pools: { default: ["radian"], image: ["codex"] },
        workerBrief: ".operad/worker-brief.md",
      }),
    );
    writeFileSync(join(remote.repository, ".operad", "worker-brief.md"), "Do the work.");
    const plan = await addPlan(store, { repository, slug: "plan", title: "Plan", request: "do the work" });
    const task = await addTask(store, { plan: plan.id, slug: "task", title: "Task", brief: "Write the files." });

    let running: () => void = () => undefined;
    const isRunning = new Promise<void>((resolve) => {
      running = resolve;
    });
    let finish: () => void = () => undefined;
    const mayFinish = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const codex = definePlugin({
      name: "fake-codex",
      kind: "harness",
      version: "0.0.0",
      steps: [
        {
          name: "agent",
          results: ["done", "failed", "interrupted"],
          async run(ctx): Promise<PluginStepResult> {
            // The harness's logger writes under its own name and the run's id.
            const directory = join(store.root, "logs", "fake-codex", "runs", ctx.runId);
            mkdirSync(directory, { recursive: true });
            writeFileSync(join(directory, "agent.log"), `${CODEX_SAMPLE}\n`);
            running();
            await mayFinish;
            return { result: "done", data: {} };
          },
        },
      ],
    });
    const registry = new PluginRegistry(
      [createChatPlugin(), createDevPlugin(), createPoolPlugin(), codex],
      { home: root, cwd: remote.repository, store },
    );
    const object = { type: "task", id: task.id, data: {} };
    const prepared = await registry.runStep("dev/worktree", {}, { runId: "run-1", object });
    expect(prepared.result).toBe("ready");
    const work = registry.runStep("dev/work", { flowPool: "image" }, { runId: "run-1", object, emit: () => undefined });
    await isRunning;
    // The placement is recorded as the harness starts; wait for it.
    let recorded = false;
    for (let turn = 0; turn < 200_000 && !recorded; turn += 1) {
      const stored = await store.get("task", task.id);
      recorded = stored !== undefined && taskData(stored.data).attempt?.workerRunning === "codex";
      if (!recorded) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const mid = await getTask(store, task.id);
    expect(taskData(mid.data).attempt?.workerUse).toBe("fake-codex/agent");
    expect(taskData(mid.data).attempt?.worker ?? null).toBeNull();
    const section = (await taskViews.load({ store } as never, mid, "log", {})) as { markdown: string };
    expect(section.markdown).toContain("**agent:** I will edit the file.");
    expect(section.markdown).toContain("tool edit <1s `/w/a.py`");
    expect(section.markdown).not.toContain("No worker log yet");
    finish();
    await work;
    // After the step the attempt names the worker that ran.
    const after = taskData((await getTask(store, task.id)).data);
    expect(after.attempt?.worker).toBe("codex");
    expect(after.attempt?.workerRunning ?? null).toBeNull();
  });
});
