import { afterAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSqliteLogBackend } from "../../src/log/sqlite.ts";
import { BUSY_TIMEOUT_MS } from "../../src/platform/index.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";
import { waitForFile } from "../../src/testing/index.ts";

afterAll(cleanupTempRoots);

const HOLDER = join(import.meta.dir, "..", "fixtures", "log-commit-holder.ts");

/** Waits inside the synchronous write, after the holder has taken the lock again. */
function waitForFileSync(path: string, deadline: number): void {
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

test("a log write waits past the busy timeout while another process commits", async () => {
  const root = await tempRoot();
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  const path = join(root, "log.sqlite");
  await (await openSqliteLogBackend(path)).close();

  const holder = Bun.spawn([process.execPath, HOLDER], {
    env: { ...process.env, OPERAD_LOG_STORE: path, OPERAD_LOG_WORK: work },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const deadline = Date.now() + 45_000;
  try {
    await waitForFile(join(work, "locked"), deadline);

    let wraps = 0;
    const log = openSqliteLogBackend(path, {
      immediateWriter: (database: Database) => ({
        query: (sql: string) => ({
          get: () => database.query(sql).get(),
        }),
        transaction<T>(run: () => T) {
          return {
            immediate: (): T => {
              wraps += 1;
              // This runs after writeImmediate read data_version and before it
              // takes the write lock. The holder commits short transactions and
              // takes the lock again while the write waits.
              writeFileSync(join(work, "cycle"), "");
              waitForFileSync(join(work, "cycled"), deadline);
              return database.transaction(run).immediate();
            },
          };
        },
      }),
    });
    try {
      const startedAt = Date.now();
      const run = await log.startRun("busy", "job:1");
      expect(Date.now() - startedAt).toBeGreaterThan(BUSY_TIMEOUT_MS);
      expect((await log.runs()).map((info) => info.runId)).toContain(run.runId);
      expect(wraps).toBeGreaterThan(0);
    } finally {
      await log.close();
    }

    await waitForFile(join(work, "released"), deadline);
    expect(await holder.exited).toBe(0);
  } finally {
    if (holder.exitCode === null) holder.kill("SIGKILL");
    await holder.exited;
  }
}, 60_000);

test("a write on a log succeeds while a read of the same log is still open", async () => {
  const root = await tempRoot();
  const path = join(root, "log.sqlite");
  const log = await openSqliteLogBackend(path);
  const other = await openSqliteLogBackend(path);
  try {
    const run = await log.startRun("flow", "object");
    await log.append(run.runId, 0, [
      { kind: "a", payload: {}, cause: "test" },
    ]);

    // An async generator is suspended between two facts. The read must take
    // its whole snapshot before the first yield, not hold a transaction on the
    // connection a write then needs.
    const facts = log.read(run.runId)[Symbol.asyncIterator]();
    const first = await facts.next();
    expect(first.done).toBe(false);

    // Another connection commits after the read's snapshot.
    await other.append(run.runId, 1, [
      { kind: "b", payload: {}, cause: "test" },
    ]);

    // The open read must not make this write fail at once: after another
    // connection commits that is SQLITE_BUSY_SNAPSHOT, and while it holds the
    // write lock it is plain SQLITE_BUSY (the endRun failure in T-0627).
    await log.append(run.runId, 2, [
      { kind: "c", payload: {}, cause: "test" },
    ]);

    // The read keeps its own snapshot, then ends.
    const kinds: string[] = [];
    for (;;) {
      const next = await facts.next();
      if (next.done) break;
      kinds.push(next.value.kind);
    }
    expect(kinds).toEqual([]);

    const fresh: string[] = [];
    for await (const fact of log.read(run.runId)) fresh.push(fact.kind);
    expect(fresh).toEqual(["a", "b", "c"]);
  } finally {
    await log.close();
    await other.close();
  }
});

