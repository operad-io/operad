import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { definePlugin, type PluginStepResult, type ViewContext } from "@operad-io/engine";
import { match } from "@operad-io/access-match";
import {
  allMessages,
  CHAT_TYPE,
  chatData,
  chatFacts,
  chatRef,
  chatViews,
  commandOfFact,
  COMPACT_FLUSH,
  PRIVATE_FACT,
  PRIVATE_STATUS,
  sessionHoldsPrivate,
  readChat,
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

/** A bot's settings step: its memory notes and the directories that are its memory. */
function botSettings(cwd: () => string) {
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
              access: { denyPaths: ["/secret"] },
              skills: [],
              notes: [{ name: "memory/index.md", path: join(cwd(), "memory", "index.md") }],
              memoryPaths: [join(cwd(), "memory")],
            },
          };
        },
      },
    ],
  });
}

async function botRig(script: Parameters<typeof rig>[0] = () => reply("ok"), harness = "fake") {
  let cwd = "";
  const r = await rig(script, undefined, undefined, harness, [botSettings(() => cwd)]);
  cwd = r.root;
  mkdirSync(join(cwd, "memory"), { recursive: true });
  const chat = await r.chat({ refresh: "settings/refresh", parent: "bot:default" });
  return { r, chat, cwd };
}

