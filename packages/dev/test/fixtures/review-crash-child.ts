/**
 * Runs `dev/review` in a real child process and kills it at one point of a
 * review round, so the parent can prove the same round resumes without asking
 * the first model again.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import {
  definePlugin,
  FilePluginStore,
  PluginRegistry,
  type PluginStepResult,
} from "@operad-io/engine";
import { createDevPlugin, reviewTestHooks } from "../../src/index.ts";

const [storeRoot, repository, taskKey, runId, crash, callLog] =
  process.argv.slice(2);
if (
  storeRoot === undefined ||
  repository === undefined ||
  taskKey === undefined ||
  runId === undefined ||
  crash === undefined ||
  callLog === undefined
) {
  throw new Error(
    "usage: review-crash-child <store> <repository> <task> <run> <crash> <call log>",
  );
}

const reviewer = definePlugin({
  name: "fake-reviewer",
  kind: "harness",
  version: "0.0.0",
  steps: [
    {
      name: "agent",
      results: ["done", "failed", "interrupted"],
      async run(_ctx, params): Promise<PluginStepResult> {
        const input = params as {
          readonly args?: readonly string[];
          readonly resultPath: string;
        };
        appendFileSync(callLog, "call\n");
        const mode = input.args?.[0] ?? "none";
        if (mode === "unavailable") {
          return {
            result: "failed",
            data: {
              reason: "exit",
              kind: "unavailable",
              message: "the model is unavailable",
            },
          };
        }
        writeFileSync(
          input.resultPath,
          JSON.stringify({ findings: [], verified: ["the diff"] }),
        );
        return { result: "done", data: {} };
      },
    },
  ],
});

reviewTestHooks.beforeRun = (run) => {
  if (crash === "during-fallback" && run.role === "fallback") {
    process.kill(process.pid, "SIGKILL");
  }
};
reviewTestHooks.afterRunSaved = (run) => {
  if (crash === "after-first" && run.role === "primary") {
    process.kill(process.pid, "SIGKILL");
  }
};

const store = new FilePluginStore({ root: storeRoot });
const registry = new PluginRegistry([createDevPlugin(), reviewer], {
  home: storeRoot,
  cwd: repository,
  store,
});

await registry.runStep("dev/review", {}, {
  runId,
  object: { type: "task", id: taskKey, data: {} },
});
