import { afterAll, describe, expect, test } from "bun:test";
import { definePlugin, type PluginStore } from "@operad-io/engine";
import { cleanup, memoryStore, testWorld } from "@operad-io/engine/testing";
import {
  allMessages,
  chatRef,
  createChat,
  createChatPlugin,
  MESSAGE_FACT,
  newMessageId,
  REPLY_MAX_VISITS,
  unanswered,
} from "../../src/index.ts";

afterAll(cleanup);

async function say(store: PluginStore, chat: string, text: string): Promise<void> {
  await store.append({
    type: MESSAGE_FACT,
    object: chatRef(chat),
    cause: "test",
    data: {
      id: newMessageId(),
      role: "user",
      from: { via: "cli", id: "t" },
      text,
      attachments: [],
      source: { kind: "cli", ref: null },
    },
  });
}

/**
 * The chat plugin with a fake harness inside it, so the flow runs whole in one
 * plugin: the reply step declares the fake `agent` step it calls.
 */
function withAgent(onCall: (call: number) => Promise<void> | void) {
  const chat = createChatPlugin();
  let calls = 0;
  const plugin = definePlugin({
    name: "chat",
    kind: "domain",
    version: "0.0.0",
    objects: chat.objects ?? [],
    steps: [
      ...(chat.steps ?? []).map((step) => ({ ...step, calls: ["chat/agent"] })),
      {
        name: "agent",
        resumable: true,
        results: ["done", "failed", "interrupted", "waiting"],
        async run() {
          calls += 1;
          await onCall(calls);
          return { result: "done", data: { finalMessage: `reply ${calls}`, sessionId: "s" } };
        },
      },
    ],
    flows: chat.flows ?? [],
    rules: chat.rules ?? [],
    actions: chat.actions ?? [],
    views: chat.views ?? {},
  });
  return { plugin, calls: () => calls };
}

describe("the reply flow", () => {
  test("a message event from ios starts chat:reply by the plugin's own rule, and the run answers it", async () => {
    const store = memoryStore();
    const { plugin } = withAgent(() => undefined);
    const chat = await createChat(store, { harness: "chat", cwd: "/tmp", title: "t" }, "test");
    await say(store, chat, "hello");
    const world = await testWorld(plugin, { inProcess: true, store });
    const sent = await world.emit("ios", "message", undefined, { key: "m-1", object: `chat:${chat}` });
    expect(sent.started).toBe(true);
    expect(sent.run?.flow).toBe("chat:reply");
    expect(sent.run?.end).toBe("done");
    expect(unanswered(allMessages(store, chat))).toEqual([]);
    for (const source of ["telegram", "cli"]) {
      const again = await world.emit(source, "message", undefined, { key: `m-${source}`, object: `chat:${chat}` });
      expect(again.result.flow).toBe("chat:reply");
    }
  });

  test("messages that arrive during a reply are answered by the next round of the same run", async () => {
    const store = memoryStore();
    const { plugin, calls } = withAgent(async (call) => {
      if (call === 1) await say(store, chat, "second");
    });
    const chat = await createChat(store, { harness: "chat", cwd: "/tmp", title: "t" }, "test");
    await say(store, chat, "first");
    const world = await testWorld(plugin, { inProcess: true, store });
    const sent = await world.emit("cli", "message", undefined, { key: "m-1", object: `chat:${chat}` });
    expect(sent.run?.end).toBe("done");
    expect(calls()).toBe(2);
    expect(unanswered(allMessages(store, chat))).toEqual([]);
  });

  test("maxVisits stops a loop that never catches up", async () => {
    const store = memoryStore();
    const { plugin, calls } = withAgent(() => say(store, chat, "again"));
    const chat = await createChat(store, { harness: "chat", cwd: "/tmp", title: "t" }, "test");
    await say(store, chat, "first");
    const world = await testWorld(plugin, { inProcess: true, store });
    const sent = await world.emit("cli", "message", undefined, { key: "m-1", object: `chat:${chat}` });
    expect(sent.run?.end).toBe("failed");
    expect(calls()).toBe(REPLY_MAX_VISITS);
    expect(sent.run?.history.join("\n")).toContain("visit");
  });
});