describe("/private", () => {
  test("a bot chat turns the stretch on and off with the same command, and says what it is and is not", async () => {
    const { r, chat } = await botRig();
    await send(r, chat, "/private");
    expect(chatData((await r.store.get(CHAT_TYPE, chat))?.data ?? {}).private).toBe(true);
    await send(r, chat, "/private");
    expect(chatData((await r.store.get(CHAT_TYPE, chat))?.data ?? {}).private).toBeUndefined();
    const said = lines(r, chat);
    expect(said.map((line) => line.ok)).toEqual([true, true]);
    expect(said[0]?.outcome).toBe(
      "Not remembered / 不记入记忆: on. Messages from here stay in this chat but are not saved to memory or search. Send /private again to end it.",
    );
    expect(said[1]?.outcome).toBe(
      "Not remembered / 不记入记忆: off. What you sent meanwhile was not saved, but this chat may still recall it. Send /new to start clean.",
    );
    const facts = chatFacts(r.store, chat).filter((fact) => fact.type === PRIVATE_FACT);
    expect(facts.map((fact) => fact.data.on)).toEqual([true, false]);
    // A command is not a message and starts no reply.
    expect(allMessages(r.store, chat)).toHaveLength(0);
  });

  test("a chat that is not a bot's has no memory and refuses it", async () => {
    const r = await rig(() => reply("ok"));
    const chat = await r.chat();
    await send(r, chat, "/private");
    expect(lines(r, chat)[0]).toMatchObject({ ok: false });
    expect(lines(r, chat)[0]?.outcome).toContain("only a chat of a bot");
    expect(chatData((await r.store.get(CHAT_TYPE, chat))?.data ?? {}).private).toBeUndefined();
  });

  test("the row and every page show the standing status while it is on, and only then", async () => {
    const { r, chat } = await botRig();
    const ctx = { store: r.store, settings: {}, plugin: "chat" } as unknown as ViewContext;
    const view = async () => {
      const object = await r.store.get(CHAT_TYPE, chat);
      if (object === undefined) throw new Error("no chat");
      return { note: chatViews.row(object).note ?? "", markdown: (await chatViews.load(ctx, object, "transcript", {})).markdown };
    };
    expect((await view()).note).not.toContain(PRIVATE_STATUS);
    await send(r, chat, "/private");
    const on = await view();
    expect(on.note).toContain(PRIVATE_STATUS);
    expect(on.markdown.startsWith(`**${PRIVATE_STATUS}**`)).toBe(true);
    await send(r, chat, "/private");
    const off = await view();
    expect(off.note).not.toContain(PRIVATE_STATUS);
    expect(off.markdown.startsWith("**")).toBe(false);
  });

  test("messages and their answers are marked; those before and after the stretch are not", async () => {
    const { r, chat } = await botRig();
    await send(r, chat, "before");
    await r.round(chat);
    await send(r, chat, "/private");
    await send(r, chat, "secret");
    await r.round(chat);
    await send(r, chat, "/private");
    await send(r, chat, "after");
    await r.round(chat);
    const marked = allMessages(r.store, chat).map((message) => [message.text, message.private === true]);
    expect(marked).toEqual([
      ["before", false],
      ["ok", false],
      ["secret", true],
      ["ok", true],
      ["after", false],
      ["ok", false],
    ]);
  });

  test("the reply's profile leaves the bot's memory readable and not writable, only while it is on", async () => {
    const { r, chat, cwd } = await botRig();
    await send(r, chat, "first");
    await r.round(chat);
    await send(r, chat, "/private");
    await send(r, chat, "second");
    await r.round(chat);
    await send(r, chat, "/private");
    await send(r, chat, "third");
    await r.round(chat);
    const note = join(cwd, "memory", "note.md");
    const verdicts = (tool: string) =>
      r.calls.map((call) => match(call.access as Record<string, never>, { tool, input: { path: note }, cwd }));
    const writes = verdicts("write");
    expect(writes[1]).toMatchObject({ allow: false, rule: join(cwd, "memory") });
    // Outside the stretch the same write is not refused by the memory deny (at this level it asks).
    for (const verdict of [writes[0], writes[2]]) expect(verdict).not.toMatchObject({ rule: join(cwd, "memory") });
    // A command that redirects into the memory is refused too.
    const shell = match(r.calls[1]?.access as Record<string, never>, { tool: "bash", input: { command: `echo x > ${note}` }, cwd });
    expect(shell.allow).toBe(false);
    expect(verdicts("read")[1]?.allow).toBe(true);
  });

  test("it is refused while a reply is being written", async () => {
    let during = "";
    const holder: { r?: Rig; chat?: string } = {};
    const { r, chat } = await botRig(async () => {
      if (holder.r !== undefined && holder.chat !== undefined) {
        await send(holder.r, holder.chat, "/private");
        during = lines(holder.r, holder.chat).at(-1)?.outcome ?? "";
      }
      return reply("ok");
    });
    holder.r = r;
    holder.chat = chat;
    await send(r, chat, "hello");
    await r.round(chat);
    expect(during).toContain("is writing a reply");
    expect(chatData((await r.store.get(CHAT_TYPE, chat))?.data ?? {}).private).toBeUndefined();
  });
});

describe("the memory flush before a compaction", () => {
  const flushOf = (call: { readonly params: Record<string, unknown> } | undefined): unknown => {
    const value = call?.params.compact;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>).flush : undefined;
  };

  test("is given to a session with no stretch, skipped while it is on, and skipped after it until /new", async () => {
    const { r, chat } = await botRig(() => reply("ok"), "pi");
    await send(r, chat, "one");
    await r.round(chat);
    expect(flushOf(r.calls[0])).toBe(COMPACT_FLUSH);
    await send(r, chat, "/private");
    await send(r, chat, "two");
    await r.round(chat);
    expect(flushOf(r.calls[1])).toBeUndefined();
    await send(r, chat, "/private");
    await send(r, chat, "three");
    await r.round(chat);
    // The summary would carry the stretch, so the session gets no flush after it either.
    expect(flushOf(r.calls[2])).toBeUndefined();
    const read = readChat(r.store, chat);
    expect(sessionHoldsPrivate(read.messages, read.facts)).toBe(true);
    await send(r, chat, "/new");
    await send(r, chat, "four");
    await r.round(chat);
    expect(flushOf(r.calls[3])).toBe(COMPACT_FLUSH);
  });
});
