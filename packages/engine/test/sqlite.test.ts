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
