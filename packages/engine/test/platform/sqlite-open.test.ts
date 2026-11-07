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

test("switching to WAL waits while another process holds the database", async () => {
  const path = join(tempDirectory(), "c.sqlite");
  const holder = Bun.spawn([process.execPath, HOLD_CHILD], {
    env: { ...process.env, OPERAD_DB_PATH: path, OPERAD_HOLD_MS: "100" },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    expect(JSON.parse(await firstLine(holder.stdout))).toEqual({ locked: true });
    const database = new Database(path);
    setBusyTimeout(database);
    // The holder keeps its write lock for a moment; a switch that gave up on
    // SQLITE_BUSY would throw here.
    enableWal(database);
    expect(journalMode(database)).toBe("wal");
    database.close();
  } finally {
    if (holder.exitCode === null) holder.kill();
    await holder.exited;
  }
});
