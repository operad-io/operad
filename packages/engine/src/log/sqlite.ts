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
import { assertStoreNotMoving } from "../runner/lock.ts";
import {
  enableWal,
  resolveSubscriptionWatch,
  setBusyTimeout,
  type SubscriptionWatch,
} from "../platform/index.ts";
import type {
  AppendResult,
  Fact,
  FactCause,
  GlobalFact,
  InputRecord,
  InputOutcome,
  InputsAfter,
  JsonValue,
  LogBackend,
  LogBackendFactory,
  LogBackendOptions,
  LogChange,
  NewFact,
  RecordInputResult,
  RecordOutcomeResult,
  RunInfo,
  RunsOptions,
} from "./types.ts";

/** The file the sqlite factory creates inside the store directory. */
export const SQLITE_FILE_NAME = "log.sqlite";

export { BUSY_TIMEOUT_MS } from "../platform/index.ts";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_version (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runs (
    run_id         TEXT PRIMARY KEY,
    flow           TEXT NOT NULL,
    object         TEXT NOT NULL,
    started_at     INTEGER NOT NULL,
    ended_at       INTEGER,
    start_input_id TEXT,
    access         TEXT
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
    run_id     TEXT REFERENCES runs (run_id),
    source     TEXT NOT NULL,
    source_key TEXT NOT NULL,
    payload    TEXT NOT NULL,
    time       INTEGER NOT NULL,
    UNIQUE (source, source_key)
  );
  CREATE TABLE IF NOT EXISTS global_facts (
    seq        INTEGER PRIMARY KEY,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    cause      TEXT NOT NULL,
    time       INTEGER NOT NULL,
    unique_key TEXT
  );
  CREATE TABLE IF NOT EXISTS outcomes (
    input_id TEXT NOT NULL,
    kind     TEXT NOT NULL,
    payload  TEXT NOT NULL,
    seq      INTEGER NOT NULL UNIQUE,
    time     INTEGER NOT NULL,
    PRIMARY KEY (input_id, kind)
  );
`;

interface RunRow {
  readonly run_id: string;
  readonly flow: string;
  readonly object: string;
  readonly started_at: number;
  readonly ended_at: number | null;
  readonly last_seq: number;
  readonly access: string | null;
  readonly start_input_id: string | null;
}

interface InputRow {
  readonly input_id: string;
  readonly run_id: string | null;
  readonly source: string;
  readonly source_key: string;
  readonly payload: string;
  readonly time: number;
}

interface FactRow {
  readonly seq: number;
  readonly kind: string;
  readonly payload: string;
  readonly cause: string;
  readonly time: number;
}

interface OutcomeRow {
  readonly input_id: string;
  readonly kind: string;
  readonly payload: string;
  readonly seq: number;
  readonly time: number;
}

interface GlobalFactRow {
  readonly seq: number;
  readonly kind: string;
  readonly payload: string;
  readonly cause: string;
  readonly time: number;
  readonly unique_key: string | null;
}

function globalFactOfRow(row: GlobalFactRow): GlobalFact {
  return {
    seq: row.seq,
    kind: row.kind,
    payload: JSON.parse(row.payload) as JsonValue,
    cause: JSON.parse(row.cause) as FactCause,
    time: row.time,
    ...(row.unique_key === null ? {} : { uniqueKey: row.unique_key }),
  };
}

function inputOfRow(row: InputRow): InputRecord {
  return {
    inputId: row.input_id,
    runId: row.run_id,
    source: row.source,
    sourceKey: row.source_key,
    payload: JSON.parse(row.payload) as JsonValue,
    time: row.time,
  };
}

function outcomeOfRow(row: OutcomeRow): InputOutcome {
  return {
    inputId: row.input_id,
    kind: row.kind,
    payload: JSON.parse(row.payload) as JsonValue,
    seq: row.seq,
    time: row.time,
  };
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

interface TableColumn {
  readonly name: string;
  readonly notnull: number;
}

function tableColumns(database: Database, table: string): TableColumn[] {
  try {
    return database
      .query<TableColumn, []>(`PRAGMA table_info(${table})`)
      .all();
  } catch {
    return [];
  }
}

function hasTable(database: Database, table: string): boolean {
  return (
    database
      .query<{ name: string }, [string]>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table) !== null
  );
}

/** True for a store written before trigger inputs could be global. */
function inputsNeedMigration(database: Database): boolean {
  const column = tableColumns(database, "inputs").find((item) => item.name === "run_id");
  return column !== undefined && column.notnull === 1;
}

/** Rebuild `inputs` so `run_id` may be null; the old table cannot be altered. */
function migrateInputs(database: Database): void {
  database.exec(`
    CREATE TABLE inputs_global (
      input_id   TEXT PRIMARY KEY,
      run_id     TEXT REFERENCES runs (run_id),
      source     TEXT NOT NULL,
      source_key TEXT NOT NULL,
      payload    TEXT NOT NULL,
      time       INTEGER NOT NULL,
      UNIQUE (source, source_key)
    );
    INSERT OR IGNORE INTO inputs_global (input_id, run_id, source, source_key, payload, time)
      SELECT input_id, run_id, source, source_key, payload, time FROM inputs;
    DROP TABLE inputs;
    ALTER TABLE inputs_global RENAME TO inputs;
  `);
}

interface DataVersionRow {
  readonly data_version: number;
}

function openFailure(path: string, error: unknown): LogBackendError {
  const detail = error instanceof Error ? error.message : String(error);
  return new LogBackendError(`cannot open the sqlite log at ${path}: ${detail}`);
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
  setBusyTimeout(database);
  database.run("PRAGMA synchronous = FULL");
  database.run("PRAGMA foreign_keys = ON");
  enableWal(database);
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
    version = migrateSchema(database, path, version);
  }
  if (version < SCHEMA_VERSION) {
    throw new SchemaVersionError(
      `store ${path} uses schema_version ${version}, but this build requires ${SCHEMA_VERSION}`,
    );
  }

  // Tables added after a store was created are created here; the same
  // transaction migrates an older inputs table whose run id could not be null
  // and an older runs table that could not name the input that made the run.
  database.transaction(() => {
    if (inputsNeedMigration(database)) migrateInputs(database);
    if (!hasTable(database, "global_facts") || !hasTable(database, "outcomes")) {
      database.exec(SCHEMA);
    }
    const runsHaveStartInput = tableColumns(database, "runs").some(
      (item) => item.name === "start_input_id",
    );
    if (!runsHaveStartInput) {
      database.exec("ALTER TABLE runs ADD COLUMN start_input_id TEXT");
    }
    // A store written before global facts could be unique gains the column.
    const globalHasUniqueKey = tableColumns(database, "global_facts").some(
      (item) => item.name === "unique_key",
    );
    if (!globalHasUniqueKey) {
      database.exec("ALTER TABLE global_facts ADD COLUMN unique_key TEXT");
    }
    database.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS global_facts_unique_key " +
        "ON global_facts (unique_key) WHERE unique_key IS NOT NULL",
    );
  }).immediate();
}

/**
 * Upgrades an older store in place, one version at a time. Version 1 had no
 * `runs.access` column; the column is additive, so the existing runs and
 * history stay exactly as they were.
 */
function migrateSchema(database: Database, path: string, from: number): number {
  let version = from;
  while (version < SCHEMA_VERSION) {
    if (version === 1) {
      database.transaction(() => {
        const columns = database
          .query<{ readonly name: string }, []>("PRAGMA table_info(runs)")
          .all();
        if (!columns.some((column) => column.name === "access")) {
          database.run("ALTER TABLE runs ADD COLUMN access TEXT");
        }
        database.run("UPDATE schema_version SET version = ? WHERE id = 1", [2]);
      }).immediate();
      version = 2;
      continue;
    }
    throw new SchemaVersionError(
      `store ${path} uses schema_version ${version}, but this build requires ${SCHEMA_VERSION}`,
    );
  }
  return version;
}

class SqliteLogBackend implements LogBackend {
  readonly #database: Database;
  readonly #clock: () => number;
  readonly #newRunId: () => string;
  readonly #path: string;
  readonly #subscriptionWatch: SubscriptionWatch;
  readonly #listeners = new Set<(change: LogChange) => void>();
  #stopWatch: (() => void) | undefined;
  #stopPoll: (() => void) | undefined;
  #dataVersion: number | undefined;
  #snapshot: Map<string, RunSnapshot> | undefined;
  #closed = false;

  constructor(
    database: Database,
    clock: () => number,
    newRunId: () => string,
    path: string,
    subscriptionWatch: SubscriptionWatch,
  ) {
    this.#database = database;
    this.#clock = clock;
    this.#newRunId = newRunId;
    this.#path = path;
    this.#subscriptionWatch = subscriptionWatch;
  }

  async startRun(
    flow: string,
    object: string,
    startInputId: string | null = null,
    access?: JsonValue,
  ): Promise<RunInfo> {
    assertName(flow, "flow");
    assertName(object, "object");
    if (access !== undefined) assertJsonValue(access, "run access");
    this.#assertOpen();
    return this.#database.transaction(() => {
      assertStoreNotMoving(dirname(this.#path));
      const active = this.#database
        .query<{ run_id: string }, [string, string]>(
          "SELECT run_id FROM runs WHERE flow = ? AND object = ? AND ended_at IS NULL",
        )
        .get(flow, object);
      if (active) throw new ActiveRunError(flow, object, active.run_id);

      const runId = this.#newRunId();
      assertRunId(runId);
      const startedAt = this.#clock();
      this.#database.run(
        "INSERT INTO runs (run_id, flow, object, started_at, ended_at, start_input_id, access) " +
          "VALUES (?, ?, ?, ?, NULL, ?, ?)",
        [
          runId,
          flow,
          object,
          startedAt,
          startInputId,
          access === undefined ? null : JSON.stringify(access),
        ],
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
        ...(access === undefined ? {} : { access }),
        startInputId,
      };
    }).immediate();
  }

  async endRun(runId: string): Promise<void> {
    assertRunId(runId);
    this.#assertOpen();
    this.#database.transaction(() => {
      assertStoreNotMoving(dirname(this.#path));
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
    runId: string | null,
    source: string,
    sourceKey: string,
    payload: JsonValue,
  ): Promise<RecordInputResult> {
    if (runId !== null) assertRunId(runId);
    assertName(source, "source");
    assertName(sourceKey, "sourceKey");
    assertJsonValue(payload, "input payload");
    this.#assertOpen();
    return this.#database.transaction(() => {
      assertStoreNotMoving(dirname(this.#path));
      if (runId !== null) {
        const row = this.#runRow(runId);
        if (!row) throw new RunNotFoundError(runId);
        if (row.ended_at !== null) throw new RunEndedError(runId);
      }

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
      assertStoreNotMoving(dirname(this.#path));
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
        "SELECT r.run_id, r.flow, r.object, r.started_at, r.ended_at, r.start_input_id, r.access, " +
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
    this.#stopNotifications();
    this.#listeners.clear();
    this.#database.close();
  }

  async appendGlobal(fact: NewFact, uniqueKey?: string): Promise<GlobalFact> {
    validateNewFact(fact);
    if (uniqueKey !== undefined) assertName(uniqueKey, "uniqueKey");
    this.#assertOpen();
    return this.#database.transaction(() => {
      assertStoreNotMoving(dirname(this.#path));
      if (uniqueKey !== undefined) {
        const existing = this.#database
          .query<GlobalFactRow, [string]>(
            "SELECT seq, kind, payload, cause, time, unique_key FROM global_facts " +
              "WHERE unique_key = ?",
          )
          .get(uniqueKey) ?? undefined;
        if (existing !== undefined) return globalFactOfRow(existing);
      }
      const row = this.#database
        .query<{ seq: number | null }, []>("SELECT MAX(seq) AS seq FROM global_facts")
        .get();
      const seq = (row?.seq ?? 0) + 1;
      const time = this.#clock();
      this.#database.run(
        "INSERT INTO global_facts (seq, kind, payload, cause, time, unique_key) " +
          "VALUES (?, ?, ?, ?, ?, ?)",
        [
          seq,
          fact.kind,
          JSON.stringify(fact.payload),
          JSON.stringify(fact.cause),
          time,
          uniqueKey ?? null,
        ],
      );
      return {
        seq,
        kind: fact.kind,
        payload: fact.payload,
        cause: fact.cause,
        time,
        ...(uniqueKey === undefined ? {} : { uniqueKey }),
      };
    }).immediate();
  }

  readGlobal(): AsyncIterable<GlobalFact> {
    return this.#readGlobal();
  }

  async *readInputs(): AsyncGenerator<InputRecord> {
    this.#assertOpen();
    const statement = this.#database.prepare<InputRow, []>(
      "SELECT input_id, run_id, source, source_key, payload, time " +
        "FROM inputs ORDER BY time, input_id",
    );
    try {
      for (const row of statement.iterate()) yield inputOfRow(row);
    } finally {
      statement.finalize();
    }
  }

  async readInputsAfter(position: number): Promise<InputsAfter> {
    this.#assertOpen();
    const rows = this.#database
      .query<InputRow & { pos: number }, [number]>(
        "SELECT rowid AS pos, input_id, run_id, source, source_key, payload, time " +
          "FROM inputs WHERE rowid > ? ORDER BY rowid",
      )
      .all(position);
    const last = rows[rows.length - 1];
    return {
      inputs: rows.map(inputOfRow),
      position: last === undefined ? position : last.pos,
    };
  }

  async findInput(inputId: string): Promise<InputRecord | undefined> {
    this.#assertOpen();
    const row = this.#database
      .query<InputRow, [string]>(
        "SELECT input_id, run_id, source, source_key, payload, time " +
          "FROM inputs WHERE input_id = ?",
      )
      .get(inputId);
    return row === null || row === undefined ? undefined : inputOfRow(row);
  }

  async readOutcome(
    inputId: string,
    kind: string,
  ): Promise<InputOutcome | undefined> {
    this.#assertOpen();
    const row = this.#outcomeRow(inputId, kind);
    return row === undefined ? undefined : outcomeOfRow(row);
  }

  async readOutcomesAfter(seq: number): Promise<InputOutcome[]> {
    this.#assertOpen();
    return this.#database
      .query<OutcomeRow, [number]>(
        "SELECT input_id, kind, payload, seq, time FROM outcomes " +
          "WHERE seq > ? ORDER BY seq",
      )
      .all(seq)
      .map(outcomeOfRow);
  }

  async recordOutcome(
    inputId: string,
    kind: string,
    payload: JsonValue,
  ): Promise<RecordOutcomeResult> {
    assertName(inputId, "inputId");
    assertName(kind, "outcome kind");
    assertJsonValue(payload, "outcome payload");
    this.#assertOpen();
    return this.#database.transaction(() => {
      assertStoreNotMoving(dirname(this.#path));
      const existing = this.#outcomeRow(inputId, kind);
      if (existing !== undefined) {
        return { duplicate: true, outcome: outcomeOfRow(existing) };
      }
      const next = this.#database
        .query<{ next: number }, []>(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM outcomes",
        )
        .get();
      const seq = next?.next ?? 1;
      const time = this.#clock();
      this.#database.run(
        "INSERT INTO outcomes (input_id, kind, payload, seq, time) VALUES (?, ?, ?, ?, ?)",
        [inputId, kind, JSON.stringify(payload), seq, time],
      );
      return {
        duplicate: false,
        outcome: { inputId, kind, payload, seq, time },
      };
    }).immediate();
  }

  async *readOutcomes(): AsyncGenerator<InputOutcome> {
    this.#assertOpen();
    const statement = this.#database.prepare<OutcomeRow, []>(
      "SELECT input_id, kind, payload, seq, time FROM outcomes ORDER BY seq",
    );
    try {
      for (const row of statement.iterate()) {
        yield outcomeOfRow(row);
      }
    } finally {
      statement.finalize();
    }
  }

  #outcomeRow(inputId: string, kind: string): OutcomeRow | undefined {
    return this.#database
      .query<OutcomeRow, [string, string]>(
        "SELECT input_id, kind, payload, seq, time FROM outcomes " +
          "WHERE input_id = ? AND kind = ?",
      )
      .get(inputId, kind) ?? undefined;
  }

  async *#readGlobal(): AsyncGenerator<GlobalFact> {
    this.#assertOpen();
    const statement = this.#database.prepare<GlobalFactRow, []>(
      "SELECT seq, kind, payload, cause, time, unique_key FROM global_facts ORDER BY seq",
    );
    try {
      for (const row of statement.iterate()) {
        yield globalFactOfRow(row);
      }
    } finally {
      statement.finalize();
    }
  }

  /** Tells a listener in this process when a run changes. */
  subscribe(listener: (change: LogChange) => void): () => void {
    this.#listeners.add(listener);
    if (this.#stopWatch === undefined) {
      // Read the version before the snapshot: a write between the two is
      // already in the snapshot and needs no event.
      this.#dataVersion = this.#readDataVersion();
      this.#snapshot = this.#takeSnapshot();
      this.#stopWatch = this.#subscriptionWatch.watch(dirname(this.#path), () => {
        this.#notifyExternal();
      });
      this.#stopPoll = this.#subscriptionWatch.repeat(this.#subscriptionWatch.pollMs, () => {
        this.#poll();
      });
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#stopNotifications();
    };
  }

  #stopNotifications(): void {
    this.#stopWatch?.();
    this.#stopWatch = undefined;
    this.#stopPoll?.();
    this.#stopPoll = undefined;
    this.#snapshot = undefined;
    this.#dataVersion = undefined;
  }

  #notify(change: LogChange): void {
    for (const listener of this.#listeners) listener(change);
  }

  /**
   * The fallback check. `PRAGMA data_version` changes whenever another
   * connection commits, including a commit the directory watch never reported.
   */
  #poll(): void {
    if (this.#closed || this.#listeners.size === 0) return;
    let version: number;
    try {
      version = this.#readDataVersion();
    } catch {
      return;
    }
    if (version === this.#dataVersion) return;
    this.#dataVersion = version;
    this.#notifyExternal();
  }

  #readDataVersion(): number {
    return (
      this.#database
        .query<DataVersionRow, []>("PRAGMA data_version")
        .get()?.data_version ?? 0
    );
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
          "SELECT r.run_id, r.flow, r.object, r.started_at, r.ended_at, r.start_input_id, r.access, " +
            "COALESCE((SELECT MAX(seq) FROM facts WHERE run_id = r.run_id), 0) AS last_seq " +
            "FROM runs r WHERE r.run_id = ?",
        )
        .get(runId) ?? null
    );
  }

  #toRunInfo(row: RunRow): RunInfo {
    let access: JsonValue | undefined;
    if (row.access !== null) {
      try {
        access = JSON.parse(row.access) as JsonValue;
      } catch {
        access = undefined;
      }
    }
    return {
      runId: row.run_id,
      flow: row.flow,
      object: row.object,
      active: row.ended_at === null,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      lastSeq: row.last_seq,
      ...(access === undefined ? {} : { access }),
      startInputId: row.start_input_id,
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

  return new SqliteLogBackend(
    database,
    options.clock ?? Date.now,
    options.runId ?? randomUUID,
    path,
    resolveSubscriptionWatch(options),
  );
}

export const sqliteBackend: LogBackendFactory = {
  name: "sqlite",
  open: (directory, options) =>
    openSqliteLogBackend(join(directory, SQLITE_FILE_NAME), options),
};

export default sqliteBackend;
