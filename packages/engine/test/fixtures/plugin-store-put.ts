#!/usr/bin/env bun
/**
 * A child process for the plugin store tests. It opens the sqlite plugin store
 * at OPERAD_DB_PATH and writes one object, reporting a line as the write begins and
 * after it so the parent can act on the events.
 */
import { writeSync } from "node:fs";
import { SqlitePluginStore } from "../../src/plugin/sqlite-store.ts";

const path = process.env.OPERAD_DB_PATH;
if (path === undefined || path.length === 0) {
  process.stderr.write("missing OPERAD_DB_PATH\n");
  process.exit(2);
}

// `put` reads the clock just before it opens its write transaction, so the
// report comes from that point, not from before the store was opened.
let reported = false;
const store = new SqlitePluginStore({
  root: ".",
  file: path,
  clock: () => {
    if (!reported) writeSync(1, `${JSON.stringify({ writing: true })}\n`);
    reported = true;
    return Date.now();
  },
});
store.put("note", "one", { text: "hello" }, "test");
process.stdout.write(`${JSON.stringify({ written: true })}\n`);
store.close();
