import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { SqlitePluginStore } from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

describe("declaring an object type", () => {
  test("a declaration the store already holds takes no write lock", async () => {
    const root = join(await tempRoot(), "plugins");
    const first = new SqlitePluginStore({ root, follow: false });
    first.declare("task", ["state", "plan"]);
    first.close();

    // Another process (a running serve) holds the write lock.
    const holder = new Database(join(root, "plugins.sqlite"));
    holder.run("BEGIN IMMEDIATE");
    try {
      const reader = new SqlitePluginStore({ root, follow: false });
      // Every command that loads plugins declares again. It reads, finds the
      // same declaration, and returns at once instead of waiting out the busy
      // timeout and failing with "database is locked".
      const started = Date.now();
      reader.declare("task", ["plan", "state"]);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(reader.list("task").objects).toEqual([]);
      reader.close();
    } finally {
      holder.run("ROLLBACK");
      holder.close();
    }
  });

  test("a changed declaration replaces the index fields", async () => {
    const root = join(await tempRoot(), "plugins");
    const store = new SqlitePluginStore({ root, follow: false });
    store.declare("task", ["state"]);
    store.declare("task", ["plan", "state"]);
    store.put("task", "a", { plan: "p", state: "s" }, "test");
    expect(store.list("task", { where: { plan: "p" } }).objects).toHaveLength(1);
    store.declare("task", ["state"]);
    expect(() => store.list("task", { where: { plan: "p" } })).toThrow();
    store.close();
  });
});
