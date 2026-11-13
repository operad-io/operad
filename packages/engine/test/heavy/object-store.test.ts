import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CursorError,
  foldObjectFacts,
  type ListOptions,
  MemoryPluginStore,
  OBJECT_CHANGE_FACT,
  openPluginStore,
  PLUGIN_STORE_SCHEMA_VERSION,
  SqlitePluginStore,
  WhereError,
  type PluginStore,
  type PluginStoreBackend,
} from "../../src/index.ts";
import { type ImmediateWriter, writeImmediate } from "../../src/platform/index.ts";
import { waitForFile } from "../wait-for-file.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const APPEND_CHILD = join(
  import.meta.dir,
  "..",
  "fixtures",
  "append-facts-child.ts",
);

const BACKENDS: readonly PluginStoreBackend[] = ["sqlite"];

async function open(backend: PluginStoreBackend): Promise<PluginStore> {
  const root = await tempRoot();
  return openPluginStore({ backend, root: join(root, backend) });
}

function ids(
  store: PluginStore,
  type: string,
  options: ListOptions = {},
): Promise<string[]> {
  return Promise.resolve(store.list(type, options)).then((page) =>
    page.objects.map((object) => object.id),
  );
}

describe("object list", () => {
  for (const backend of BACKENDS) {
    test(`filters on an indexed field (${backend})`, async () => {
      const store = await open(backend);
      store.declare?.("note", ["tag", "plan"]);
      store.put("note", "a", { tag: "work", plan: "P1" }, "seed");
      store.put("note", "b", { tag: "home", plan: "P1" }, "seed");
      store.put("note", "c", { tag: "work", plan: "P2" }, "seed");

      expect(await ids(store, "note", { where: { tag: "work" } })).toEqual([
        "a",
        "c",
      ]);
      expect(
        await ids(store, "note", { where: { tag: "work", plan: "P1" } }),
      ).toEqual(["a"]);
      expect(await ids(store, "note", { where: { tag: "absent" } })).toEqual([]);
    });

    test(`refuses a filter on a field that is not indexed (${backend})`, async () => {
      const store = await open(backend);
      store.declare?.("note", ["tag"]);
      store.put("note", "a", { tag: "work", title: "One" }, "seed");

      expect(() =>
        store.list("note", { where: { title: "One" } }),
      ).toThrow(WhereError);
      try {
        store.list("note", { where: { title: "One" } });
      } catch (error) {
        expect((error as Error).message).toContain('field "title"');
        expect((error as Error).message).toContain('"tag"');
      }
    });

    test(`pages 2 500 objects with limit 1000, without duplicates or gaps (${backend})`, async () => {
      const store = await open(backend);
      store.declare?.("note", ["group"]);
      const expected: string[] = [];
      for (let index = 0; index < 2_500; index += 1) {
        const id = String(index).padStart(5, "0");
        expected.push(id);
        store.put("note", id, { group: "all" }, "seed");
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await store.list("note", {
          where: { group: "all" },
          limit: 1_000,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(page.objects.length).toBeLessThanOrEqual(1_000);
        seen.push(...page.objects.map((object) => object.id));
        cursor = page.next;
        pages += 1;
      } while (cursor !== undefined);

      expect(pages).toBe(3);
      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(2_500);
    });

    test(`an indexed field change moves an object between filters (${backend})`, async () => {
      const store = await open(backend);
      store.declare?.("note", ["tag"]);
      store.put("note", "a", { tag: "work" }, "seed");
      expect(await ids(store, "note", { where: { tag: "work" } })).toEqual(["a"]);

      store.put("note", "a", { tag: "home" }, "edit");
      expect(await ids(store, "note", { where: { tag: "work" } })).toEqual([]);
      expect(await ids(store, "note", { where: { tag: "home" } })).toEqual(["a"]);
    });

    test(`refuses a cursor from another object type (${backend})`, async () => {
      const store = await open(backend);
      store.declare?.("note", ["tag"]);
      store.declare?.("task", ["tag"]);
      store.put("note", "a", { tag: "work" }, "seed");
      store.put("note", "b", { tag: "work" }, "seed");
      store.put("task", "t1", { tag: "work" }, "seed");
      store.put("task", "t2", { tag: "work" }, "seed");

      const taskPage = await store.list("task", { limit: 1 });
      const cursor = taskPage.next;
      expect(cursor).toBeDefined();
      expect(() => store.list("note", { cursor })).toThrow(CursorError);
      try {
        store.list("note", { cursor });
      } catch (error) {
        expect((error as Error).message).toContain('object type "task"');
      }
    });
  }
});

describe("store lifecycle and concurrency", () => {
  test("stops the poll timer when the last fact subscription ends", async () => {
    const root = await tempRoot();
    let stops = 0;
    const store = new SqlitePluginStore({
      root: join(root, "store"),
      repeat: () => () => {
        stops += 1;
      },
    });
    const object = { type: "note", id: "n1" } as const;

    const first = store.subscribeFacts(object, {}, () => undefined);
    const second = store.subscribeFacts(object, {}, () => undefined);
    expect(stops).toBe(0);
    first();
    expect(stops).toBe(0);
    second();
    expect(stops).toBe(1);

    const ordinary = store.subscribe(() => undefined);
    const facts = store.subscribeFacts(object, {}, () => undefined);
    ordinary();
    expect(stops).toBe(1);
    facts();
    expect(stops).toBe(2);
  });

  test("a poll after the store's directory was removed does nothing", async () => {
    const root = await tempRoot();
    let tick: () => void = () => undefined;
    const store = new SqlitePluginStore({
      root: join(root, "store"),
      repeat: (_ms, callback) => {
        tick = callback;
        return () => undefined;
      },
    });
    store.subscribe(() => undefined);
    rmSync(join(root, "store"), { recursive: true, force: true });
    expect(() => tick()).not.toThrow();
  });

  test("refuses any filter when the type declares an empty index (sqlite)", async () => {
    const store = await open("sqlite");
    store.declare?.("note", []);
    store.put("note", "a", { title: "One" }, "seed");
    expect(() => store.list("note", { where: { title: "One" } })).toThrow(WhereError);
    try {
      store.list("note", { where: { title: "One" } });
    } catch (error) {
      expect((error as Error).message).toContain("this type declares no index");
    }
  });

  test("a sqlite store opened for one-shot use starts no timer", async () => {
    let repeats = 0;
    const store = new SqlitePluginStore({
      root: join(await tempRoot(), "sqlite"),
      follow: false,
      repeat: () => {
        repeats += 1;
        return () => undefined;
      },
    });
    try {
      const stop = store.subscribe(() => undefined);
      stop();
      expect(repeats).toBe(0);
    } finally {
      store.close();
    }
  });

  test("a sqlite subscription sees a fact another connection appended", async () => {
    const root = join(await tempRoot(), "sqlite");
    const first = new SqlitePluginStore({ root });
    const second = new SqlitePluginStore({ root });
    try {
      const object = { type: "note", id: "n1" } as const;
      const seen: number[] = [];
      let resolve = (): void => undefined;
      const got = new Promise<void>((done) => {
        resolve = done;
      });
      const stop = first.subscribeFacts(object, {}, (fact) => {
        seen.push(fact.sequence);
        resolve();
      });

      second.put("note", "n1", { text: "one" }, "edit");
      await Promise.race([
        got,
        new Promise<never>((_done, reject) => {
          setTimeout(() => reject(new Error("no fact arrived")), 1_000);
        }),
      ]);
      expect(seen).toEqual([1]);
      stop();
    } finally {
      first.close();
      second.close();
    }
  });

  test("a sqlite object listener wakes for a put made by another connection", async () => {
    const root = join(await tempRoot(), "sqlite");
    const first = new SqlitePluginStore({ root });
    const second = new SqlitePluginStore({ root });
    try {
      let resolve = (): void => undefined;
      const got = new Promise<void>((done) => {
        resolve = done;
      });
      const seen: string[] = [];
      const stop = first.subscribe((object) => {
        seen.push(`${object.type}/${object.id}`);
        resolve();
      });
      second.put("note", "n1", { text: "one" }, "edit");
      await Promise.race([
        got,
        new Promise<never>((_done, reject) => {
          setTimeout(() => reject(new Error("no object change arrived")), 1_000);
        }),
      ]);
      expect(seen).toEqual(["note/n1"]);
      stop();
    } finally {
      first.close();
      second.close();
    }
  });

  test("a store with a newer schema_version is refused", async () => {
    const root = join(await tempRoot(), "sqlite");
    new SqlitePluginStore({ root, follow: false }).close();
    const database = new Database(join(root, "plugins.sqlite"));
    try {
      database.run("UPDATE schema_version SET version = ? WHERE id = 1", [
        PLUGIN_STORE_SCHEMA_VERSION + 1,
      ]);
    } finally {
      database.close();
    }
    expect(() => new SqlitePluginStore({ root, follow: false })).toThrow(/upgrade operad/);
  });

  test("a full snapshot an older process appends after the migration is rewritten on the next open", async () => {
    const root = join(await tempRoot(), "sqlite");
    const first = new SqlitePluginStore({ root, follow: false });
    first.put("note", "n1", { title: "One", brief: "long" }, "seed");
    first.close();
    const database = new Database(join(root, "plugins.sqlite"));
    try {
      database
        .query(
          "INSERT INTO facts (type, object_type, object_id, cause, at, data) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("note", "note", "n1", "old-writer", 99, JSON.stringify({ title: "Two" }));
    } finally {
      database.close();
    }
    const store = new SqlitePluginStore({ root, follow: false });
    try {
      const facts = store.facts({ type: "note", id: "n1" }, { limit: 100 }).facts;
      expect(facts.map((fact) => fact.type)).toEqual([OBJECT_CHANGE_FACT, OBJECT_CHANGE_FACT]);
      expect(facts[1]?.data).toEqual({ changed: { title: "Two" }, removed: ["brief"] });
      expect([...foldObjectFacts(facts)].map((version) => version.data)).toEqual([
        { title: "One", brief: "long" },
        { title: "Two" },
      ]);
    } finally {
      store.close();
    }
  });

  test("two writer processes assign unique, contiguous sequences", async () => {
    const root = join(await tempRoot(), "store");
    mkdirSync(root, { recursive: true });
    // Both writers writing is what this checks. A long back-to-back run can
    // hold the write lock past the store's busy timeout on a loaded filesystem.
    const perWriter = 5;
    const children = ["a", "b"].map((name) =>
      Bun.spawn([process.execPath, APPEND_CHILD, root, name, String(perWriter)], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    await Promise.all([
      waitForFile(join(root, "ready-a")),
      waitForFile(join(root, "ready-b")),
    ]);
    writeFileSync(join(root, "go"), "");
    const exits = await Promise.all(children.map((child) => child.exited));
    const errors = await Promise.all(
      children.map((child) => new Response(child.stderr).text()),
    );
    expect({ exits, errors }).toEqual({ exits: [0, 0], errors: ["", ""] });

    const store = new SqlitePluginStore({ root });
    const sequences = store
      .facts()
      .map((fact) => fact.sequence)
      .sort((left, right) => left - right);
    expect(sequences).toEqual(
      Array.from({ length: perWriter * 2 }, (_value, index) => index + 1),
    );
  });

  test("a writer waits out a busy store while another process keeps committing, and fails when none does", async () => {
    const root = join(await tempRoot(), "store");
    mkdirSync(root, { recursive: true });
    const file = join(root, "plugins.sqlite");
    const store = new SqlitePluginStore({ root, follow: false });
    try {
      // A holder that never commits: the wait ends in SQLITE_BUSY.
      const holder = new Database(file);
      holder.run("PRAGMA busy_timeout = 1");
      holder.run("BEGIN IMMEDIATE");
      const quick = new Database(file);
      quick.run("PRAGMA busy_timeout = 1");
      expect(() => writeImmediate(quick, () => undefined)).toThrow(
        /database is locked/,
      );
      holder.run("ROLLBACK");
      holder.close();
      quick.close();
    } finally {
      store.close();
    }

    // A writer whose first three attempts end in SQLITE_BUSY while another
    // connection commits each time: it keeps waiting and then writes.
    let version = 1;
    let busyLeft = 3;
    let written = 0;
    const waiting: ImmediateWriter = {
      query: () => ({ get: () => ({ data_version: version }) }),
      transaction: (work) => ({
        immediate: () => {
          if (busyLeft > 0) {
            busyLeft -= 1;
            version += 1;
            throw Object.assign(new Error("database is locked"), {
              code: "SQLITE_BUSY",
            });
          }
          return work();
        },
      }),
    };
    expect(
      writeImmediate(waiting, () => {
        written += 1;
        return "done";
      }),
    ).toBe("done");
    expect(written).toBe(1);
  });
});

describe("object facts", () => {
  for (const backend of BACKENDS) {
    test(`pages an object's facts in sequence order (${backend})`, async () => {
      const store = await open(backend);
      store.put("note", "n1", { text: "one" }, "edit");
      store.put("note", "n1", { text: "two" }, "edit");
      store.put("note", "n1", { text: "three" }, "edit");
      await store.append({
        type: "note.seen",
        object: { type: "note", id: "n1" },
        cause: "test",
        data: { by: "reader" },
      });

      const first = store.facts({ type: "note", id: "n1" }, { limit: 2 });
      expect(first.facts.map((fact) => fact.sequence)).toEqual([1, 2]);
      expect(first.next).toBeDefined();
      const second = store.facts(
        { type: "note", id: "n1" },
        { cursor: first.next, limit: 2 },
      );
      expect(second.facts.map((fact) => fact.sequence)).toEqual([3, 4]);
      expect(second.next).toBeUndefined();
      expect(second.facts.at(-1)?.type).toBe("note.seen");
    });

    test(`refuses a facts cursor from another object (${backend})`, async () => {
      const store = await open(backend);
      store.put("note", "n1", { text: "one" }, "edit");
      store.put("note", "n1", { text: "two" }, "edit");
      store.put("note", "n2", { text: "other" }, "edit");
      store.put("note", "n2", { text: "again" }, "edit");

      const page = store.facts({ type: "note", id: "n1" }, { limit: 1 });
      expect(page.next).toBeDefined();
      expect(() =>
        store.facts({ type: "note", id: "n2" }, { cursor: page.next }),
      ).toThrow(CursorError);
      try {
        store.facts({ type: "note", id: "n2" }, { cursor: page.next });
      } catch (error) {
        expect((error as Error).message).toContain('"note:n1"');
      }
    });

    test(`a subscription after a cursor gets only later facts (${backend})`, async () => {
      const store = await open(backend);
      const object = { type: "note", id: "n1" } as const;
      store.put("note", "n1", { text: "one" }, "edit");
      store.put("note", "n1", { text: "two" }, "edit");
      store.put("note", "n1", { text: "three" }, "edit");

      const page = store.facts(object, { limit: 1 });
      const cursor = page.next;
      expect(cursor).toBeDefined();

      const first: number[] = [];
      const second: number[] = [];
      const stopFirst = store.subscribeFacts?.(object, { cursor }, (fact) => {
        first.push(fact.sequence);
      });
      const stopSecond = store.subscribeFacts?.(object, { cursor }, (fact) => {
        second.push(fact.sequence);
      });
      expect(stopFirst).toBeDefined();
      expect(stopSecond).toBeDefined();

      // Replaying after the cursor skips fact 1 and keeps 2 and 3.
      expect(first).toEqual([2, 3]);
      expect(second).toEqual([2, 3]);

      store.put("note", "n1", { text: "four" }, "edit");
      expect(first).toEqual([2, 3, 4]);
      expect(second).toEqual([2, 3, 4]);

      stopFirst?.();
      store.put("note", "n1", { text: "five" }, "edit");
      expect(first).toEqual([2, 3, 4]);
      expect(second).toEqual([2, 3, 4, 5]);
      stopSecond?.();
    });
  }
});


describe("object facts hold changes", () => {
  for (const backend of BACKENDS) {
    test(`put records only changed and removed fields (${backend})`, async () => {
      const store = await open(backend);
      store.put(
        "note",
        "n1",
        { title: "One", brief: "long", tags: ["a"], meta: { nested: true } },
        "seed",
      );
      const first = store.facts({ type: "note", id: "n1" }).facts[0];
      expect(first?.type).toBe(OBJECT_CHANGE_FACT);
      expect(first?.data).toEqual({
        changed: { title: "One", brief: "long", tags: ["a"], meta: { nested: true } },
        removed: [],
      });

      store.put(
        "note",
        "n1",
        { title: "One", brief: "short", tags: ["a"], meta: { nested: true } },
        "edit",
      );
      store.put("note", "n1", { title: "One", tags: ["a", "b"] }, "edit");
      const facts = store.facts({ type: "note", id: "n1" }).facts;
      expect(facts[1]?.data).toEqual({ changed: { brief: "short" }, removed: [] });
      expect(facts[2]?.data).toEqual({
        changed: { tags: ["a", "b"] },
        removed: ["brief", "meta"],
      });
    });

    test(`a put that changes nothing keeps an empty change fact (${backend})`, async () => {
      const store = await open(backend);
      const first = await store.put(
        "note",
        "n1",
        { title: "One", nested: { list: [1, 2] } },
        "seed",
      );
      const facts = store.facts({ type: "note", id: "n1" }).facts;
      const again = await store.put(
        "note",
        "n1",
        { nested: { list: [1, 2] }, title: "One" },
        "same",
      );
      const after = store.facts({ type: "note", id: "n1" }).facts;
      expect(after).toHaveLength(facts.length + 1);
      expect(after.at(-1)).toMatchObject({
        type: OBJECT_CHANGE_FACT,
        cause: "same",
        data: { changed: {}, removed: [] },
      });
      expect(again.version).toBe(first.version + 1);
      expect((await store.get("note", "n1"))?.data).toEqual(first.data);
    });
  }

  test("a put diffs against the version committed while it waited for the lock", async () => {
    const root = await tempRoot();
    const writer = new SqlitePluginStore({ root: join(root, "store"), follow: false });
    const other = new SqlitePluginStore({ root: join(root, "store"), follow: false });
    try {
      writer.put("note", "n1", { x: "old", y: 1 }, "seed");
      let wrote = false;
      const racing = new SqlitePluginStore({
        root: join(root, "store"),
        follow: false,
        clock: () => {
          if (!wrote) {
            wrote = true;
            other.put("note", "n1", { x: "new", y: 1 }, "other");
          }
          return 1_000;
        },
      });
      try {
        const written = racing.put("note", "n1", { x: "old", z: 2 }, "race");
        const facts = racing.facts({ type: "note", id: "n1" }, { limit: 100 }).facts;
        expect(facts.at(-1)?.data).toEqual({
          changed: { x: "old", z: 2 },
          removed: ["y"],
        });
        expect([...foldObjectFacts(facts)].at(-1)?.data).toEqual(written.data);
        expect(written.data).toEqual({ x: "old", z: 2 });
        expect(writer.get("note", "n1")?.data).toEqual(written.data);
      } finally {
        racing.close();
      }
    } finally {
      writer.close();
      other.close();
    }
  });

  test("folding gives every version and matches the object table after random puts", () => {
    const store = new MemoryPluginStore({ root: "unused" });
    let state = 0x5eed;
    const random = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const fields = ["a", "b", "c", "d"] as const;
    const values = [undefined, 0, 1, "x", "y", [1, 2], { deep: true }] as const;
    const expected: Record<string, unknown>[] = [];
    let data: Record<string, unknown> = {};
    for (let step = 0; step < 200; step += 1) {
      const field = fields[Math.floor(random() * fields.length)] ?? "a";
      const value = values[Math.floor(random() * values.length)];
      if (value === undefined) delete data[field];
      else data[field] = value;
      const written = store.put("note", "n1", { ...data }, `edit ${step}`);
      expected.push({ ...written.data });
      const facts = store.facts({ type: "note", id: "n1" }, { limit: 1_000 }).facts;
      const versions = [...foldObjectFacts(facts)].map((version) => ({ ...version.data }));
      expect(versions).toEqual(expected);
      expect(versions.at(-1) ?? {}).toEqual({ ...(store.get("note", "n1")?.data ?? {}) });
    }
  });

  test("an old full-snapshot store is migrated once, keeping facts and appended data", async () => {
    const root = await tempRoot();
    const file = join(root, "store", "plugins.sqlite");
    mkdirSync(join(root, "store"), { recursive: true });
    const objects = [
      { type: "note", id: "n1", data: { title: "Two" }, version: 3, cause: "edit", at: 50 },
    ];
    const oldFacts = [
      { sequence: 1, type: "note", object_type: "note", object_id: "n1", cause: "seed", at: 10, data: { title: "One", brief: "long", tags: ["a"] } },
      { sequence: 2, type: "note.seen", object_type: "note", object_id: "n1", cause: "reader", at: 20, data: { by: "person" } },
      { sequence: 3, type: "note", object_type: "note", object_id: "n1", cause: "edit", at: 30, data: { title: "One", tags: ["a", "b"] } },
      { sequence: 4, type: "note", object_type: "note", object_id: "n1", cause: "edit-again", at: 40, data: { title: "One", tags: ["a", "b"] } },
      { sequence: 5, type: "note", object_type: "note", object_id: "n1", cause: "edit", at: 50, data: { title: "Two" } },
    ] as const;
    const database = new Database(file);
    try {
      database.exec(`
        CREATE TABLE schema_version (
          id      INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL
        );
        INSERT INTO schema_version (id, version) VALUES (1, 1);
        CREATE TABLE objects (
          type    TEXT NOT NULL,
          id      TEXT NOT NULL,
          data    TEXT NOT NULL,
          version INTEGER NOT NULL,
          cause   TEXT NOT NULL,
          at      INTEGER NOT NULL,
          PRIMARY KEY (type, id)
        );
        CREATE TABLE facts (
          sequence    INTEGER PRIMARY KEY AUTOINCREMENT,
          type        TEXT NOT NULL,
          object_type TEXT,
          object_id   TEXT,
          cause       TEXT NOT NULL,
          at          INTEGER NOT NULL,
          data        TEXT NOT NULL
        );
        CREATE INDEX facts_by_object ON facts (object_type, object_id, sequence);
        CREATE INDEX facts_by_object_id ON facts (object_id, object_type);
        CREATE TABLE declared_index (
          type  TEXT NOT NULL,
          field TEXT NOT NULL,
          PRIMARY KEY (type, field)
        );
        CREATE TABLE declared_types (type TEXT PRIMARY KEY);
      `);
      const insertObject = database.query(
        "INSERT INTO objects (type, id, data, version, cause, at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const object of objects) {
        insertObject.run(
          object.type,
          object.id,
          JSON.stringify(object.data),
          object.version,
          object.cause,
          object.at,
        );
      }
      const insertFact = database.query(
        "INSERT INTO facts (sequence, type, object_type, object_id, cause, at, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const fact of oldFacts) {
        insertFact.run(
          fact.sequence,
          fact.type,
          fact.object_type,
          fact.object_id,
          fact.cause,
          fact.at,
          JSON.stringify(fact.data),
        );
      }
    } finally {
      database.close();
    }

    const store = new SqlitePluginStore({ root: join(root, "store"), follow: false });
    const migrated = store.facts({ type: "note", id: "n1" }, { limit: 100 }).facts;
    const versions = [...foldObjectFacts(migrated)];
    expect(versions.map((version) => version.data)).toEqual([
      { title: "One", brief: "long", tags: ["a"] },
      { title: "One", tags: ["a", "b"] },
      { title: "One", tags: ["a", "b"] },
      { title: "Two" },
    ]);
    expect(versions.map((version) => version.fact.sequence)).toEqual([1, 3, 4, 5]);
    expect(migrated.map((fact) => [fact.sequence, fact.cause, fact.at])).toEqual([
      [1, "seed", 10],
      [2, "reader", 20],
      [3, "edit", 30],
      [4, "edit-again", 40],
      [5, "edit", 50],
    ]);
    expect(migrated[0]?.type).toBe(OBJECT_CHANGE_FACT);
    expect(migrated[1]).toMatchObject({
      type: "note.seen",
      data: { by: "person" },
      cause: "reader",
      at: 20,
    });
    expect(store.get("note", "n1")?.data).toEqual({ title: "Two" });
    const version = new Database(file);
    try {
      expect(
        version
          .query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1")
          .get()?.version,
      ).toBe(PLUGIN_STORE_SCHEMA_VERSION);
    } finally {
      version.close();
    }
    store.close();

    const reopened = new SqlitePluginStore({ root: join(root, "store"), follow: false });
    try {
      expect(reopened.facts({ type: "note", id: "n1" }, { limit: 100 }).facts).toEqual(migrated);
    } finally {
      reopened.close();
    }
  });

  test("a store written before schema_version existed is treated as the snapshot version", async () => {
    const root = await tempRoot();
    const file = join(root, "store", "plugins.sqlite");
    mkdirSync(join(root, "store"), { recursive: true });
    const database = new Database(file);
    try {
      database.exec(`
        CREATE TABLE facts (
          sequence    INTEGER PRIMARY KEY AUTOINCREMENT,
          type        TEXT NOT NULL,
          object_type TEXT,
          object_id   TEXT,
          cause       TEXT NOT NULL,
          at          INTEGER NOT NULL,
          data        TEXT NOT NULL
        );
      `);
      database
        .query(
          "INSERT INTO facts (sequence, type, object_type, object_id, cause, at, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          1,
          "note",
          "note",
          "n1",
          "seed",
          10,
          JSON.stringify({ title: "One", brief: "long" }),
        );
    } finally {
      database.close();
    }
    const store = new SqlitePluginStore({ root: join(root, "store"), follow: false });
    try {
      const facts = store.facts({ type: "note", id: "n1" }, { limit: 10 }).facts;
      expect(facts[0]).toMatchObject({
        type: OBJECT_CHANGE_FACT,
        cause: "seed",
        at: 10,
        data: { changed: { title: "One", brief: "long" }, removed: [] },
      });
    } finally {
      store.close();
    }
  });
});
