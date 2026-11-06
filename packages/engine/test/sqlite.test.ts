import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  LogBackendError,
  SQLITE_FILE_NAME,
  openSqliteLogBackend,
  type Fact,
  type LogBackendOptions,
} from "../src/index.ts";
import { runLogConformance, type LogConformanceFactory } from "./log-conformance.ts";

const TEST_ROOT = resolve(import.meta.dir, "..", "..", "..", ".radian", "test-tmp");
const CHILD = join(import.meta.dir, "fixtures", "log-child.ts");
const HOLD_CHILD = join(import.meta.dir, "fixtures", "sqlite-hold.ts");
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

interface LineStream {
  next(): Promise<string | null>;
}

function lineStream(stream: ReadableStream<Uint8Array>): LineStream {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  return {
    async next(): Promise<string | null> {
      while (true) {
        const newline = pending.indexOf("\n");
        if (newline >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          return line;
        }
        const { value, done } = await reader.read();
        if (done) return pending.length === 0 ? null : pending;
        pending += decoder.decode(value, { stream: true });
      }
    },
  };
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolveTimeout, rejectTimeout) => {
    const timer = setTimeout(() => rejectTimeout(new Error(message)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveTimeout(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectTimeout(error);
      },
    );
  });
}

async function nextJson(lines: LineStream, message: string): Promise<unknown> {
  const line = await withTimeout(lines.next(), 15_000, message);
  if (line === null) throw new Error(message);
  return JSON.parse(line) as unknown;
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
      INSERT INTO schema_version (id, version) VALUES (1, 1);
    `);
  } finally {
    legacy.close();
  }

  const backend = await open(directory);
  try {
    const run = await backend.startRun("flow", "object");
    const global = await backend.recordInput(null, "cron", "tick:1", {});
    expect(global.duplicate).toBe(false);
    const scoped = await backend.recordInput(run.runId, "github", "issue:1", {});
    expect(scoped.duplicate).toBe(false);
    await backend.appendGlobal({
      kind: "trigger_observed",
      payload: { reason: "would start one on object" },
      cause: global.inputId,
    });
  } finally {
    await backend.close();
  }

  const columns = withDatabase(directory, (database) =>
    database
      .query<{ name: string; notnull: number }, []>("PRAGMA table_info(inputs)")
      .all(),
  );
  expect(columns.find((column) => column.name === "run_id")?.notnull).toBe(0);
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

test("opening waits while another process holds the store", async () => {
  const directory = tracked("open-wait");
  const holder = Bun.spawn([process.execPath, HOLD_CHILD], {
    cwd: TEST_ROOT,
    env: { ...process.env, OPERAD_DB_PATH: dbPath(directory), OPERAD_HOLD_MS: "100" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const holderLines = lineStream(holder.stdout);

  try {
    expect(await nextJson(holderLines, "the holder did not take the lock")).toEqual({ locked: true });

    // The holder keeps the lock for a moment. Open has to wait for it through
    // the busy handler; an open that gave up on SQLITE_BUSY would fail here.
    const backend = await openSqliteLogBackend(dbPath(directory));
    await backend.close();

    expect(await nextJson(holderLines, "the holder did not commit")).toEqual({ committed: true });
  } finally {
    if (holder.exitCode === null) holder.kill();
    await holder.exited;
  }
});
