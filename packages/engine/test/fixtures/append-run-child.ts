#!/usr/bin/env bun
/**
 * Appends one fact to a run from another process, so a test can prove a kept
 * run state follows writes made through a second log connection.
 */
import { openLog, type JsonValue } from "../../src/index.ts";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const [path, runId, kind, payloadJson] = process.argv.slice(2);
if (path === undefined || runId === undefined || kind === undefined) {
  fail("usage: append-run-child <log path> <run id> <kind> [payload json]");
}

let payload: unknown = {};
if (payloadJson !== undefined) {
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    fail("the payload is not JSON");
  }
}

const log = openLog({ backend: "sqlite", path });
try {
  const run = await log.run(runId);
  if (run === undefined) fail(`no run ${runId}`);
  const result = await log.append(runId, run.lastSeq, [
    { kind, payload: payload as JsonValue, cause: run.lastSeq },
  ]);
  process.stdout.write(`${JSON.stringify({ lastSeq: result.lastSeq })}\n`);
} finally {
  await log.close();
}
