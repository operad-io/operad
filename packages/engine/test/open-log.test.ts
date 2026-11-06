import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { SQLITE_FILE_NAME, openLog } from "../src/index.ts";

const TEST_ROOT = resolve(import.meta.dir, "..", "..", "..", ".radian", "test-tmp");

function tempDirectory(label: string): string {
  mkdirSync(TEST_ROOT, { recursive: true });
  const directory = join(TEST_ROOT, `${label}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

test("openLog opens the jsonl backend on a directory", async () => {
  const directory = tempDirectory("open-log-jsonl");
  const backend = openLog({ backend: "jsonl", path: directory });
  try {
    const run = await backend.startRun("flow", "object");
    expect(run.active).toBe(true);
    expect(existsSync(join(directory, "runs", `${run.runId}.jsonl`))).toBe(true);
  } finally {
    await backend.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("openLog opens the sqlite backend on one file", async () => {
  const directory = tempDirectory("open-log-sqlite");
  const path = join(directory, "store.sqlite");
  const backend = openLog({ backend: "sqlite", path });
  try {
    const run = await backend.startRun("flow", "object");
    await backend.append(run.runId, 0, [{ kind: "one", payload: {}, cause: 1 }]);
    expect(existsSync(path)).toBe(true);
    const facts = [];
    for await (const fact of backend.read(run.runId)) facts.push(fact);
    expect(facts.map((fact) => fact.kind)).toEqual(["one"]);
  } finally {
    await backend.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
