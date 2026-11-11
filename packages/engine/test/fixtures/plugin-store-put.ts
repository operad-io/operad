#!/usr/bin/env bun
/**
 * A child process for the plugin store tests. It opens the sqlite plugin store
 * at OPERAD_DB_PATH and writes one object, reporting a line before and after
 * the write so the parent can act on the events.
 */
import { SqlitePluginStore } from "../../src/plugin/sqlite-store.ts";

const path = process.env.OPERAD_DB_PATH;
if (path === undefined || path.length === 0) {
  process.stderr.write("missing OPERAD_DB_PATH\n");
  process.exit(2);
}

const store = new SqlitePluginStore({ root: ".", file: path });
process.stdout.write(`${JSON.stringify({ writing: true })}\n`);
store.put("note", "one", { text: "hello" }, "test");
process.stdout.write(`${JSON.stringify({ written: true })}\n`);
store.close();
