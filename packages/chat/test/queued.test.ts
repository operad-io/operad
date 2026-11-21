import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { JsonValue, StepContext, ViewContext } from "@operad-io/engine";
import {
  allMessages,
  chatFacts,
  chatViews,
  MESSAGE_CHANGE_FACT,
  queueTestHooks,
  type Message,
} from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);
afterEach(() => {
  queueTestHooks.beforeTake = undefined;
});

type Rig = Awaited<ReturnType<typeof rig>>;

function latch(): { readonly promise: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function act(r: Rig, chat: string, action: string, args: Record<string, unknown>) {
  const object = await r.store.get("chat", chat);
  if (object === undefined) throw new Error("no chat");
  return r.registry.runAction(action, args, {
    object: { type: "chat", id: chat, data: object.data },
    actor: { via: "cli", id: "me" },
  });
}

async function send(r: Rig, chat: string, note: string): Promise<string> {
  const result = await act(r, chat, "chat/send", { note });
  const id = String(result.value).replace(/^sent /, "");
  if (!id.startsWith("m-")) throw new Error(`the send did not return a message id: ${String(result.value)}`);
  return id;
}

function viewContext(r: Rig): ViewContext {
  return {
    plugin: "chat",
    home: join(r.root, "home"),
    cwd: r.root,
    store: r.store,
    facts: { append: () => Promise.reject(new Error("read only")) },
    logger: { path: "", write: () => Promise.resolve("") },
    signal: new AbortController().signal,
    settings: r.registry.settingsFor("chat"),
    sectionCapBytes: 256 * 1024,
    secrets: {
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      names: () => Promise.resolve([]),
      values: () => Promise.resolve([]),
    },
  };
}

async function section(r: Rig, chat: string) {
  const object = await r.store.get("chat", chat);
  if (object === undefined) throw new Error("no chat");
  return { object, content: await chatViews.load(viewContext(r), object, "transcript", {}) };
}

function queuedOfRow(row: { readonly data?: Readonly<Record<string, JsonValue>> | undefined }): readonly { id?: unknown; text?: unknown }[] {
  const queued = row.data?.queued;
  return Array.isArray(queued) ? (queued as readonly { id?: unknown; text?: unknown }[]) : [];
}

function queuedOfSection(content: { readonly data?: Readonly<Record<string, JsonValue>> | undefined }): readonly { id?: unknown; text?: unknown }[] {
  const queued = content.data?.queued;
  return Array.isArray(queued) ? (queued as readonly { id?: unknown; text?: unknown }[]) : [];
}

describe("a chat's queued messages", () => {
  test("the row and the transcript say what is queued, and a run's first message stops being queued", async () => {
    const entered = latch();
    const finish = latch();
    const r = await rig(async () => {
      if (r.calls.length === 1) {
        entered.open();
        await finish.promise;
        return reply("first answer");
      }
      return reply("second answer");
    });
    const chat = await r.chat();
    const first = await send(r, chat, "first");
    let stored = await r.store.get("chat", chat);
    if (stored === undefined) throw new Error("no chat");
    expect(queuedOfRow(chatViews.row(stored)).map((item) => item.id)).toEqual([first]);
    expect(chatViews.row(stored).data?.queuedCount).toBe(1);
    expect(queuedOfSection((await section(r, chat)).content).map((item) => item.id)).toEqual([first]);

    const round = r.round(chat);
    await entered.promise;
    stored = await r.store.get("chat", chat);
    if (stored === undefined) throw new Error("no chat");
    expect(chatViews.row(stored).data).toBeUndefined();
    expect(queuedOfSection((await section(r, chat)).content)).toEqual([]);

    const second = await send(r, chat, "second");
    stored = await r.store.get("chat", chat);
    if (stored === undefined) throw new Error("no chat");
    expect(queuedOfRow(chatViews.row(stored)).map((item) => item.id)).toEqual([second]);
    expect(chatViews.row(stored).data?.queuedCount).toBe(1);
    expect(queuedOfSection((await section(r, chat)).content).map((item) => item.id)).toEqual([second]);
    expect(queuedOfRow(chatViews.row(stored))[0]?.text).toBe("second");

    finish.open();
    expect((await round).result).toBe("more");
    stored = await r.store.get("chat", chat);
    if (stored === undefined) throw new Error("no chat");
    expect(queuedOfRow(chatViews.row(stored)).map((item) => item.id)).toEqual([second]);
  });

  test("withdrawing a queued message removes it from the transcript, leaves a history entry, and sends nothing to the agent", async () => {
    const r = await rig(() => reply("answer"));
    const chat = await r.chat();
    const id = await send(r, chat, "remove me");
    const result = await act(r, chat, "chat/withdraw", { message: id });
    expect(result.value).toBe(`withdrew message ${id}`);
    expect(chatFacts(r.store, chat).filter((fact) => fact.type === MESSAGE_CHANGE_FACT)).toHaveLength(1);
    expect(allMessages(r.store, chat)).toEqual([]);

    const { object, content } = await section(r, chat);
    expect(content.markdown).not.toContain("remove me");
    expect(content.markdown).toContain("withdrawn");
    expect(content.markdown).toContain(id);
    expect(queuedOfSection(content)).toEqual([]);
    expect(chatViews.row(object).data).toBeUndefined();

    expect((await r.round(chat)).result).toBe("done");
    expect(r.calls).toHaveLength(0);
  });

  test("a withdrawal after a finished reply still leaves its history entry in the transcript", async () => {
    const r = await rig(() => reply("answer"));
    const chat = await r.chat();
    await send(r, chat, "first");
    expect((await r.round(chat)).result).toBe("done");
    const id = await send(r, chat, "remove me");
    await act(r, chat, "chat/withdraw", { message: id });
    const { content } = await section(r, chat);
    expect(content.markdown).toContain("withdrawn");
    expect(content.markdown).toContain(id);
    expect(content.markdown).not.toContain("remove me");
    expect(content.markdown).toContain("answer");
  });

  test("changing a queued message's text keeps its attachments, and the agent gets the new text", async () => {
    const r = await rig(async () => reply("answer"));
    const chat = await r.chat();
    const attachment = { path: "/tmp/photo.png", name: "photo.png", type: "image/png", size: 3 };
    const id = await r.say(chat, "old words", [attachment]);
    const result = await act(r, chat, "chat/edit", { message: id, text: "new words" });
    expect(result.value).toBe(`changed message ${id}`);

    const message = allMessages(r.store, chat).find((item): item is Message => item.id === id);
    expect(message?.text).toBe("new words");
    expect(message?.attachments).toEqual([attachment]);
    const { object, content } = await section(r, chat);
    expect(content.markdown).toContain("new words");
    expect(content.markdown).not.toContain("old words");
    expect(content.markdown).toContain("photo.png");
    expect(queuedOfRow(chatViews.row(object))[0]?.text).toBe("new words");

    await r.round(chat);
    expect(String(r.calls[0]?.params.prompt)).toStartWith("new words");
  });

  test("a message a run has taken cannot be withdrawn or changed", async () => {
    let chat = "";
    const entered = latch();
    const finish = latch();
    const r = await rig(async () => {
      if (r.calls.length === 1) {
        entered.open();
        await finish.promise;
        return reply("answer");
      }
      return reply("again");
    });
    chat = await r.chat();
    const id = await send(r, chat, "already going");
    const round = r.round(chat);
    await entered.promise;
    await expect(act(r, chat, "chat/withdraw", { message: id })).rejects.toThrow(/taken by a run/);
    await expect(act(r, chat, "chat/edit", { message: id, text: "different" })).rejects.toThrow(/taken by a run/);
    expect(allMessages(r.store, chat).map((item) => item.text)).toEqual(["already going"]);
    expect(chatFacts(r.store, chat).filter((fact) => fact.type === MESSAGE_CHANGE_FACT)).toEqual([]);
    finish.open();
    expect((await round).result).toBe("done");
  });

  test("a take and a withdraw of the same message never both happen: the take wins when it starts first", async () => {
    let chat = "";
    let second = "";
    let withdraw: Promise<unknown> | undefined;
    const listening = latch();
    const idReady = latch();
    const delivered = latch();
    const finish = latch();
    const r = await rig(
      async (_ctx: StepContext, call) => {
        if (r.calls.length === 1) {
          const inbox = call.params.inbox as {
            listen(handler: (text: string) => boolean | void): () => void;
          } | undefined;
          if (inbox === undefined) throw new Error("the harness was given no inbox");
          inbox.listen(() => {
            void (async () => {
              await idReady.promise;
              withdraw = act(r, chat, "chat/withdraw", { message: second });
              delivered.open();
            })();
            return true;
          });
          listening.open();
          await finish.promise;
          return reply("first answer");
        }
        return reply("second answer");
      },
      undefined,
      "fake",
      "fake",
      [],
      { takesMessagesMidRun: true },
    );
    chat = await r.chat();
    await send(r, chat, "first");
    const round = r.round(chat);
    await listening.promise;
    second = await r.say(chat, "second");
    idReady.open();
    await delivered.promise;
    await expect(withdraw).rejects.toThrow(/taken by a run/);
    finish.open();
    expect((await round).result).toBe("done");
    expect(allMessages(r.store, chat).map((item) => item.text)).toEqual(["first", "second", "first answer"]);
    expect(chatFacts(r.store, chat).filter((fact) => fact.type === MESSAGE_CHANGE_FACT)).toEqual([]);
  });

  test("a take and a withdraw of the same message never both happen: the withdraw wins when it starts first", async () => {
    let chat = "";
    let second = "";
    let blockTake = false;
    const listening = latch();
    const beforeTake = latch();
    const releaseTake = latch();
    const finish = latch();
    const r = await rig(
      async (_ctx: StepContext, call) => {
        if (r.calls.length === 1) {
          const inbox = call.params.inbox as {
            listen(handler: (text: string) => boolean | void): () => void;
          } | undefined;
          if (inbox === undefined) throw new Error("the harness was given no inbox");
          inbox.listen(() => true);
          listening.open();
          await finish.promise;
          return reply("first answer");
        }
        return reply("second answer");
      },
      undefined,
      "fake",
      "fake",
      [],
      { takesMessagesMidRun: true },
    );
    chat = await r.chat();
    await send(r, chat, "first");
    const round = r.round(chat);
    await listening.promise;
    queueTestHooks.beforeTake = async () => {
      if (!blockTake) return;
      beforeTake.open();
      await releaseTake.promise;
    };
    blockTake = true;
    second = await r.say(chat, "second");
    await beforeTake.promise;
    const result = await act(r, chat, "chat/withdraw", { message: second });
    expect(result.value).toBe(`withdrew message ${second}`);
    releaseTake.open();
    finish.open();
    expect((await round).result).toBe("done");
    const messages = allMessages(r.store, chat);
    expect(messages.map((item) => item.text)).toEqual(["first", "first answer"]);
    expect(chatFacts(r.store, chat).filter((fact) => fact.type === MESSAGE_CHANGE_FACT)).toHaveLength(1);
    const { content } = await section(r, chat);
    expect(content.markdown).toContain("withdrawn");
  });
});
