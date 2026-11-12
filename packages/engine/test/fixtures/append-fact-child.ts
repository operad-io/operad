#!/usr/bin/env bun
/**
 * A child process for the presentation tests. It opens a log in the given store
 * directory, starts one run and appends one fact, then exits. The test keeps
 * its own reader open, so the event it observes comes from another process.
 */
import { join } from "node:path";
import { openLog } from "../../src/index.ts";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const directory = process.argv[2];
if (directory === undefined || directory.length === 0) {
  fail("missing store directory");
}

const log = openLog({ backend: "sqlite", path: join(directory, "log.sqlite") });
try {
  const info = await log.startRun("demo-flow", "item:one");
  await log.append(info.runId, 0, [
    { kind: "run_started", payload: { flow: "demo-flow" }, cause: "test" },
  ]);
  process.stdout.write(`${JSON.stringify({ runId: info.runId })}\n`);
} finally {
  await log.close();
}
