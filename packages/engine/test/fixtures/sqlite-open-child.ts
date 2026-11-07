#!/usr/bin/env bun
/**
 * A child process for the sqlite tests. It opens a database the way the
 * backend does and tells its parent (synchronously, because the open blocks)
 * each time the switch to WAL met SQLITE_BUSY, then what the journal mode is.
 */
import { Database } from "bun:sqlite";
import { writeSync } from "node:fs";
import { enableWal, setBusyTimeout } from "../../src/platform/index.ts";

const path = process.env.OPERAD_DB_PATH;
if (path === undefined || path.length === 0) {
  process.stderr.write("missing OPERAD_DB_PATH\n");
  process.exit(2);
}

const database = new Database(path);
setBusyTimeout(database);
enableWal(database, () => writeSync(1, `${JSON.stringify({ busy: true })}\n`));
const mode = database.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
writeSync(1, `${JSON.stringify({ journalMode: mode?.journal_mode })}\n`);
database.close();
