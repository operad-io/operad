import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUSY_TIMEOUT_MS } from "../../src/platform/index.ts";
import { SqlitePluginStore } from "../../src/plugin/sqlite-store.ts";

const LSOF = Bun.which("lsof");
const PROC_FDS = "/proc/self/fd";
const CAN_LIST_FILES = LSOF !== null || existsSync(PROC_FDS);
const HOLD_CHILD = join(import.meta.dir, "..", "fixtures", "sqlite-hold.ts");
const PUT_CHILD = join(import.meta.dir, "..", "fixtures", "plugin-store-put.ts");
const directories: string[] = [];

afterAll(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "operad-plugin-store-"));
  directories.push(directory);
  return join(directory, "plugins.sqlite");
}

function journalMode(file: string): string | undefined {
  const database = new Database(file);
  try {
    return database
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
      .get()?.journal_mode;
  } finally {
    database.close();
  }
}

/** Reads JSON lines from a child's stdout one at a time. */
function lines(stream: ReadableStream<Uint8Array>): () => Promise<unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  return async () => {
    for (;;) {
      const newline = text.indexOf("\n");
      if (newline >= 0) {
        const line = text.slice(0, newline);
        text = text.slice(newline + 1);
        return JSON.parse(line);
      }
      const { value, done } = await reader.read();
      if (value !== undefined) text += decoder.decode(value, { stream: true });
      if (done && text.indexOf("\n") < 0) throw new Error("the child ended early");
    }
  };
}

/** The files this process has open, when the system can list them. */
function openFiles(): string[] {
  if (existsSync(PROC_FDS)) {
    const paths: string[] = [];
    for (const fd of readdirSync(PROC_FDS)) {
      try {
        paths.push(readlinkSync(join(PROC_FDS, fd)));
      } catch {
        // The descriptor closed while the directory was being listed.
      }
    }
    return paths;
  }
  if (LSOF === null) return [];
  const result = Bun.spawnSync({
    cmd: [LSOF, "-p", String(process.pid), "-Fn"],
    stdout: "pipe",
    stderr: "ignore",
  });
  return result.stdout
    .toString()
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));
}

test.skipIf(!CAN_LIST_FILES)("closing a store closes its connection at once, not at a later collection", () => {
  const file = tempFile();
  const store = new SqlitePluginStore({ root: join(file, ".."), file });
  expect(openFiles().some((path) => path.includes("/plugins.sqlite"))).toBe(true);
  store.close();
  // Bun keeps the file handles of a closed database open while a statement made
  // from it is not finalized, so a statement left behind shows as an open file.
  expect(openFiles().filter((path) => path.includes("/plugins.sqlite"))).toEqual([]);
});

