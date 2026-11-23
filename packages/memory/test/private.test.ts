import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryPluginStore } from "@operad-io/engine";
import { chatMessages } from "../src/search/sources.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function say(store: MemoryPluginStore, id: string, role: "user" | "assistant", text: string, extra: Record<string, unknown> = {}): void {
  store.append({
    type: "chat.message",
    object: { type: "chat", id: "c1" },
    cause: "test",
    data: { id, role, text, from: { via: "cli", id: "p" }, attachments: [], source: { kind: "cli", ref: null }, ...extra },
  });
}

test("messages of a stretch that is not remembered stay out of what the full-text index reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-private-"));
  roots.push(root);
  const store = new MemoryPluginStore({ root: join(root, "plugins") });
  await store.put("chat", "c1", { title: "t", cwd: root }, "test");
  say(store, "m1", "user", "before");
  say(store, "m2", "user", "secret plan", { private: true });
  say(store, "m3", "assistant", "secret answer", { private: true });
  say(store, "m4", "user", "after");
  expect(chatMessages(store, "c1").map((message) => message.text)).toEqual(["before", "after"]);
});
