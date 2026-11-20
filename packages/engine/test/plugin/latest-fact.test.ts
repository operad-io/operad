import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MemoryPluginStore, SqlitePluginStore, type PluginStore } from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

const chat = { type: "chat", id: "C-1" } as const;

function appendMessage(store: PluginStore): void {
  store.append({
    type: "chat.message",
    object: chat,
    cause: "test",
    data: { id: "m-1", role: "user", text: "hello" },
  });
}

function check(store: PluginStore): void {
  expect(store.latestFactSequence?.(chat)).toBe(0);
  store.put(chat.type, chat.id, { title: "Test" }, "test");
  expect(store.latestFactSequence?.(chat)).toBe(1);
  appendMessage(store);
  expect(store.latestFactSequence?.(chat)).toBe(2);
}

describe("the latest fact sequence of an object", () => {
  test("the in-memory store follows the object from no facts to two", () => {
    const store = new MemoryPluginStore({ root: "unused" });
    check(store);
  });

  test("the SQLite store follows the object from no facts to two", async () => {
    const root = await tempRoot();
    const store = new SqlitePluginStore({ root: join(root, "store") });
    try {
      check(store);
    } finally {
      store.close();
    }
  });
});
