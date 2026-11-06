/**
 * A fake harness for the end-to-end test. A worker call writes one file and
 * commits it in the worktree it was given. A reviewer call writes a clean
 * report. The first reviewer call of a run waits, so the test can kill the run
 * process while that step is in flight. Test-only: no production path loads it.
 */

import { existsSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  definePlugin,
  type PluginStepResult,
  type StepContext,
} from "@operad-io/engine";

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function done(ctx: StepContext, message: string): PluginStepResult {
  return {
    result: "done",
    data: {
      exitCode: 0,
      signal: null,
      sessionId: "fake-session",
      finalMessage: message,
      usage: {},
      cost: null,
      log: ctx.logger.path,
      durationMs: 1,
      stderr: [],
    },
  };
}

function recordDir(cwd: string): string {
  return process.env.FAKE_HARNESS_DIR ?? cwd;
}

/**
 * Holds the first review open until the test ends it: it resolves when the test
 * writes `review-release`, and the run process is killed before that. No timer
 * decides when the review may finish.
 */
function holdForKill(directory: string): Promise<void> {
  const release = join(directory, "review-release");
  return new Promise((resolve) => {
    const handle = watch(directory, () => {
      if (!existsSync(release)) return;
      handle.close();
      resolve();
    });
    handle.on("error", () => {
      handle.close();
      resolve();
    });
  });
}

export function createFakeHarnessPlugin() {
  return definePlugin({
    name: "harness-fake",
    kind: "harness",
    version: "0.0.0",
    steps: [
      {
        name: "agent",
        results: ["done", "failed", "interrupted"],
        async run(ctx, params) {
          const input =
            typeof params === "object" && params !== null
              ? (params as Record<string, unknown>)
              : {};
          const cwd = typeof input.cwd === "string" ? input.cwd : ctx.cwd;
          const resultPath =
            typeof input.resultPath === "string" ? input.resultPath : undefined;
          const directory = recordDir(cwd);

          if (resultPath !== undefined) {
            const once = join(directory, "review-once");
            if (!existsSync(once)) {
              writeFileSync(once, "started\n");
              // The test kills the run while this review is in flight; a
              // recovered review finds the marker and returns at once.
              await holdForKill(directory);
            }
            writeFileSync(
              resultPath,
              JSON.stringify({ findings: [], verified: [], summary: "clean" }),
            );
            return done(ctx, "reviewed");
          }

          const path = join(
            cwd,
            `work-${process.pid}-${Date.now()}.txt`,
          );
          writeFileSync(path, "the fake worker changed this\n");
          git(cwd, ["add", "-A"]);
          git(cwd, [
            "-c",
            "user.name=fake",
            "-c",
            "user.email=fake@example.com",
            "commit",
            "-qm",
            "fake work",
          ]);
          return done(ctx, "worked");
        },
      },
    ],
  });
}

export default createFakeHarnessPlugin();
