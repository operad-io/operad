import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CursorError,
  type ListOptions,
  openPluginStore,
  SqlitePluginStore,
  WhereError,
  type PluginStore,
  type PluginStoreBackend,
} from "../../src/index.ts";
import { waitForFile } from "../wait-for-file.ts";
import { cleanupTempRoots, tempRoot } from "./support.ts";

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
    expect(exits).toEqual([0, 0]);

    const store = new SqlitePluginStore({ root });
    const sequences = store
      .facts()
      .map((fact) => fact.sequence)
      .sort((left, right) => left - right);
    expect(sequences).toEqual(
      Array.from({ length: perWriter * 2 }, (_value, index) => index + 1),
    );
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
