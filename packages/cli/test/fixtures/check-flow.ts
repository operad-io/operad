import { appendFileSync } from "node:fs";
import { defineFlow, definePlugin } from "../../../engine/src/index.ts";

/**
 * A flow whose one step runs a `shell/check` line from the `CHECK_LINE`
 * environment variable, so a test can choose a command that waits for a file.
 */
const line = process.env.CHECK_LINE ?? "true";

/** A test can see the flag in the process that loads this plugin (serve or run). */
const runEnv = process.env.CHECK_RUN_ENV;
if (runEnv !== undefined) {
  appendFileSync(
    runEnv,
    `${process.pid}:${process.env.OPERAD_SERVE_SUPERVISED ?? "unset"}\n`,
  );
}

const check = defineFlow({
  name: "check",
  entry: "check",
  steps: [
    {
      id: "check",
      kind: "plugin",
      params: { use: "shell/check", params: { lines: [line] } },
      replay: "safe",
      next: { pass: "done", fail: "failed", interrupted: "failed" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
    { id: "failed", kind: "end", params: { status: "failed" }, replay: "safe" },
  ],
});

export default definePlugin({
  name: "checkflow",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "job" }],
  flows: [check],
  /** One line per turn with the serve's pid: a test waits for several new turns. */
  onTick() {
    const ticks = process.env.CHECK_TICKS;
    if (ticks !== undefined) appendFileSync(ticks, `${process.pid}\n`);
  },
});
