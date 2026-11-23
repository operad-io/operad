import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryPluginStore } from "../../src/plugin/store.ts";
import { SqlitePluginStore } from "../../src/plugin/sqlite-store.ts";
import type { PluginStore } from "../../src/plugin/types.ts";

function check(name: string, make: () => { store: PluginStore; done: () => void }): void {
  describe(`${name} remove`, () => {
    test("removes the object and its index entries but keeps the facts; a missing object is a no-op", async () => {
      const { store, done } = make();
      try {
        store.declare?.("note", ["kind"]);
        await store.put("note", "a", { kind: "x" }, "test");
        await store.put("note", "b", { kind: "x" }, "test");
        expect((await store.list("note", { where: { kind: "x" } })).objects.map((o) => o.id)).toEqual(["a", "b"]);
        const before = store.facts({ type: "note", id: "a" }).facts.length;
        await store.remove("note", "a");
        expect(await store.get("note", "a")).toBeUndefined();
        expect((await store.list("note", { where: { kind: "x" } })).objects.map((o) => o.id)).toEqual(["b"]);
        expect((await store.list("note")).objects.map((o) => o.id)).toEqual(["b"]);
        expect(store.facts({ type: "note", id: "a" }).facts.length).toBe(before);
        await store.remove("note", "a");
        await store.remove("note", "never");
        expect(await store.get("note", "b")).toBeDefined();
      } finally {
        done();
      }
    });
  });
}

check("memory store", () => ({ store: new MemoryPluginStore({ root: "/tmp" }), done: () => undefined }));
check("sqlite store", () => {
  const root = mkdtempSync(join(tmpdir(), "store-remove-"));
  const store = new SqlitePluginStore({ root });
  return { store, done: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
});
