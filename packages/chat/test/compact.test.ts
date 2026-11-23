import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin, type PluginStepResult } from "@operad-io/engine";
import {
  allMessages,
  CHAT_TYPE,
  chatData,
  chatRef,
  chatFacts,
  COMMAND_FACT,
  commandOfFact,
  COMPACT_AT,
  COMPACT_FLUSH,
  readChat,
  writingReply,
  type Command,
} from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;

async function send(r: Rig, chat: string, text: string) {
  const object = await r.store.get(CHAT_TYPE, chat);
  if (object === undefined) throw new Error("no chat");
  return r.registry.runAction("chat/send", { note: text }, {
    object: { type: CHAT_TYPE, id: chat, data: object.data },
    actor: { via: "cli", id: "me" },
  });
}

function lines(r: Rig, chat: string): readonly Command[] {
  return r.store
    .facts(chatRef(chat))
    .facts.map(commandOfFact)
    .filter((item): item is Command => item !== undefined);
}

function compactionOf(call: { readonly params: Record<string, unknown> } | undefined): Record<string, unknown> | undefined {
  const value = call?.params.compact;
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function refreshWithNotes(cwd: () => string) {
  return definePlugin({
    name: "settings",
    kind: "domain",
    version: "0.0.0",
    steps: [
      {
        name: "refresh",
        results: ["done", "failed"],
        run(): PluginStepResult {
          return {
            result: "done",
            data: {
              cwd: cwd(),
              access: {},
              skills: [],
              notes: [{ name: "memory/index.md", path: join(cwd(), "memory", "index.md") }],
            },
          };
        },
      },
    ],
  });
}

const COMPACTED = { reason: "threshold", before: 90_000, after: 12_000, flushed: true } as const;

describe("automatic compaction of a pi chat", () => {
  test("a pi reply asks for compaction at the share; a bot chat adds the memory flush turn, a chat without notes does not", async () => {
    const plain = await rig(() => reply("ok"), undefined, undefined, "pi");
    const plainChat = await plain.chat();
    await plain.say(plainChat, "hi");
    await plain.round(plainChat);
    expect(compactionOf(plain.calls[0])).toEqual({ at: COMPACT_AT });

    let cwd = "";
    const bot = await rig(() => reply("ok"), undefined, undefined, "pi", [refreshWithNotes(() => cwd)]);
    cwd = bot.root;
    const botChat = await bot.chat({ refresh: "settings/refresh" });
    await bot.say(botChat, "hi");
    await bot.round(botChat);
    expect(compactionOf(bot.calls[0])).toEqual({ at: COMPACT_AT, flush: COMPACT_FLUSH });
  });

  test("another agent is given no compaction input", async () => {
    const r = await rig(() => reply("ok"));
    const chat = await r.chat();
    await r.say(chat, "hi");
    await r.round(chat);
    expect(r.calls[0]?.params.compact).toBeUndefined();
  });

  test("a compacted reply leaves one short line after it, and the next message carries the notes whole again", async () => {
    let cwd = "";
    let turn = 0;
    const r = await rig(
      () => {
        turn += 1;
        return turn === 1
          ? { result: "done", data: { finalMessage: "answer", sessionId: "s-1", compacted: true, compaction: COMPACTED } }
          : reply("later", "s-1");
      },
      undefined,
      undefined,
      "pi",
      [refreshWithNotes(() => cwd)],
    );
    cwd = r.root;
    mkdirSync(join(cwd, "memory"), { recursive: true });
    writeFileSync(join(cwd, "memory", "index.md"), "INDEX\n");
    const chat = await r.chat({ refresh: "settings/refresh" });
    await r.say(chat, "one");
    await r.round(chat);

    const said = lines(r, chat);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ command: "compact (automatic)", ok: true });
    expect(said[0]?.outcome).toContain("from 90k to about 12k tokens");
    expect(said[0]?.outcome).toContain("wrote what to remember to memory");
    // The line is not a message: the agent is never given it and no reply answers it.
    expect(allMessages(r.store, chat).map((message) => message.role)).toEqual(["user", "assistant"]);

    await r.say(chat, "two");
    await r.round(chat);
    expect(String(r.calls[1]?.params.prompt)).toContain("[memory/index.md]\nINDEX\n");
  });

  test("a reply that did not compact leaves no line", async () => {
    const r = await rig(() => reply("ok"), undefined, undefined, "pi");
    const chat = await r.chat();
    await r.say(chat, "hi");
    await r.round(chat);
    expect(lines(r, chat)).toHaveLength(0);
  });
});

