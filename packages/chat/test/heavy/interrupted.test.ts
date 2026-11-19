import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PluginRegistry,
  Runner,
  SqlitePluginStore,
  openLog,
  parseObjectKey,
  readState,
  type LogBackend,
  type TriggerEvent,
} from "@operad-io/engine";
import {
  allEntries,
  allMessages,
  chatRef,
  chatViews,
  createChat,
  createChatPlugin,
  INTERRUPTED_NOTE,
  MESSAGE_FACT,
  newMessageId,
} from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../../../engine/test/plugin/support.ts";
import { fakeHarness, reply, type Call } from "../support.ts";

afterAll(cleanupTempRoots);

const childPath = fileURLToPath(new URL("../fixtures/crash-reply-child.ts", import.meta.url));

async function message(store: SqlitePluginStore, chat: string, text: string): Promise<string> {
  const id = newMessageId();
  await store.append({
    type: MESSAGE_FACT,
    object: chatRef(chat),
    cause: "test",
    data: {
      id,
      role: "user",
      from: { via: "cli", id: "tester" },
      text,
      attachments: [],
      source: { kind: "cli", ref: null },
    },
  });
  return id;
}

async function transcript(store: SqlitePluginStore, chat: string, root: string): Promise<string> {
  const object = await store.get("chat", chat);
  if (object === undefined) throw new Error("no chat");
  return (
    await chatViews.load(
      {
        plugin: "chat",
        home: join(root, "home"),
        cwd: root,
        store,
        settings: {},
      } as never,
      object,
      "transcript",
      {},
    )
  ).markdown;
}

async function run(
  registry: PluginRegistry,
  log: LogBackend,
  runId: string,
  chat: string,
  storeRoot: string,
  recover = false,
): Promise<string> {
  const found = registry.flow("chat:reply");
  if (found === undefined) throw new Error("no chat flow");
  const object = { type: "chat", id: chat };
  const outcome = await new Runner({
    log,
    flow: found.flow,
    runId,
    registry,
    lockRoot: storeRoot,
    recover,
    object,
  }).run();
  return outcome;
}

describe("a reply interrupted by a crash or restart", () => {
  test("keeps the items it finished and a stopped line, and /retry continues the chat", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const storeRoot = join(root, "store");
    mkdirSync(home, { recursive: true });
    const store = new SqlitePluginStore({ root: storeRoot });
    const chat = await createChat(store, { harness: "fake", cwd: root, title: "Chat" }, "test");
    await message(store, chat, "the question");

    const opened = openLog({ backend: "sqlite", path: join(storeRoot, "log.sqlite") });
    const info = await opened.startRun("chat:reply", `chat:${chat}`);
    await opened.close();

    const child = Bun.spawn({
      cmd: [process.execPath, childPath, home, storeRoot, info.runId],
      cwd: root,
      env: { ...process.env, OPERAD_HOME: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    const code = await child.exited;
    expect(stderr).toBe("");
    expect(stdout).toContain("ready");
    expect(code).not.toBe(0);

    const log = openLog({ backend: "sqlite", path: join(storeRoot, "log.sqlite") });
    const events: TriggerEvent[] = [];
    const calls: Call[] = [];
    const registry = new PluginRegistry(
      [createChatPlugin(), fakeHarness("fake", () => reply("after the restart", "s-2"), calls)],
      {
        home,
        cwd: root,
        store,
        onLog: () => undefined,
        onEvent: (event) => {
          events.push(event);
        },
      },
    );
    const object = (await store.get("chat", chat));
    if (object === undefined) throw new Error("no chat");

    try {
      expect(await run(registry, log, info.runId, chat, storeRoot, true)).toBe("ended");
      const state = await readState(log, info.runId);
      expect(state.status).toBe("ended");
      expect(state.endedStatus).toBe("cancelled");

      const entries = allEntries(store, chat);
      expect(entries.map((entry) => entry.kind)).toEqual([
        "thinking",
        "text",
        "tool",
        "stopped",
        "stopped",
      ]);
      expect(entries[0]).toMatchObject({ runId: info.runId, kind: "thinking", text: "weighed it" });
      expect(entries[1]).toMatchObject({ runId: info.runId, kind: "text", text: "I looked." });
      expect(entries[2]).toMatchObject({
        runId: info.runId,
        kind: "tool",
        callId: "t1",
        toolName: "Bash",
        input: "ls",
        result: "done",
        startedAt: 3_000,
        durationMs: 12,
      });
      expect(entries[3]).toMatchObject({ runId: info.runId, kind: "stopped", text: "Half a thought" });
      expect(entries[4]).toMatchObject({
        runId: info.runId,
        kind: "stopped",
        text: INTERRUPTED_NOTE,
        interrupted: true,
      });
      expect(allMessages(store, chat).filter((item) => item.role === "assistant")).toEqual([]);
      const asked = allMessages(store, chat).filter((item) => item.role === "user");
      expect(asked.map((item) => item.text)).toEqual(["the question", "the second question"]);
      const shown = await transcript(store, chat, root);
      expect(shown).toContain("> weighed it");
      expect(shown).toContain("I looked.");
      expect(shown).toContain("tool Bash <1s `ls`");
      expect(shown).toContain("Half a thought");
      expect(shown).toContain("*stopped*");
      expect(shown).toContain(INTERRUPTED_NOTE);

      const retried = await registry.runAction(
        "chat/send",
        { note: "/retry" },
        { object, actor: { via: "cli", id: "me" } },
      );
      expect(retried.value).toBe("retrying the last message");
      expect(events.map((event) => event.key)).toEqual([`retry:${info.runId}`]);

      const next = await log.startRun("chat:reply", `chat:${chat}`);
      expect(await run(registry, log, next.runId, chat, storeRoot)).toBe("ended");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.params.prompt).toContain("the question");
      expect(calls[0]?.params.prompt).toContain("the second question");
      const answers = allMessages(store, chat).filter((item) => item.role === "assistant");
      expect(answers.map((item) => item.text)).toEqual(["after the restart"]);
      expect(answers[0]?.replyTo).toEqual(asked.map((item) => item.id));
      // What the interrupted attempt kept stays beside the answer that follows it.
      expect(allEntries(store, chat).map((entry) => entry.kind)).toEqual([
        "thinking",
        "text",
        "tool",
        "stopped",
        "stopped",
      ]);
    } finally {
      await log.close();
    }
  });
});
