import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUSY_TIMEOUT_MS,
  enableWal,
  isBusy,
  setBusyTimeout,
} from "../../src/platform/index.ts";

const HOLD_CHILD = join(import.meta.dir, "..", "fixtures", "sqlite-hold.ts");
const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "operad-sqlite-open-"));
  directories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function journalMode(database: Database): string | undefined {
  return database
    .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
    .get()?.journal_mode;
}

/** Reads one line from the child's stdout. */
async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value !== undefined) text += decoder.decode(value, { stream: true });
    const newline = text.indexOf("\n");
    if (newline >= 0) {
      reader.releaseLock();
      return text.slice(0, newline);
    }
    if (done) {
      reader.releaseLock();
      return text;
    }
  }
}

test("the busy timeout is installed on the connection", () => {
  const database = new Database(join(tempDirectory(), "a.sqlite"));
  setBusyTimeout(database);
  const row = database
    .query<{ timeout: number }, []>("PRAGMA busy_timeout")
    .get();
  expect(row?.timeout).toBe(BUSY_TIMEOUT_MS);
  database.close();
});

test("isBusy recognises only a SQLITE_BUSY error", () => {
  expect(isBusy(Object.assign(new Error("busy"), { code: "SQLITE_BUSY" }))).toBe(true);
  expect(isBusy(Object.assign(new Error("other"), { code: "SQLITE_ERROR" }))).toBe(false);
  expect(isBusy(Object.assign(new Error("busy"), { code: "SQLITE_BUSY_SNAPSHOT" }))).toBe(true);
  expect(isBusy(Object.assign(new Error("busy"), { code: "SQLITE_BUSY_RECOVERY" }))).toBe(true);
  expect(isBusy(Object.assign(new Error("other"), { code: "SQLITE_BUSYX" }))).toBe(false);
  expect(isBusy("SQLITE_BUSY")).toBe(false);
  expect(isBusy(null)).toBe(false);
});

test("WAL is switched on once and left on", () => {
  const database = new Database(join(tempDirectory(), "b.sqlite"));
  setBusyTimeout(database);
  enableWal(database);
  expect(journalMode(database)).toBe("wal");
  enableWal(database);
  expect(journalMode(database)).toBe("wal");
  database.close();
});

const OPEN_CHILD = join(import.meta.dir, "..", "fixtures", "sqlite-open-child.ts");

test("a database that cannot be WAL is an error, not a loop", () => {
  const database = new Database(":memory:");
  setBusyTimeout(database);
  expect(() => enableWal(database)).toThrow(/could not switch to WAL/);
  database.close();
});

test("switching to WAL waits while another process holds the database", async () => {
  const path = join(tempDirectory(), "c.sqlite");
  const holder = Bun.spawn([process.execPath, HOLD_CHILD], {
    env: { ...process.env, OPERAD_DB_PATH: path },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    // Spawn the opener only after the holder reports its write lock: spawning
    // both at once lets the opener create and switch a fresh database before
    // the holder starts its transaction, and then no SQLITE_BUSY is expected.
    expect(JSON.parse(await firstLine(holder.stdout))).toEqual({ locked: true });
    const opener = Bun.spawn([process.execPath, OPEN_CHILD], {
      env: { ...process.env, OPERAD_DB_PATH: path },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      // The holder keeps its write lock until it is told otherwise, so the
      // opener must meet SQLITE_BUSY; only then does the test let the holder go.
      // A switch that gave up on SQLITE_BUSY exits without ever reporting it.
      const openerLines = opener.stdout.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const next = async (): Promise<unknown> => {
        for (;;) {
          const newline = text.indexOf("\n");
          if (newline >= 0) {
            const line = text.slice(0, newline);
            text = text.slice(newline + 1);
            return JSON.parse(line);
          }
          const { value, done } = await openerLines.read();
          if (value !== undefined) text += decoder.decode(value, { stream: true });
          if (done && text.indexOf("\n") < 0) {
            throw new Error(`the opener ended early: ${await new Response(opener.stderr).text()}`);
          }
        }
      };
      expect(await next()).toEqual({ busy: true });
      holder.stdin.write("release\n");
      await holder.stdin.end();
      expect(await next()).toEqual({ journalMode: "wal" });
      expect(await opener.exited).toBe(0);
    } finally {
      if (opener.exitCode === null) opener.kill();
      await opener.exited;
    }
  } finally {
    if (holder.exitCode === null) holder.kill();
    await holder.exited;
  }
});
