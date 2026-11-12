/**
 * The dev flow with `worker.use: "pi/agent"`: a fake pi worker (a script
 * that commits a file and prints a Result line) takes a task through the
 * worktree and the work to the gate, which leaves the task in `review`. No
 * model is called; the pi plugin is imported by path so dev has no dependency
 * on it.
 */

import { createPoolPlugin } from "@operad-io/pool";
import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginRegistry } from "@operad-io/engine";
import { createShellPlugin } from "@operad-io/shell";
import { addPlan, addRepository, addTask, createDevPlugin, taskData } from "../src/index.ts";
import { git, makeRemote } from "./git-support.ts";
import { cleanupTempRoots, guardLockHandles, storeAt, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const FAKE = fileURLToPath(new URL("../../harness/pi/test/fake-lines-worker.ts", import.meta.url));

async function piPlugin(): Promise<unknown> {
  const module = (await import(
    new URL("../../harness/pi/src/index.ts", import.meta.url).href
  )) as {
    readonly createPiHarnessPlugin: (options: {
      readonly command: string;
      readonly args: readonly string[];
    }) => unknown;
  };
  return module.createPiHarnessPlugin({ command: process.execPath, args: [FAKE] });
}

describe("dev with the pi harness", () => {
  test("a fake task runs through the worktree and the work to review", async () => {
    const root = await tempRoot();
    process.env["FAKE_PI_MODE"] = "commit";
    try {
      const remote = await makeRemote(root);
      const store = storeAt(root);
      const repository = await addRepository(store, {
        path: remote.repository,
        name: "repository",
      });
      writeFileSync(
        join(remote.repository, ".operad", "dev.json"),
        JSON.stringify({
          name: "repository",
          remote: "origin",
          mainBranch: "main",
          worktreeRoot: ".operad-worktrees",
          worker: { use: "pi/agent", args: [] },
          gate: { commands: ["test -f worker.txt"] },
        }),
      );
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
        brief: "Write the worker file.",
      });
      const registry = new PluginRegistry([createDevPlugin(), createPoolPlugin(), createShellPlugin(), await piPlugin()], {
        home: root,
        cwd: remote.repository,
        store,
      });
      const object = { type: "task", id: task.id, data: {} };

      const worktree = await registry.runStep("dev/worktree", {}, { runId: "run-1", object });
      expect(worktree.result).toBe("ready");

      const work = await registry.runStep("dev/work", {}, { runId: "run-1", object });
      expect(work.result).toBe("done");

      const afterWork = await store.get("task", task.id);
      const attempt = taskData(afterWork?.data ?? {}).attempt;
      expect(attempt?.sessionId).toBe("fake-session");
      expect(attempt?.costMicros).toBe(1234);
      const taskId = task.id.slice(task.id.indexOf("/") + 1);
      expect(
        git(remote.origin, ["show", `work/${taskId}:worker.txt`]).out,
      ).toBe("done");

      const verify = await registry.runStep("dev/verify", {}, { runId: "run-1", object });
      expect(verify.result).toBe("pass");
      const reviewed = await store.get("task", task.id);
      expect(taskData(reviewed?.data ?? {}).phase).toBe("review");
    } finally {
      delete process.env["FAKE_PI_MODE"];
    }
  });
});
