/**
 * The settings every SQLite database in the repository opens with.
 *
 * Two processes open the same file: a long-running runner and a command that
 * reads or writes next to it. They have to wait for each other instead of
 * failing at once, and switching to WAL (which lets a reader keep a snapshot
 * while another process appends) is the one step the busy handler does not
 * cover. The rules for both live here so a new store does not rediscover them.
 */

import type { Database } from "bun:sqlite";

/** How long a writer waits for another writer before SQLITE_BUSY. */
export const BUSY_TIMEOUT_MS = 5_000;

/** Install the busy handler, so ordinary lock acquisition waits. */
export function setBusyTimeout(database: Database): void {
  database.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
}

/**
 * True for a busy store: SQLITE_BUSY or any extended code of it
 * (SQLITE_BUSY_SNAPSHOT, SQLITE_BUSY_RECOVERY, SQLITE_BUSY_TIMEOUT), whether the
 * error is the one SQLite raised or the `cause` of an error that wrapped it.
 */
export function isBusy(error: unknown): boolean {
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof error !== "object" || error === null) return false;
    const { code, errno, cause } = error as {
      code?: unknown;
      errno?: unknown;
      cause?: unknown;
    };
    if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) return true;
    // The primary result code is the low byte of an extended one; 5 is BUSY.
    if (typeof errno === "number" && typeof code === "string" && code.startsWith("SQLITE") && (errno & 0xff) === 5) {
      return true;
    }
    error = cause;
  }
  return false;
}

/**
 * Wait until another connection releases the database. SQLite's busy handler,
 * which `busy_timeout` installs, covers ordinary lock acquisition but not a
 * journal mode switch; an immediate transaction goes through it and blocks
 * until the other writer commits, so nothing has to sleep and poll.
 */
function waitForWriter(database: Database): void {
  database.transaction(() => undefined).immediate();
}

/**
 * Switch the store to WAL. Two processes opening a fresh store race for the
 * exclusive lock the switch takes: the loser sees SQLITE_BUSY at once, waits
 * for the winner through the busy handler, then sees the mode is already WAL.
 * `onBusy` is told each time the switch met SQLITE_BUSY, so a test can act on
 * that event instead of guessing a duration.
 *
 * A database that cannot be WAL (an in-memory one stays in MEMORY mode and
 * raises nothing) is an error, not something to retry.
 */
export function enableWal(database: Database, onBusy?: () => void): void {
  if (currentJournalMode(database) === "wal") return;
  for (;;) {
    try {
      const mode = database
        .query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL")
        .get()?.journal_mode;
      if (mode === "wal") return;
      throw new Error(`the database could not switch to WAL (journal mode stays ${mode ?? "unknown"})`);
    } catch (error) {
      if (!isBusy(error)) throw error;
    }
    onBusy?.();
    waitForWriter(database);
    if (currentJournalMode(database) === "wal") return;
  }
}

function currentJournalMode(database: Database): string | undefined {
  return database
    .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
    .get()?.journal_mode;
}

/** The two calls `writeImmediate` makes; a `Database` has both. */
export interface ImmediateWriter {
  transaction<T>(work: () => T): { immediate(): T };
  query(sql: string): { get(): unknown };
}

function dataVersion(database: ImmediateWriter): number | undefined {
  const row = database.query("PRAGMA data_version").get();
  if (typeof row !== "object" || row === null) return undefined;
  const version = (row as { data_version?: unknown }).data_version;
  return typeof version === "number" ? version : undefined;
}

/**
 * Run `work` in an immediate transaction, waiting for other writers for as long
 * as they make progress. The busy handler gives up after BUSY_TIMEOUT_MS, but a
 * writer that commits again the moment it releases the lock can keep another
 * connection waiting longer than that on a slow disk, with nothing stuck. So
 * SQLITE_BUSY is final only when no other connection committed while this one
 * waited: a holder that never commits is stuck, and the error says so.
 */
export function writeImmediate<T>(database: ImmediateWriter, work: () => T): T {
  for (;;) {
    const before = dataVersion(database);
    try {
      return database.transaction(work).immediate();
    } catch (error) {
      if (!isBusy(error) || dataVersion(database) === before) throw error;
    }
  }
}
