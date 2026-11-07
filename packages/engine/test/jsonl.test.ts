import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { openJsonlLogBackend, SCHEMA_VERSION, type LogChange } from "../src/index.ts";
import { runLogConformance, type LogConformanceFactory } from "./log-conformance.ts";

const schemaPath = (directory: string): string => join(directory, "schema.json");
const inputsPath = (directory: string): string => join(directory, "inputs.jsonl");
const runPath = (directory: string, runId: string): string =>
  join(directory, "runs", `${runId}.jsonl`);

const factory: LogConformanceFactory = {
  name: "jsonl",
  modulePath: new URL("../src/log/jsonl.ts", import.meta.url).href,
  open: (directory, options) => openJsonlLogBackend(directory, options),
  readSchemaVersion(directory) {
    const path = schemaPath(directory);
    if (!existsSync(path)) return undefined;
    const value = JSON.parse(readFileSync(path, "utf8")) as { schema_version?: unknown };
    return typeof value.schema_version === "number" ? value.schema_version : undefined;
  },
  writeSchemaVersion(directory, version) {
    writeFileSync(schemaPath(directory), `${JSON.stringify({ schema_version: version })}\n`);
  },
  removeRun(directory, runId) {
    rmSync(runPath(directory, runId), { force: true });
  },
  countInputRecords(directory) {
    const path = inputsPath(directory);
    if (!existsSync(path)) return 0;
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.length > 0).length;
  },
  storedText(directory, runId) {
    return readFileSync(runPath(directory, runId), "utf8");
  },
  rawRun: {
    size: (directory, runId) => statSync(runPath(directory, runId)).size,
    append(directory, runId, text) {
      appendFileSync(runPath(directory, runId), text);
    },
  },
};

runLogConformance(factory);

const TEST_ROOT = resolve(import.meta.dir, "..", "..", "..", ".radian", "test-tmp");

test("opens a schema_version 1 store and upgrades the marker", async () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const directory = join(TEST_ROOT, `jsonl-migrate-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(schemaPath(directory), `${JSON.stringify({ schema_version: 1 })}\n`);
  const backend = openJsonlLogBackend(directory);
  try {
    const run = await backend.startRun("flow", "object");
    expect((await backend.runs()).map((item) => item.runId)).toEqual([run.runId]);
    expect(factory.readSchemaVersion(directory)).toBe(SCHEMA_VERSION);
  } finally {
    await backend.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a subscription learns of a write when the watch never fires", async () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const directory = join(TEST_ROOT, `jsonl-poll-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  let tick: (() => void) | undefined;
  const reader = openJsonlLogBackend(directory, {
    clock: () => 1_000,
    watch: () => () => undefined,
    repeat: (ms, callback) => {
      expect(ms).toBe(500);
      tick = callback;
      return () => undefined;
    },
  });
  const writer = openJsonlLogBackend(directory);
  try {
    const changes: LogChange[] = [];
    const subscribe = reader.subscribe;
    if (subscribe === undefined) throw new Error("the jsonl log does not subscribe");
    const unsubscribe = subscribe.call(reader, (change) => changes.push(change));

    const run = await writer.startRun("flow", "object");
    await writer.append(run.runId, 0, [
      { kind: "run_started", payload: { flow: "flow" }, cause: "test" },
    ]);
    // The stubbed watch never fires, so nothing has been reported yet.
    expect(changes).toEqual([]);

    if (tick === undefined) throw new Error("the poll did not start");
    tick();
    expect(changes).toEqual([{ runId: run.runId, object: "object" }]);

    unsubscribe();
  } finally {
    await reader.close();
    await writer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a fact line without a payload is a corrupt log, not a fact with no payload", async () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const directory = join(TEST_ROOT, `jsonl-nopayload-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const backend = openJsonlLogBackend(directory);
  try {
    const run = await backend.startRun("flow", "object");
    appendFileSync(
      runPath(directory, run.runId),
      `${JSON.stringify({ type: "batch", facts: [{ runId: run.runId, seq: 1, kind: "k", cause: 1, time: 1 }] })}\n`,
    );
    const read = async (): Promise<void> => {
      for await (const _fact of backend.read(run.runId)) void _fact;
    };
    await expect(read()).rejects.toThrow(/payload/);
  } finally {
    await backend.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
