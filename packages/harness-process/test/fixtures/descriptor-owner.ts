/**
 * Runs the harness process path many times while SQLite databases are open,
 * then collects garbage. A descriptor that Bun closes a second time lands on a
 * SQLite descriptor, and macOS kills this process with EXC_GUARD (exit 137).
 */

import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../../src/process.ts";

const directory = mkdtempSync(join(tmpdir(), "operad-descriptor-owner-"));
const rounds = Number(process.argv[2] ?? "100");
const databases: Database[] = [];
const tails: string[] = [];

for (let round = 0; round < rounds; round += 1) {
  const outcome = await runAgent({
    command: "/bin/sh",
    args: ["-c", "echo '{}'; echo oops >&2"],
    cwd: directory,
    wallMs: 30_000,
    stallMs: 30_000,
    signal: new AbortController().signal,
    onLine: () => undefined,
  });
  tails.push(outcome.stderrTail.join("|"));
  const database = new Database(join(directory, `d${round}.sqlite`));
  database.exec("pragma journal_mode=wal; create table t(x)");
  databases.push(database);
  if (round % 10 === 0) {
    Bun.gc(true);
    await Bun.sleep(5);
  }
}
Bun.gc(true);
await Bun.sleep(50);
Bun.gc(true);

for (const database of databases) database.exec("insert into t values (1)");
console.log(JSON.stringify({ rounds, tails: [...new Set(tails)] }));
