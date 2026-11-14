#!/usr/bin/env bun
/**
 * A child process for the log's busy-write test. It takes the log's write lock,
 * then waits for a file. On request it commits three short write transactions,
 * takes the lock again, and holds it past the busy timeout. The test acts on
 * the files it leaves, not on durations.
 */
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setBusyTimeout } from "../../src/platform/index.ts";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    process.stderr.write(`missing ${name}\n`);
    process.exit(2);
  }
  return value;
}

const path = required("OPERAD_LOG_STORE");
const work = required("OPERAD_LOG_WORK");

function mark(name: string): void {
  writeFileSync(join(work, name), "");
}

const database = new Database(path, { create: true, readwrite: true });
setBusyTimeout(database);
database.run("CREATE TABLE IF NOT EXISTS held (x INTEGER)");
database.run("BEGIN IMMEDIATE");
database.run("INSERT INTO held (x) VALUES (0)");
mark("locked");

while (!existsSync(join(work, "cycle"))) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}

// Three short commits, then the lock is taken again and held past the busy
// timeout. The writer must follow data_version to write after these commits.
database.run("COMMIT");
for (let count = 1; count <= 3; count += 1) {
  database.run("BEGIN IMMEDIATE");
  database.run("INSERT INTO held (x) VALUES (?)", [count]);
  database.run("COMMIT");
}
database.run("BEGIN IMMEDIATE");
database.run("INSERT INTO held (x) VALUES (4)");
mark("cycled");

await new Promise<void>((resolve) => setTimeout(resolve, 6_500));
database.run("COMMIT");
database.close();
mark("released");
