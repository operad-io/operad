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

async function crash(
  root: string,
  home: string,
  storeRoot: string,
  runId: string,
  mode?: string,
): Promise<void> {
  const child = Bun.spawn({
    cmd: [process.execPath, childPath, home, storeRoot, runId, ...(mode === undefined ? [] : [mode])],
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

    await crash(root, home, storeRoot, info.runId);

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
      expect(shown).toContain(`\n${INTERRUPTED_NOTE}`);
      expect(shown).not.toContain(`**Operad Bot:** ${INTERRUPTED_NOTE}`);

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

  test("keeps the second round when an earlier round already recorded a reply", async () => {
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
    await crash(root, home, storeRoot, info.runId, "second-round");

    const log = openLog({ backend: "sqlite", path: join(storeRoot, "log.sqlite") });
    const registry = new PluginRegistry(
      [createChatPlugin(), fakeHarness("fake", () => reply("after the restart", "s-3"), [])],
      { home, cwd: root, store, onLog: () => undefined },
    );
    try {
      expect(await run(registry, log, info.runId, chat, storeRoot, true)).toBe("ended");
      const entries = allEntries(store, chat);
      expect(entries.map((entry) => entry.kind)).toEqual([
        "thinking",
        "text",
        "thinking",
        "text",
        "tool",
        "stopped",
        "stopped",
      ]);
      expect(entries[0]).toMatchObject({ kind: "thinking", text: "first thought" });
      expect(entries[1]).toMatchObject({ kind: "text", text: "first words" });
      expect(entries[2]).toMatchObject({ kind: "thinking", text: "second thought" });
      expect(entries[3]).toMatchObject({ kind: "text", text: "second words" });
      expect(entries[4]).toMatchObject({ kind: "tool", callId: "t2", input: "second.ts" });
      expect(entries[5]).toMatchObject({ kind: "stopped", text: "Half a second thought" });
      expect(entries[6]).toMatchObject({ kind: "stopped", text: INTERRUPTED_NOTE, interrupted: true });
      const users = allMessages(store, chat).filter((item) => item.role === "user");
      expect(users.map((item) => item.text)).toEqual(["the question", "the second question"]);
      expect(
        allMessages(store, chat)
          .filter((item) => item.role === "assistant")
          .map((item) => item.text),
      ).toEqual(["first answer"]);
      const shown = await transcript(store, chat, root);
      expect(shown).toContain("first thought");
      expect(shown).toContain("first words");
      expect(shown).toContain("second thought");
      expect(shown).toContain("Half a second thought");
      expect(shown).toContain(`\n${INTERRUPTED_NOTE}`);
    } finally {
      await log.close();
    }
  });

  test("a step that returns interrupted keeps its one stopped line", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const storeRoot = join(root, "store");
    mkdirSync(home, { recursive: true });
    const store = new SqlitePluginStore({ root: storeRoot });
    const chat = await createChat(store, { harness: "fake", cwd: root, title: "Chat" }, "test");
    await message(store, chat, "the question");
    const log = openLog({ backend: "sqlite", path: join(storeRoot, "log.sqlite") });
    const registry = new PluginRegistry(
      [
        createChatPlugin(),
        fakeHarness("fake", (ctx) => {
          ctx.receiver?.(JSON.stringify({ type: "text_delta", text: "Half a thought" }));
          return { result: "interrupted", data: { reason: "cancelled", message: "stopped" } };
        }, []),
      ],
      { home, cwd: root, store, onLog: () => undefined },
    );
    const info = await log.startRun("chat:reply", `chat:${chat}`);
    try {
      expect(await run(registry, log, info.runId, chat, storeRoot)).toBe("ended");
      expect((await readState(log, info.runId)).endedStatus).toBe("cancelled");
      const entries = allEntries(store, chat);
      expect(entries.map((entry) => entry.kind)).toEqual(["stopped"]);
      expect(entries[0]).toMatchObject({ kind: "stopped", text: "Half a thought" });
      expect(entries.some((entry) => entry.text === INTERRUPTED_NOTE)).toBe(false);
      const shown = await transcript(store, chat, root);
      expect(shown).toContain("Half a thought");
      expect(shown).toContain("*stopped*");
      expect(shown).not.toContain(INTERRUPTED_NOTE);
    } finally {
      await log.close();
    }
  });

  test("a reply already recorded and owing no message is not marked interrupted", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const storeRoot = join(root, "store");
    mkdirSync(home, { recursive: true });
    const store = new SqlitePluginStore({ root: storeRoot });
    const chat = await createChat(store, { harness: "fake", cwd: root, title: "Chat" }, "test");
    await message(store, chat, "the question");
    const log = openLog({ backend: "sqlite", path: join(storeRoot, "log.sqlite") });
    const registry = new PluginRegistry(
      [createChatPlugin(), fakeHarness("fake", () => reply("the answer", "s-1"), [])],
      { home, cwd: root, store, onLog: () => undefined },
    );
    const info = await log.startRun("chat:reply", `chat:${chat}`);
    try {
      expect(await run(registry, log, info.runId, chat, storeRoot)).toBe("ended");
      const object = await store.get("chat", chat);
      if (object === undefined) throw new Error("no chat");
      const kept = await registry.runStep("chat/keep", {}, {
        runId: info.runId,
        object: { type: "chat", id: chat, data: object.data },
      });
      expect(kept.result).toBe("done");
      expect(allEntries(store, chat)).toEqual([]);
      expect(await transcript(store, chat, root)).not.toContain(INTERRUPTED_NOTE);
    } finally {
      await log.close();
    }
  });
});
