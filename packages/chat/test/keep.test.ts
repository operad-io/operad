import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryPluginStore, PluginRegistry } from "@operad-io/engine";
import { readKeptWorkers, stopAllKeptWorkers } from "@operad-io/engine/platform";
import { createPiHarnessPlugin } from "@operad-io/harness-pi";
import {
  allEntries,
  allMessages,
  chatRef,
  createChat,
  createChatPlugin,
  MESSAGE_FACT,
  newMessageId,
} from "../src/index.ts";

const FAKE = fileURLToPath(new URL("../../harness/pi/test/fake-kept-worker.ts", import.meta.url));
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots.splice(0)) {
    await stopAllKeptWorkers({ home: root }).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitGone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

test("a killed kept worker gives the next chat message a normal reply", async () => {
  const home = mkdtempSync(join(tmpdir(), "ck-"));
  roots.push(home);
  const work = join(home, "work");
  mkdirSync(work, { recursive: true });
  process.env["FAKE_KEEP_RECORD"] = join(home, "inputs.jsonl");
  const store = new MemoryPluginStore({ root: join(home, "store") });
  const registry = new PluginRegistry(
    [
      createChatPlugin(),
      createPiHarnessPlugin({
        command: process.execPath,
        args: [FAKE],
        keepMs: 60_000,
      }),
    ],
    { home, cwd: work, store, onLog: () => undefined },
  );
  const chat = await createChat(store, { harness: "pi", cwd: work, title: "Kept" }, "test");
  const say = async (text: string): Promise<void> => {
    await store.append({
      type: MESSAGE_FACT,
      object: chatRef(chat),
      cause: "test",
      data: {
        id: newMessageId(),
        role: "user",
        from: { via: "cli", id: "tester" },
        text,
        attachments: [],
        source: { kind: "cli", ref: null },
      },
    });
  };
  const round = async (runId: string) => {
    const object = await store.get("chat", chat);
    if (object === undefined) throw new Error("no chat");
    return registry.runStep("chat/reply", {}, {
      runId,
      object: { type: "chat", id: chat, data: object.data },
      params: null,
      signal: new AbortController().signal,
    });
  };

  await say("first");
  expect((await round("run-1")).result).toBe("done");
  const [kept] = readKeptWorkers(home, "pi");
  expect(kept).toBeDefined();
  const pid = kept?.pid ?? 0;
  process.kill(pid, "SIGKILL");
  expect(await waitGone(pid)).toBe(true);

  await say("second");
  const second = await round("run-2");
  expect(second.result).toBe("done");
  const messages = allMessages(store, chat);
  expect(messages.filter((message) => message.role === "assistant").map((message) => message.text)).toEqual([
    "fake final message",
    "fake final message",
  ]);
  expect(allEntries(store, chat).some((entry) => entry.kind === "failure")).toBe(false);
  expect(readKeptWorkers(home, "pi")).toHaveLength(1);
  expect(existsSync(join(home, "inputs.jsonl"))).toBe(true);
  await stopAllKeptWorkers({ home });
});

test("closing a chat ends its kept worker", async () => {
  const home = mkdtempSync(join(tmpdir(), "ck-"));
  roots.push(home);
  const work = join(home, "work");
  mkdirSync(work, { recursive: true });
  process.env["FAKE_KEEP_RECORD"] = join(home, "inputs.jsonl");
  const store = new MemoryPluginStore({ root: join(home, "store") });
  const registry = new PluginRegistry(
    [
      createChatPlugin(),
      createPiHarnessPlugin({ command: process.execPath, args: [FAKE], keepMs: 60_000 }),
    ],
    { home, cwd: work, store, onLog: () => undefined },
  );
  const chat = await createChat(store, { harness: "pi", cwd: work, title: "Kept" }, "test");
  await store.append({
    type: MESSAGE_FACT,
    object: chatRef(chat),
    cause: "test",
    data: {
      id: newMessageId(),
      role: "user",
      from: { via: "cli", id: "tester" },
      text: "first",
      attachments: [],
      source: { kind: "cli", ref: null },
    },
  });
  const object = await store.get("chat", chat);
  if (object === undefined) throw new Error("no chat");
  expect((await registry.runStep("chat/reply", {}, {
    runId: "run-1",
    object: { type: "chat", id: chat, data: object.data },
    params: null,
    signal: new AbortController().signal,
  })).result).toBe("done");
  const pid = readKeptWorkers(home, "pi")[0]?.pid ?? 0;
  expect(pid).toBeGreaterThan(1);

  await registry.runAction("chat/close", {}, {
    object: { type: "chat", id: chat, data: object.data },
    actor: { via: "cli", id: "me" },
  });
  expect(await waitGone(pid)).toBe(true);
  expect(readKeptWorkers(home, "pi")).toEqual([]);
});