describe("/compact", () => {
  test("it starts a run with no prompt and no reply, says the context was compacted, and is taken once", async () => {
    const r = await rig((_ctx, call) =>
      (call.params.compact as { only?: boolean } | undefined)?.only === true
        ? { result: "done", data: { finalMessage: null, sessionId: "s-1", compacted: true, compaction: { ...COMPACTED, reason: "manual" } } }
        : reply("answer", "s-1"),
      undefined,
      undefined,
      "pi",
    );
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);

    const typed = await send(r, chat, "/compact");
    expect(typed.value).toBe("compacting the context");
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: "message", object: `chat:${chat}` });
    expect(String(r.events[0]?.key).startsWith("compact:")).toBe(true);

    const round = await r.round(chat);
    expect(round.result).toBe("done");
    expect(r.calls).toHaveLength(2);
    expect(compactionOf(r.calls[1])).toMatchObject({ at: COMPACT_AT, only: true });
    expect(r.calls[1]?.params.resumeSession).toBe("s-1");
    // No reply was written for it.
    expect(allMessages(r.store, chat).filter((message) => message.role === "assistant")).toHaveLength(1);
    const said = lines(r, chat);
    expect(said.map((line) => line.command)).toEqual(["/compact", "compact"]);
    expect(said[1]?.outcome).toContain("compacted");

    // The request was taken: another round starts nothing.
    await r.round(chat);
    expect(r.calls).toHaveLength(2);
  });

  test("a compaction run is not 'writing' once it is done, and a failed one is not tried again by the next round", async () => {
    let failing = false;
    const r = await rig((_ctx, call) => {
      if ((call.params.compact as { only?: boolean } | undefined)?.only === true) {
        failing = true;
        return { result: "failed", data: { reason: "model_error", message: "boom" } };
      }
      return reply("answer", "s-1");
    }, undefined, undefined, "pi");
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    await send(r, chat, "/compact");
    expect((await r.round(chat)).result).toBe("failed");
    expect(failing).toBe(true);
    // The request was taken, so a later round with nothing to answer starts no run.
    await r.round(chat);
    expect(r.calls).toHaveLength(2);
  });

  test("a compaction run that is done is no longer a reply being written", async () => {
    const r = await rig(() => reply("answer", "s-1"), undefined, undefined, "pi");
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    await send(r, chat, "/compact");
    await r.round(chat);
    const read = readChat(r.store, chat);
    expect(writingReply(chatFacts(r.store, chat), read.messages, read.entries)).toBeUndefined();
  });

  test("a /compact typed during a reply is taken by the next round of that same flow", async () => {
    let typed: Promise<unknown> | undefined;
    // eslint-disable-next-line prefer-const
    let r: Rig | undefined;
    r = await rig(() => {
      if (typed === undefined && r !== undefined) typed = send(r, chatId, "/compact");
      return reply("answer", "s-1");
    }, undefined, undefined, "pi");
    const chatId = await r.chat();
    await r.say(chatId, "one");
    const first = await r.round(chatId);
    const said = await typed;
    expect((said as { value: unknown }).value).toBe("the context is compacted when the reply being written ends");
    expect(first.result).toBe("more");
    expect(r.events).toHaveLength(0);
    await r.round(chatId);
    expect(compactionOf(r.calls[1])).toMatchObject({ only: true });
  });

  test("with a message waiting, the reply carries the request and compacts after it", async () => {
    const r = await rig(() => reply("answer", "s-1"), undefined, undefined, "pi");
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    await send(r, chat, "/compact");
    await r.say(chat, "two");
    await r.round(chat);
    expect(compactionOf(r.calls[1])).toMatchObject({ now: true });
    expect(compactionOf(r.calls[1])?.only).toBeUndefined();
  });

  test("a compaction that did nothing says so", async () => {
    const r = await rig(() => reply("answer", "s-1"), undefined, undefined, "pi");
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    await send(r, chat, "/compact");
    await r.round(chat);
    const said = lines(r, chat);
    expect(said.at(-1)).toMatchObject({ command: "compact", ok: false });
    expect(said.at(-1)?.outcome).toContain("Nothing was compacted");
  });

  test("it is offered, and listed by /help, only on a pi chat", async () => {
    const pi = await rig(() => reply("ok"), undefined, undefined, "pi");
    const piChat = await pi.chat();
    const help = await send(pi, piChat, "/help");
    expect(String(help.value)).toContain("`/compact`");

    const other = await rig(() => reply("ok"));
    const otherChat = await other.chat();
    const otherHelp = await send(other, otherChat, "/help");
    expect(String(otherHelp.value)).not.toContain("`/compact`");
    const object = await other.store.get(CHAT_TYPE, otherChat);
    expect(chatData(object?.data ?? {}).harness).toBe("fake");
  });
});

