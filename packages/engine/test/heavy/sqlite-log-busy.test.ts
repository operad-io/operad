import { afterAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { openSqliteLogBackend } from "../../src/log/sqlite.ts";
import { BUSY_TIMEOUT_MS, waitForChange } from "../../src/platform/index.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const HOLDER = join(import.meta.dir, "..", "fixtures", "log-commit-holder.ts");

/** Resolves once the file exists. */
async function waitForFile(path: string, deadline: number): Promise<void> {
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await waitForChange(dirname(path), basename(path), 50);
  }
}

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
