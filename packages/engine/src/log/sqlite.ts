/**
 * The sqlite log backend: one SQLite file holding runs, facts and inputs.
 *
 * Every append and every startRun is one `BEGIN IMMEDIATE` transaction, so a
 * process killed mid-write leaves either the whole batch or none of it. WAL
 * lets a reader keep a consistent snapshot of a run while another process
 * appends to it.
 */

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ActiveRunError,
  CorruptLogError,
  InvalidPayloadError,
  LogBackendError,
  RunEndedError,
  RunNotFoundError,
  SchemaVersionError,
  SeqConflictError,
  StoreClosedError,
} from "./errors.ts";
import {
  assertExpectedSeq,
  assertName,
  assertRunId,
  inputIdFor,
  validateNewFact,
} from "./facts.ts";
import { assertJsonValue } from "./json-value.ts";
import { SCHEMA_VERSION } from "./schema.ts";
import { watchDirectory } from "../watch.ts";
import type {
  AppendResult,
  Fact,
  FactCause,
  JsonValue,
  LogBackend,
  LogBackendFactory,
  LogBackendOptions,
  LogChange,
  NewFact,
  RecordInputResult,
  RunInfo,
  RunsOptions,
} from "./types.ts";

/** The file the sqlite factory creates inside the store directory. */
export const SQLITE_FILE_NAME = "log.sqlite";

