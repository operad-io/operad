#!/usr/bin/env bun
/**
 * A child process for the sqlite tests. It holds a write transaction on a
 * rollback-mode database until its parent writes a line on stdin, like a slow
 * writer, so a second process opening the same store has to wait for it
 * instead of failing at once. The parent decides when, from an event.
 */
import { Database } from "bun:sqlite";
import { setBusyTimeout } from "../../src/platform/index.ts";

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const path = process.env.OPERAD_DB_PATH;
if (path === undefined || path.length === 0) fail("missing OPERAD_DB_PATH");

const database = new Database(path, { create: true, readwrite: true });
// The same busy timeout as the backend. The opener may hold a shared lock
// while its busy handler waits for the write lock, so COMMIT can see
// SQLITE_BUSY for an instant; without this the holder would exit instead of
// retrying, and the opener would report a missing commit.
setBusyTimeout(database);
database.run("CREATE TABLE IF NOT EXISTS held (x)");
database.run("BEGIN IMMEDIATE");
process.stdout.write(`${JSON.stringify({ locked: true })}\n`);

for await (const _line of console) break;

database.run("COMMIT");
database.close();
process.stdout.write(`${JSON.stringify({ committed: true })}\n`);