test("the compact line is stored as a command fact so no client changes", async () => {
  const r = await rig(() => ({ result: "done", data: { finalMessage: "a", sessionId: "s-1", compacted: true, compaction: COMPACTED } }), undefined, undefined, "pi");
  const chat = await r.chat();
  await r.say(chat, "one");
  await r.round(chat);
  expect(r.store.facts(chatRef(chat)).facts.some((fact) => fact.type === COMMAND_FACT)).toBe(true);
});

describe("a chat too full to compact", () => {
  const FULL = { reason: "threshold", before: 190_000, after: 160_000, flushed: false } as const;
  const full = (compaction: Record<string, unknown> = FULL, used = 160_000) => ({
    result: "done" as const,
    data: {
      finalMessage: "answer",
      sessionId: "s-1",
      compacted: true,
      compaction,
      context: { used, window: 200_000 },
    },
  });

  test("when the compaction leaves the context over the share, the next reply fails with one plain line and the agent is not called", async () => {
    const r = await rig(() => full(), undefined, undefined, "pi");
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    expect(r.calls).toHaveLength(1);

    await r.say(chat, "two");
    const round = await r.round(chat);
    expect(round.result).toBe("failed");
    expect(r.calls).toHaveLength(1);
    const failures = readChat(r.store, chat).entries.filter((entry) => entry.kind === "failure");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.text).toContain("too full to continue");
    expect(failures[0]?.text).toContain("/new");
  });

  test("two compactions never run in a row: with no reply that added context between, the agent is not asked again", async () => {
    const r = await rig(() => full(), undefined, undefined, "pi");
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    for (const text of ["two", "three"]) {
      await r.say(chat, text);
      await r.round(chat);
    }
    const compacting = r.calls.filter((call) => compactionOf(call) !== undefined);
    expect(compacting).toHaveLength(1);
    expect(r.calls).toHaveLength(1);
  });

  test("a compaction that fits does not stop the chat", async () => {
    const r = await rig(() => full({ ...FULL, after: 20_000 }, 20_000), undefined, undefined, "pi");
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    await r.say(chat, "two");
    expect((await r.round(chat)).result).toBe("done");
    // A compaction starts a segment, and the naming call is not a reply.
    expect(r.calls.filter((call) => !String(call.params.prompt).includes("Give a title"))).toHaveLength(2);
  });

  test("a window that is not known never stops the chat", async () => {
    const r = await rig(() => ({ result: "done", data: { finalMessage: "a", sessionId: "s-1", compacted: true, compaction: FULL } }), undefined, undefined, "pi");
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    await r.say(chat, "two");
    expect((await r.round(chat)).result).toBe("done");
  });

  test("/new ends it: the next message goes to a fresh session", async () => {
    const r = await rig(() => full(), undefined, undefined, "pi");
    const chat = await r.chat();
    await r.say(chat, "one");
    await r.round(chat);
    await send(r, chat, "/new");
    await r.say(chat, "two");
    await r.round(chat);
    const replies = r.calls.filter((call) => !String(call.params.prompt).includes("Give a title"));
    expect(replies).toHaveLength(2);
    expect(replies[1]?.params.resumeSession).toBeUndefined();
  });
});