/** How long a writer waits for another writer before SQLITE_BUSY. */
const BUSY_TIMEOUT_MS = 5_000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_version (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runs (
    run_id     TEXT PRIMARY KEY,
    flow       TEXT NOT NULL,
    object     TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active
    ON runs (flow, object) WHERE ended_at IS NULL;
  CREATE TABLE IF NOT EXISTS facts (
    run_id  TEXT NOT NULL REFERENCES runs (run_id),
    seq     INTEGER NOT NULL,
    kind    TEXT NOT NULL,
    payload TEXT NOT NULL,
    cause   TEXT NOT NULL,
    time    INTEGER NOT NULL,
    PRIMARY KEY (run_id, seq)
  );
  CREATE TABLE IF NOT EXISTS inputs (
    input_id   TEXT PRIMARY KEY,
    run_id     TEXT NOT NULL REFERENCES runs (run_id),
    source     TEXT NOT NULL,
    source_key TEXT NOT NULL,
    payload    TEXT NOT NULL,
    time       INTEGER NOT NULL,
    UNIQUE (source, source_key)
  );
`;

interface RunRow {
  readonly run_id: string;
  readonly flow: string;
  readonly object: string;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly last_seq: number;
}

interface FactRow {
  readonly seq: number;
  readonly kind: string;
  readonly payload: string;
  readonly cause: string;
  readonly time: number;
}

/** One run as a watcher last saw it, to tell a real change from a read. */
interface RunSnapshot {
  readonly object: string;
  readonly lastSeq: number;
  readonly ended: boolean;
}

interface VersionRow {
  readonly version: number;
}

function openFailure(path: string, error: unknown): LogBackendError {
  const detail = error instanceof Error ? error.message : String(error);
  return new LogBackendError(`cannot open the sqlite log at ${path}: ${detail}`);
}

function isBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "SQLITE_BUSY"
  );
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
 */
function setWalMode(database: Database): void {
  if (currentJournalMode(database) === "wal") return;
  for (;;) {
    try {
      database.run("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if (!isBusy(error)) throw error;
    }
    waitForWriter(database);
    if (currentJournalMode(database) === "wal") return;
  }
}

function currentJournalMode(database: Database): string | undefined {
  return database
    .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
    .get()?.journal_mode;
}

function ensureDirectory(path: string): void {
  const directory = dirname(path);
  try {
    mkdirSync(directory, { recursive: true });
    accessSync(directory, constants.W_OK);
    if (existsSync(path)) accessSync(path, constants.W_OK);
  } catch (error) {
    throw openFailure(path, error);
  }
}

function configure(database: Database): void {
  database.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  database.run("PRAGMA synchronous = FULL");
  database.run("PRAGMA foreign_keys = ON");
  setWalMode(database);
}

/** The recorded version, or undefined when the schema has not been created yet. */
function readSchemaVersion(database: Database): number | undefined {
  try {
    const row = database
      .query<VersionRow, []>("SELECT version FROM schema_version WHERE id = 1")
      .get();
    return row && Number.isInteger(row.version) ? row.version : undefined;
  } catch {
    return undefined;
  }
}

function ensureSchema(database: Database, path: string): void {
  let version = readSchemaVersion(database);
  if (version === undefined) {
    // One immediate transaction for the whole schema: a second process opening
    // the file at the same time waits in the busy handler, then finds it done.
    database.transaction(() => {
      database.exec(SCHEMA);
      database.run("INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, ?)", [
        SCHEMA_VERSION,
      ]);
    }).immediate();
    version = readSchemaVersion(database);
  }

  if (version === undefined) {
    throw new SchemaVersionError(`store ${path} has no valid schema_version`);
  }
  if (version > SCHEMA_VERSION) {
    throw new SchemaVersionError(
      `store ${path} uses schema_version ${version}, but this build supports ${SCHEMA_VERSION}; ` +
        "upgrade operad to open it",
    );
  }
  if (version < SCHEMA_VERSION) {
    throw new SchemaVersionError(
      `store ${path} uses schema_version ${version}, but this build requires ${SCHEMA_VERSION}`,
    );
  }
}

class SqliteLogBackend implements LogBackend {
  readonly #database: Database;
  readonly #clock: () => number;
  readonly #path: string;
  readonly #listeners = new Set<(change: LogChange) => void>();
  #stopWatch: (() => void) | undefined;
  #snapshot: Map<string, RunSnapshot> | undefined;
  #closed = false;

  constructor(database: Database, clock: () => number, path: string) {
    this.#database = database;
    this.#clock = clock;
    this.#path = path;
  }

  async startRun(flow: string, object: string): Promise<RunInfo> {
    assertName(flow, "flow");
    assertName(object, "object");
    this.#assertOpen();
    return this.#database.transaction(() => {
      const active = this.#database
        .query<{ run_id: string }, [string, string]>(
          "SELECT run_id FROM runs WHERE flow = ? AND object = ? AND ended_at IS NULL",
        )
        .get(flow, object);
      if (active) throw new ActiveRunError(flow, object, active.run_id);

      const runId = randomUUID();
      const startedAt = this.#clock();
      this.#database.run(
        "INSERT INTO runs (run_id, flow, object, started_at, ended_at) VALUES (?, ?, ?, ?, NULL)",
        [runId, flow, object, startedAt],
      );
      this.#notify({ runId, object });
      return {
        runId,
        flow,
        object,
        active: true,
        startedAt,
        endedAt: null,
        lastSeq: 0,
      };
    }).immediate();
  }

  async endRun(runId: string): Promise<void> {
    assertRunId(runId);
    this.#assertOpen();
    this.#database.transaction(() => {
      const row = this.#runRow(runId);
      if (!row) throw new RunNotFoundError(runId);
      if (row.ended_at !== null) return;
      this.#database.run("UPDATE runs SET ended_at = ? WHERE run_id = ? AND ended_at IS NULL", [
        this.#clock(),
        runId,
      ]);
      this.#notify({ runId, object: row.object });
    }).immediate();
  }

  async recordInput(
    runId: string,
    source: string,
    sourceKey: string,
    payload: JsonValue,
  ): Promise<RecordInputResult> {
    assertRunId(runId);
    assertName(source, "source");
    assertName(sourceKey, "sourceKey");
    assertJsonValue(payload, "input payload");
    this.#assertOpen();
    return this.#database.transaction(() => {
      const row = this.#runRow(runId);
      if (!row) throw new RunNotFoundError(runId);
      if (row.ended_at !== null) throw new RunEndedError(runId);

      const inputId = inputIdFor(source, sourceKey);
      const result = this.#database.run(
        "INSERT OR IGNORE INTO inputs (input_id, run_id, source, source_key, payload, time) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
        [inputId, runId, source, sourceKey, JSON.stringify(payload), this.#clock()],
      );
      return { duplicate: result.changes === 0, inputId };
    }).immediate();
  }

  async append(
    runId: string,
    expectedSeq: number,
    facts: readonly NewFact[],
  ): Promise<AppendResult> {
    assertRunId(runId);
    assertExpectedSeq(expectedSeq);
    for (const fact of facts) validateNewFact(fact);
    this.#assertOpen();

    return this.#database.transaction(() => {
      const row = this.#runRow(runId);
      if (!row) throw new RunNotFoundError(runId);
      if (row.ended_at !== null) throw new RunEndedError(runId);
      if (row.last_seq !== expectedSeq) {
        throw new SeqConflictError(runId, expectedSeq, row.last_seq);
      }
      if (facts.length === 0) {
        return { lastSeq: row.last_seq, facts: [] };
      }

      const stored: Fact[] = facts.map((fact, index) => ({
        runId,
        seq: row.last_seq + index + 1,
        kind: fact.kind,
        payload: fact.payload,
        cause: fact.cause,
        time: this.#clock(),
      }));
      const insert = this.#database.prepare(
        "INSERT INTO facts (run_id, seq, kind, payload, cause, time) VALUES (?, ?, ?, ?, ?, ?)",
      );
      try {
        for (const fact of stored) {
          insert.run(
            fact.runId,
            fact.seq,
            fact.kind,
            JSON.stringify(fact.payload),
            JSON.stringify(fact.cause),
            fact.time,
          );
        }
      } finally {
        insert.finalize();
      }
      this.#notify({ runId, object: row.object });
      return { lastSeq: row.last_seq + stored.length, facts: stored };
    }).immediate();
  }

  read(runId: string): AsyncIterable<Fact> {
    assertRunId(runId);
    return this.#read(runId);
  }

  async runs(options: RunsOptions = {}): Promise<RunInfo[]> {
    this.#assertOpen();
    const activeOnly = options.active === true ? 1 : 0;
    const rows = this.#database
      .query<RunRow, [number]>(
        "SELECT r.run_id, r.flow, r.object, r.started_at, r.ended_at, " +
          "COALESCE(f.last_seq, 0) AS last_seq " +
          "FROM runs r LEFT JOIN (" +
          "  SELECT run_id, MAX(seq) AS last_seq FROM facts GROUP BY run_id" +
          ") f ON f.run_id = r.run_id " +
          "WHERE (? = 0 OR r.ended_at IS NULL) " +
          "ORDER BY r.started_at, r.run_id",
      )
      .all(activeOnly);
    return rows.map((row) => this.#toRunInfo(row));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopWatch?.();
    this.#stopWatch = undefined;
    this.#listeners.clear();
    this.#database.close();
  }

  /** Tells a listener in this process when a run changes. */
  subscribe(listener: (change: LogChange) => void): () => void {
    this.#listeners.add(listener);
    if (this.#stopWatch === undefined) {
      this.#snapshot = this.#takeSnapshot();
      this.#stopWatch = watchDirectory(dirname(this.#path), () => {
        this.#notifyExternal();
      });
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#stopWatch?.();
        this.#stopWatch = undefined;
        this.#snapshot = undefined;
      }
    };
  }

  #notify(change: LogChange): void {
    for (const listener of this.#listeners) listener(change);
  }

  /** Reports runs another connection changed since the last event. */
  #notifyExternal(): void {
    if (this.#closed) return;
    let next: Map<string, RunSnapshot>;
    try {
      next = this.#takeSnapshot();
    } catch {
      return;
    }
    const previous = this.#snapshot;
    this.#snapshot = next;
    if (previous === undefined) return;
    for (const [runId, run] of next) {
      const before = previous.get(runId);
      if (
        before !== undefined &&
        before.object === run.object &&
        before.lastSeq === run.lastSeq &&
        before.ended === run.ended
      ) {
        continue;
      }
      this.#notify({ runId, object: run.object });
    }
  }

  #takeSnapshot(): Map<string, RunSnapshot> {
    const rows = this.#database
      .query<RunRow, []>(
        "SELECT r.run_id, r.flow, r.object, r.started_at, r.ended_at, " +
          "COALESCE((SELECT MAX(seq) FROM facts WHERE run_id = r.run_id), 0) AS last_seq " +
          "FROM runs r",
      )
      .all();
    const snapshot = new Map<string, RunSnapshot>();
    for (const row of rows) {
      snapshot.set(row.run_id, {
        object: row.object,
        lastSeq: row.last_seq,
        ended: row.ended_at !== null,
      });
    }
    return snapshot;
  }

  async *#read(runId: string): AsyncGenerator<Fact> {
    this.#assertOpen();
    if (!this.#runRow(runId)) throw new RunNotFoundError(runId);

    const statement = this.#database.prepare<FactRow, [string]>(
      "SELECT seq, kind, payload, cause, time FROM facts WHERE run_id = ? ORDER BY seq",
    );
    let expectedSeq = 1;
    try {
      for (const row of statement.iterate(runId)) {
        if (row.seq !== expectedSeq) {
          throw new CorruptLogError(runId, `sequence ${row.seq} follows ${expectedSeq - 1}`);
        }
        expectedSeq += 1;
        yield {
          runId,
          seq: row.seq,
          kind: row.kind,
          payload: JSON.parse(row.payload) as JsonValue,
          cause: JSON.parse(row.cause) as FactCause,
          time: row.time,
        };
      }
    } finally {
      statement.finalize();
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new StoreClosedError();
  }

  #runRow(runId: string): RunRow | null {
    return (
      this.#database
        .query<RunRow, [string]>(
          "SELECT r.run_id, r.flow, r.object, r.started_at, r.ended_at, " +
            "COALESCE((SELECT MAX(seq) FROM facts WHERE run_id = r.run_id), 0) AS last_seq " +
            "FROM runs r WHERE r.run_id = ?",
        )
        .get(runId) ?? null
    );
  }

  #toRunInfo(row: RunRow): RunInfo {
    return {
      runId: row.run_id,
      flow: row.flow,
      object: row.object,
      active: row.ended_at === null,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      lastSeq: row.last_seq,
    };
  }
}

/**
 * Open the log at `path`, which is the database file itself. Parent
 * directories are created. A directory the process cannot write is reported at
 * open with the path in the message.
 */
export function openSqliteLogBackend(
  path: string,
  options: LogBackendOptions = {},
): LogBackend {
  if (typeof path !== "string" || path.length === 0) {
    throw new InvalidPayloadError("the sqlite log path must be a non-empty string");
  }
  ensureDirectory(path);

  let database: Database;
  try {
    database = new Database(path, { create: true, readwrite: true });
  } catch (error) {
    throw openFailure(path, error);
  }

  try {
    configure(database);
    ensureSchema(database, path);
  } catch (error) {
    database.close();
    if (error instanceof LogBackendError) throw error;
    throw openFailure(path, error);
  }

  return new SqliteLogBackend(database, options.clock ?? Date.now, path);
}

export const sqliteBackend: LogBackendFactory = {
  name: "sqlite",
  open: (directory, options) =>
    openSqliteLogBackend(join(directory, SQLITE_FILE_NAME), options),
};

export default sqliteBackend;
