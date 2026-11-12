import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  LogBackendError,
  SCHEMA_VERSION,
  SQLITE_FILE_NAME,
  openSqliteLogBackend,
  type Fact,
  type LogBackendOptions,
  type LogChange,
} from "../src/index.ts";
import { runLogConformance, type LogConformanceFactory } from "./log-conformance.ts";

const TEST_ROOT = resolve(import.meta.dir, "..", "..", "..", ".radian", "test-tmp");
const CHILD = join(import.meta.dir, "fixtures", "log-child.ts");
const MODULE = new URL("../src/log/sqlite.ts", import.meta.url).href;

const dbPath = (directory: string): string => join(directory, SQLITE_FILE_NAME);

function tempDirectory(label: string): string {
  mkdirSync(TEST_ROOT, { recursive: true });
  const directory = join(TEST_ROOT, `${label}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function withDatabase<T>(directory: string, fn: (database: Database) => T): T {
  const database = new Database(dbPath(directory));
  try {
    return fn(database);
  } finally {
    database.close();
  }
}

function hasObject(directory: string, type: "table" | "index", name: string): boolean {
  return withDatabase(directory, (database) =>
    database
      .query<{ name: string }, [string, string]>(
        "SELECT name FROM sqlite_master WHERE type = ? AND name = ?",
      )
      .get(type, name) !== null,
  );
}

function open(directory: string, options?: LogBackendOptions) {
  return openSqliteLogBackend(dbPath(directory), options);
}

async function collect(facts: AsyncIterable<Fact>): Promise<Fact[]> {
  const result: Fact[] = [];
  for await (const fact of facts) result.push(fact);
  return result;
}

async function captureError(action: () => unknown): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("expected the action to fail");
}

interface ChildResult {
  readonly ok: boolean;
  readonly lastSeq?: number;
  readonly name?: string;
  readonly message?: string;
}

async function appendFromChild(
  directory: string,
  runId: string,
  expectedSeq: number,
): Promise<ChildResult> {
  const proc = Bun.spawn([process.execPath, CHILD, "append-once"], {
    cwd: TEST_ROOT,
    env: {
      ...process.env,
      OPERAD_LOG_BACKEND_MODULE: MODULE,
      OPERAD_LOG_STORE: directory,
      OPERAD_RUN_ID: runId,
      OPERAD_EXPECTED_SEQ: String(expectedSeq),
      OPERAD_WHO: "child",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, line, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (line.trim().length === 0) {
    throw new Error(`append child exited ${exitCode}: ${stderr}`);
  }
  return JSON.parse(line.trim()) as ChildResult;
}

const factory: LogConformanceFactory = {
  name: "sqlite",
  modulePath: MODULE,
  open,
  readSchemaVersion(directory) {
    return withDatabase(directory, (database) => {
      try {
        const row = database
          .query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1")
          .get();
        return row?.version;
      } catch {
        return undefined;
      }
    });
  },
  writeSchemaVersion(directory, version) {
    withDatabase(directory, (database) => {
      database.run("UPDATE schema_version SET version = ? WHERE id = 1", [version]);
    });
  },
  removeRun(directory, runId) {
    withDatabase(directory, (database) => {
      database.transaction(() => {
        database.run("DELETE FROM facts WHERE run_id = ?", [runId]);
        database.run("DELETE FROM inputs WHERE run_id = ?", [runId]);
        database.run("DELETE FROM runs WHERE run_id = ?", [runId]);
      }).immediate();
    });
  },
  countInputRecords(directory) {
    return withDatabase(directory, (database) => {
      const row = database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM inputs")
        .get();
      return row?.count ?? 0;
    });
  },
  storedText(directory) {
    return withDatabase(directory, (database) => {
      const facts = database.query("SELECT * FROM facts").all();
      const inputs = database.query("SELECT * FROM inputs").all();
      return JSON.stringify(facts) + JSON.stringify(inputs);
    });
  },
};

runLogConformance(factory);

const directories = new Set<string>();

afterEach(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
  directories.clear();
});

function tracked(label: string): string {
  const directory = tempDirectory(label);
  directories.add(directory);
  return directory;
}

test("opens a schema_version 1 store and adds the access column", async () => {
  const directory = tracked("migrate-v1");
  const database = new Database(dbPath(directory));
  try {
    database.exec(`
      CREATE TABLE schema_version (
        id      INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      );
      INSERT INTO schema_version (id, version) VALUES (1, 1);
      CREATE TABLE runs (
        run_id     TEXT PRIMARY KEY,
        flow       TEXT NOT NULL,
        object     TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at   INTEGER
      );
      CREATE UNIQUE INDEX runs_one_active
        ON runs (flow, object) WHERE ended_at IS NULL;
      CREATE TABLE facts (
        run_id  TEXT NOT NULL REFERENCES runs (run_id),
        seq     INTEGER NOT NULL,
        kind    TEXT NOT NULL,
        payload TEXT NOT NULL,
        cause   TEXT NOT NULL,
        time    INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE inputs (
        input_id   TEXT PRIMARY KEY,
        run_id     TEXT NOT NULL REFERENCES runs (run_id),
        source     TEXT NOT NULL,
        source_key TEXT NOT NULL,
        payload    TEXT NOT NULL,
        time       INTEGER NOT NULL,
        UNIQUE (source, source_key)
      );
      INSERT INTO runs (run_id, flow, object, started_at, ended_at)
        VALUES ('old', 'flow', 'object', 1000, 2000);
      INSERT INTO facts (run_id, seq, kind, payload, cause, time)
        VALUES ('old', 1, 'run_started', '{"flow":"flow"}', 'test', 1000);
    `);
  } finally {
    database.close();
  }

  const backend = await open(directory);
  try {
    const runs = await backend.runs();
    expect(runs.map((run) => run.runId)).toEqual(["old"]);
    expect(runs[0]?.access).toBeUndefined();
    expect(withDatabase(directory, (current) =>
      current
        .query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1")
        .get(),
    )?.version).toBe(SCHEMA_VERSION);

    const started = await backend.startRun("other", "object", null, { network: "all" });
    expect(started.access).toEqual({ network: "all" });
    const stored = (await backend.runs()).find((run) => run.runId === started.runId);
    expect(stored?.access).toEqual({ network: "all" });
  } finally {
    await backend.close();
  }
});

test("a current store missing a base table or index is repaired on open", async () => {
  const missing = [
    { label: "facts", statement: "DROP TABLE facts", type: "table", name: "facts" },
    { label: "inputs", statement: "DROP TABLE inputs", type: "table", name: "inputs" },
    {
      label: "runs-one-active",
      statement: "DROP INDEX runs_one_active",
      type: "index",
      name: "runs_one_active",
    },
  ] as const;

  for (const item of missing) {
    const directory = tracked(`repair-${item.label}`);
    const first = await open(directory);
    await first.close();
    withDatabase(directory, (database) => database.exec(item.statement));

    const backend = await open(directory);
    try {
      const run = await backend.startRun("flow", "object");
      await backend.append(run.runId, 0, [{ kind: "seed", payload: {}, cause: 1 }]);
      await backend.recordInput(run.runId, "source", "key", {});
      expect(await backend.runs()).toHaveLength(1);
    } finally {
      await backend.close();
    }
    expect(hasObject(directory, item.type, item.name)).toBe(true);
  }
});

test("the store runs in WAL mode", async () => {
  const directory = tracked("wal");
  const backend = await open(directory);
  try {
    const mode = withDatabase(directory, (database) =>
      database
        .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
        .get(),
    );
    expect(mode?.journal_mode).toBe("wal");
  } finally {
    await backend.close();
  }
});

test("a store from before global inputs is migrated on open", async () => {
  const directory = tracked("legacy-inputs");
  const legacy = new Database(dbPath(directory));
  try {
    legacy.exec(`
      CREATE TABLE schema_version (
        id      INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      );
      CREATE TABLE runs (
        run_id     TEXT PRIMARY KEY,
        flow       TEXT NOT NULL,
        object     TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at   INTEGER
      );
      CREATE UNIQUE INDEX runs_one_active
        ON runs (flow, object) WHERE ended_at IS NULL;
      CREATE TABLE facts (
        run_id  TEXT NOT NULL REFERENCES runs (run_id),
        seq     INTEGER NOT NULL,
        kind    TEXT NOT NULL,
        payload TEXT NOT NULL,
        cause   TEXT NOT NULL,
        time    INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE inputs (
        input_id   TEXT PRIMARY KEY,
        run_id     TEXT NOT NULL REFERENCES runs (run_id),
        source     TEXT NOT NULL,
        source_key TEXT NOT NULL,
        payload    TEXT NOT NULL,
        time       INTEGER NOT NULL,
        UNIQUE (source, source_key)
      );
      CREATE TABLE global_facts (
        seq     INTEGER PRIMARY KEY,
        kind    TEXT NOT NULL,
        payload TEXT NOT NULL,
        cause   TEXT NOT NULL,
        time    INTEGER NOT NULL
      );
      INSERT INTO schema_version (id, version) VALUES (1, 1);
    `);
  } finally {
    legacy.close();
  }

  const backend = await open(directory);
  try {
    const run = await backend.startRun("flow", "object");
    const withInput = await backend.startRun("flow", "with-input", "input_x");
    expect(withInput.startInputId).toBe("input_x");
    const global = await backend.recordInput(null, "cron", "tick:1", {});
    expect(global.duplicate).toBe(false);
    const scoped = await backend.recordInput(run.runId, "github", "issue:1", {});
    expect(scoped.duplicate).toBe(false);
    await backend.appendGlobal({
      kind: "trigger_observed",
      payload: { reason: "would start one on object" },
      cause: global.inputId,
    });
    const unique = await backend.appendGlobal(
      {
        kind: "trigger_observed",
        payload: { reason: "would start one on object" },
        cause: global.inputId,
      },
      "trigger_observed:one",
    );
    const duplicate = await backend.appendGlobal(
      {
        kind: "trigger_observed",
        payload: { reason: "a second writer" },
        cause: global.inputId,
      },
      "trigger_observed:one",
    );
    expect(duplicate.seq).toBe(unique.seq);
  } finally {
    await backend.close();
  }

  const columns = withDatabase(directory, (database) =>
    database
      .query<{ name: string; notnull: number }, []>("PRAGMA table_info(inputs)")
      .all(),
  );
  expect(columns.find((column) => column.name === "run_id")?.notnull).toBe(0);
  const runColumns = withDatabase(directory, (database) =>
    database
      .query<{ name: string }, []>("PRAGMA table_info(runs)")
      .all(),
  );
  expect(runColumns.some((column) => column.name === "start_input_id")).toBe(true);
  const globalColumns = withDatabase(directory, (database) =>
    database
      .query<{ name: string }, []>("PRAGMA table_info(global_facts)")
      .all(),
  );
  expect(globalColumns.some((column) => column.name === "unique_key")).toBe(true);
});

test("a subscription learns of a write when the watch never fires", async () => {
  const directory = tracked("poll-fallback");
  let tick: (() => void) | undefined;
  let stopped = false;
  const reader = await openSqliteLogBackend(dbPath(directory), {
    clock: () => 1_000,
    watch: () => () => undefined,
    repeat: (ms, callback) => {
      expect(ms).toBe(500);
      tick = callback;
      return () => {
        stopped = true;
      };
    },
  });
  const writer = await openSqliteLogBackend(dbPath(directory));
  try {
    const changes: LogChange[] = [];
    const subscribe = reader.subscribe;
    if (subscribe === undefined) throw new Error("the sqlite log does not subscribe");
    const unsubscribe = subscribe.call(reader, (change) => changes.push(change));

    const run = await writer.startRun("flow", "object");
    await writer.append(run.runId, 0, [
      { kind: "run_started", payload: { flow: "flow" }, cause: "test" },
    ]);
    // The stubbed watch never fires, so nothing has been reported yet.
    expect(changes).toEqual([]);

    if (tick === undefined) throw new Error("the poll did not start");
    tick();
    expect(changes).toEqual([{ runId: run.runId, object: "object" }]);

    unsubscribe();
    expect(stopped).toBe(true);
  } finally {
    await reader.close();
    await writer.close();
  }
});

test.skipIf(process.getuid?.() === 0)(
  "opening a store in a read-only directory fails with a clear error",
  async () => {
    const directory = tracked("read-only");
    const path = dbPath(directory);

    chmodSync(directory, 0o555);
    try {
      for (const target of [path, join(directory, "another.sqlite")]) {
        const error = await captureError(() => openSqliteLogBackend(target));
        expect(error).toBeInstanceOf(LogBackendError);
        const message = (error as Error).message;
        expect(message).toContain("cannot open the sqlite log");
        expect(message).toContain(target);
      }
    } finally {
      chmodSync(directory, 0o755);
    }

    // An existing store is refused too: a writable-looking read would fail on
    // the first append, so open checks that the file can take a transaction.
    const existing = tracked("read-only-existing");
    const existingPath = dbPath(existing);
    const created = await openSqliteLogBackend(existingPath);
    await created.startRun("flow", "object");
    await created.close();

    chmodSync(existing, 0o555);
    try {
      const error = await captureError(() => openSqliteLogBackend(existingPath));
      expect(error).toBeInstanceOf(LogBackendError);
      expect((error as Error).message).toContain("cannot open the sqlite log");
    } finally {
      chmodSync(existing, 0o755);
    }
  },
);

test("a long read sees a consistent prefix while another process appends", async () => {
  const directory = tracked("long-read");
  const backend = await open(directory);
  try {
    const run = await backend.startRun("flow", "object");
    const seed = Array.from({ length: 4 }, (_, index) => ({
      kind: `seed-${index}`,
      payload: { index },
      cause: 1,
    }));
    await backend.append(run.runId, 0, seed);

    const iterator = backend.read(run.runId)[Symbol.asyncIterator]();
    const seen: Fact[] = [];
    const first = await iterator.next();
    if (!first.done) seen.push(first.value);

    // The child appends after the read has taken its first fact. WAL lets it
    // commit while the read statement still holds its snapshot.
    const child = await appendFromChild(directory, run.runId, seed.length);
    expect(child.ok).toBe(true);
    expect(child.lastSeq).toBe(seed.length + 1);

    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      seen.push(next.value);
    }

    expect(seen.map((fact) => fact.kind)).toEqual(seed.map((fact) => fact.kind));
    expect(seen.map((fact) => fact.seq)).toEqual([1, 2, 3, 4]);

    const after = await collect(backend.read(run.runId));
    expect(after.map((fact) => fact.kind)).toEqual([...seed.map((fact) => fact.kind), "race"]);
  } finally {
    await backend.close();
  }
});