test("a store created in delete mode is WAL after it is opened", () => {
  const file = tempFile();
  const old = new Database(file);
  old.run("CREATE TABLE seed (x)");
  expect(old.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
  old.close();

  const store = new SqlitePluginStore({ root: join(file, ".."), file });
  store.close();
  expect(journalMode(file)).toBe("wal");
});

test("the store's own connection has the platform busy timeout and WAL", () => {
  // bun:sqlite gives no event for "the busy handler is waiting", so the wait
  // cannot be proved from outside; the settings on the connection that does
  // the work are what make it wait, and the test below is the end-to-end check.
  const file = tempFile();
  const store = new SqlitePluginStore({ root: join(file, ".."), file });
  try {
    const connection = store["db"];
    expect(connection.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(
      BUSY_TIMEOUT_MS,
    );
    expect(
      connection.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
    ).toBe("wal");
  } finally {
    store.close();
  }
});

test("a write waits for another process's write transaction and succeeds after it commits", async () => {
  const file = tempFile();
  new SqlitePluginStore({ root: join(file, ".."), file }).close();
  const env = { ...process.env, OPERAD_DB_PATH: file };
  const holder = Bun.spawn([process.execPath, HOLD_CHILD], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const holderLines = lines(holder.stdout);
    expect(await holderLines()).toEqual({ locked: true });
    const writer = Bun.spawn([process.execPath, PUT_CHILD], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const writerLines = lines(writer.stdout);
      expect(await writerLines()).toEqual({ writing: true });
      // The holder still holds its lock, so the writer cannot have finished.
      expect(writer.exitCode).toBeNull();
      holder.stdin.write("release\n");
      await holder.stdin.end();
      expect(await writerLines()).toEqual({ written: true });
      expect(await writer.exited).toBe(0);
    } finally {
      if (writer.exitCode === null) writer.kill();
      await writer.exited;
    }
  } finally {
    if (holder.exitCode === null) holder.kill();
    await holder.exited;
  }
  const store = new SqlitePluginStore({ root: join(file, ".."), file });
  expect(store.get("note", "one")?.data).toEqual({ text: "hello" });
  store.close();
});

test("a poll whose database is removed while it queries does nothing", () => {
  const file = tempFile();
  const store = new SqlitePluginStore({ root: join(file, ".."), file });
  try {
    const real = store["db"];
    const vanishing = new Proxy(real, {
      get(target, property, receiver) {
        if (property === "query") {
          return () => {
            rmSync(file, { force: true });
            throw Object.assign(new Error("disk I/O error"), {
              code: "SQLITE_IOERR",
            });
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    (store as unknown as { db: Database }).db = vanishing;
    expect(() => (store as unknown as { pollFacts(): void }).pollFacts()).not.toThrow();
  } finally {
    store.close();
  }
});

test("a poll stops when the store's directory is removed, so its timer does not outlive it", () => {
  const file = tempFile();
  let tick: (() => void) | undefined;
  let stopped = false;
  const store = new SqlitePluginStore({
    root: join(file, ".."),
    file,
    repeat: (_ms, callback) => {
      tick = callback;
      return () => {
        stopped = true;
      };
    },
  });
  try {
    store.subscribe(() => undefined);
    if (tick === undefined) throw new Error("the poll did not start");
    const poll = tick;
    rmSync(join(file, ".."), { recursive: true, force: true });
    expect(() => poll()).not.toThrow();
    expect(stopped).toBe(true);
  } finally {
    store.close();
  }
});

test("a poll stops when the store's -wal and -shm are removed", () => {
  const file = tempFile();
  let tick: (() => void) | undefined;
  let stopped = false;
  const store = new SqlitePluginStore({
    root: join(file, ".."),
    file,
    repeat: (_ms, callback) => {
      tick = callback;
      return () => {
        stopped = true;
      };
    },
  });
  const real = store["db"];
  try {
    store.subscribe(() => undefined);
    if (tick === undefined) throw new Error("the poll did not start");
    const poll = tick;
    rmSync(`${file}-wal`, { force: true });
    // SQLite can still read through the open connection after one journal is
    // unlinked, so the real query succeeds and the poll keeps its timer.
    expect(() => poll()).not.toThrow();
    expect(stopped).toBe(false);
    rmSync(`${file}-shm`, { force: true });
    // A teardown that loses both journals makes the next query fail; let it
    // fail here, so the test proves the poll stops when an I/O error finds the
    // journals gone instead of waiting for SQLite to unlink them in a race.
    const vanishing = new Proxy(real, {
      get(target, property, receiver) {
        if (property === "query") {
          return () => {
            throw Object.assign(new Error("disk I/O error"), {
              code: "SQLITE_IOERR",
            });
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    (store as unknown as { db: Database }).db = vanishing;
    expect(() => poll()).not.toThrow();
    expect(stopped).toBe(true);
  } finally {
    (store as unknown as { db: Database }).db = real;
    store.close();
  }
});

test("a live store whose -wal is absent before a poll keeps delivering facts", () => {
  const file = tempFile();
  let tick: (() => void) | undefined;
  let stopped = false;
  const reader = new SqlitePluginStore({
    root: join(file, ".."),
    file,
    repeat: (_ms, callback) => {
      tick = callback;
      return () => {
        stopped = true;
      };
    },
  });
  const writer = new SqlitePluginStore({ root: join(file, ".."), file, follow: false });
  try {
    const seen: string[] = [];
    reader.subscribe((object) => seen.push(`${object.type}:${object.id}`));
    writer.put("note", "one", { text: "hello" }, "test");
    // Keep the fact in the database, so removing the -wal loses no write.
    writer["db"].run("PRAGMA wal_checkpoint(TRUNCATE)");
    rmSync(`${file}-wal`, { force: true });
    if (tick === undefined) throw new Error("the poll did not start");
    const poll = tick;
    expect(() => poll()).not.toThrow();
    expect(stopped).toBe(false);
    expect(seen).toEqual(["note:one"]);
  } finally {
    writer.close();
    reader.close();
  }
});

test("a poll reports an I/O error from a store that is still there", () => {
  const file = tempFile();
  let tick: (() => void) | undefined;
  let stopped = false;
  const store = new SqlitePluginStore({
    root: join(file, ".."),
    file,
    repeat: (_ms, callback) => {
      tick = callback;
      return () => {
        stopped = true;
      };
    },
  });
  const real = store["db"];
  try {
    store.subscribe(() => undefined);
    if (tick === undefined) throw new Error("the poll did not start");
    const poll = tick;
    const broken = new Proxy(real, {
      get(target, property, receiver) {
        if (property === "query") {
          return () => {
            throw Object.assign(new Error("disk I/O error"), {
              code: "SQLITE_IOERR",
            });
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    (store as unknown as { db: Database }).db = broken;
    expect(() => poll()).toThrow("disk I/O error");
    expect(stopped).toBe(false);
  } finally {
    (store as unknown as { db: Database }).db = real;
    store.close();
  }
});

test("a poll that meets a busy store skips its turn instead of throwing", () => {
  const file = tempFile();
  const store = new SqlitePluginStore({ root: join(file, ".."), file });
  try {
    const real = store["db"];
    const busy = new Proxy(real, {
      get(target, property, receiver) {
        if (property === "query") {
          return () => {
            throw Object.assign(new Error("database is locked"), {
              code: "SQLITE_BUSY",
            });
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    (store as unknown as { db: Database }).db = busy;
    expect(() => (store as unknown as { pollFacts(): void }).pollFacts()).not.toThrow();

    (store as unknown as { db: Database }).db = real;
    store.put("note", "one", { text: "hello" }, "test");
    expect(() => (store as unknown as { pollFacts(): void }).pollFacts()).not.toThrow();
  } finally {
    store.close();
  }
});
