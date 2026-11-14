import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_TYPE, MESSAGE_FACT, chatRef } from "@operad-io/chat";
import { Secret, type ClientApi, type SourceContext, type ViewEvent } from "@operad-io/engine";
import { fakeClock, type FakeClock } from "@operad-io/engine/testing";
import {
  BotApiError,
  ReplySender,
  TelegramSource,
  TypingSender,
  TYPING_INTERVAL_MS,
  createBotApi,
} from "../src/index.ts";
import { FakeApi, createTelegramWorld, update, type TelegramWorld } from "./support.ts";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A client the test drives: which chats run, and a way to wake the watcher. */
class EventClient implements ClientApi {
  readonly running = new Map<string, boolean>();
  private wake: ((result: IteratorResult<ViewEvent>) => void) | undefined;
  private readonly queued: ViewEvent[] = [];
  private readonly views: TelegramWorld["views"];

  constructor(views: TelegramWorld["views"]) {
    this.views = views;
  }

  announce(id: string): void {
    const event = { id };
    if (this.wake !== undefined) {
      const wake = this.wake;
      this.wake = undefined;
      wake({ done: false, value: event });
    } else {
      this.queued.push(event);
    }
  }

  list: ClientApi["list"] = (type, options) => this.views.list(type, options);

  get: ClientApi["get"] = async (id) => {
    const object = await this.views.get(id);
    return { ...object, row: { ...object.row, running: this.running.get(object.id) ?? false } };
  };

  section: ClientApi["section"] = (id, sectionId, cursor, options) =>
    this.views.section(id, sectionId, cursor, options);

  events(): AsyncIterable<ViewEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const queued = this.queued.shift();
          if (queued !== undefined) return Promise.resolve({ done: false, value: queued });
          return new Promise<IteratorResult<ViewEvent>>((resolve) => {
            this.wake = resolve;
          });
        },
        return: async () => {
          this.wake?.({ done: true, value: undefined });
          this.wake = undefined;
          return { done: true, value: undefined };
        },
      }),
    };
  }

  act: ClientApi["act"] = (name, id, options) => this.views.act(name, id, options);

  pending: ClientApi["pending"] = () => this.views.pending();

  answer: ClientApi["answer"] = (options) => this.views.answer(options);
}

/** Waits on the test's clock, and ends early when its signal aborts. */
function clockWait(clock: FakeClock): (ms: number, signal: AbortSignal) => Promise<void> {
  return (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      let handle: unknown;
      const done = (): void => {
        if (handle !== undefined) clock.clearTimeout(handle);
        signal.removeEventListener("abort", done);
        resolve();
      };
      handle = clock.setTimeout(done, Math.max(0, ms));
      signal.addEventListener("abort", done, { once: true });
    });
}

interface Fixture {
  readonly w: TelegramWorld;
  readonly api: FakeApi;
  readonly chat: string;
  readonly client: EventClient;
  readonly clock: FakeClock;
  readonly sender: TypingSender;
  stop(): Promise<void>;
}

/** A world with one chat bound to Telegram chat 555, and a client the test drives. */
async function setup(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "telegram-typing-"));
  roots.push(root);
  const w = await createTelegramWorld({ root, users: [42] });
  const api = new FakeApi();
  api.updates = [update(100, 42, 555, "hello")];
  await new TelegramSource(w.ctx, { api }).poll();
  const chat = (await w.store.list(CHAT_TYPE)).objects[0]?.id;
  if (chat === undefined) throw new Error("no chat was opened");
  const client = new EventClient(w.views);
  const ctx: SourceContext = { ...w.ctx, client };
  const clock = fakeClock();
  const sender = new TypingSender(ctx, { api, clock: () => clock.now(), wait: clockWait(clock) });
  const handle = sender.start();
  await handle.ready;
  return {
    w,
    api,
    chat,
    client,
    clock,
    sender,
    async stop() {
      await handle.stop();
      await w.close();
    },
  };
}

describe("the typing indicator", () => {
  test("the Bot API client sends the typing action to the chat", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const api = createBotApi({
      token: new Secret("1:T"),
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      },
    });
    await api.sendChatAction({ chatId: 555, action: "typing" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.endsWith("/sendChatAction")).toBe(true);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ chat_id: 555, action: "typing" });
  });

  test("is sent when a reply starts, repeated while it runs, and stops after it ends", async () => {
    const f = await setup();
    f.client.running.set(f.chat, true);
    await f.sender.syncChat(f.chat);
    expect(f.api.chatActions).toHaveLength(1);
    expect(f.api.chatActions[0]).toMatchObject({ chatId: 555, action: "typing" });

    f.clock.advance(TYPING_INTERVAL_MS);
    await f.api.until(() => f.api.chatActions.length >= 2);
    expect(f.api.chatActions).toHaveLength(2);

    f.client.running.set(f.chat, false);
    await f.sender.syncChat(f.chat);
    expect(f.clock.pending).toBe(0);
    f.clock.advance(TYPING_INTERVAL_MS * 3);
    expect(f.api.chatActions).toHaveLength(2);
    await f.stop();
  });

  test("stops after a reply run fails", async () => {
    const f = await setup();
    f.client.running.set(f.chat, true);
    await f.sender.syncChat(f.chat);
    expect(f.api.chatActions).toHaveLength(1);

    // A failed run is no longer running; the client says so when it ends.
    f.client.running.set(f.chat, false);
    await f.sender.syncChat(f.chat);
    expect(f.clock.pending).toBe(0);
    f.clock.advance(TYPING_INTERVAL_MS * 3);
    expect(f.api.chatActions).toHaveLength(1);
    await f.stop();
  });

  test("starts when the client's events name a running chat, and stop ends it", async () => {
    const f = await setup();
    f.client.running.set(f.chat, true);
    f.client.announce(f.chat);
    await f.api.until(() => f.api.chatActions.length >= 1);
    expect(f.api.chatActions).toHaveLength(1);

    await f.stop();
    expect(f.clock.pending).toBe(0);
    f.clock.advance(TYPING_INTERVAL_MS * 3);
    expect(f.api.chatActions).toHaveLength(1);
  });

  test("is not sent for a chat that is not bound to Telegram", async () => {
    const f = await setup();
    const opened = await f.w.views.act("bot:chat", "default", {
      args: { title: "app only" },
      actor: { via: "cli", id: "me" },
    });
    const other = opened.opens?.slice("chat:".length);
    if (other === undefined) throw new Error("no chat was opened");
    f.client.running.set(other, true);
    await f.sender.syncChat(other);
    f.clock.advance(TYPING_INTERVAL_MS * 3);
    expect(f.api.chatActions).toHaveLength(0);
    await f.stop();
  });

  test("a failed send is not retried, adds nothing to history and does not hold up a reply", async () => {
    const f = await setup();
    const before = f.w.store.facts(chatRef(f.chat), { limit: 500 }).facts.length;
    f.api.beforeChatAction = () => {
      throw new BotApiError("Forbidden: bot was blocked by the user", { retryable: false });
    };
    f.client.running.set(f.chat, true);
    await f.sender.syncChat(f.chat);
    expect(f.api.chatActions).toHaveLength(1);

    await f.w.ctx.facts.append({
      type: MESSAGE_FACT,
      object: chatRef(f.chat),
      data: {
        id: "m-typing-reply",
        role: "assistant",
        from: { via: "agent", id: "default" },
        text: "the answer",
        attachments: [],
        source: { kind: "agent", ref: null },
      },
    });
    await new ReplySender(f.w.ctx, { api: f.api, wait: async () => undefined }).sweepAll();
    expect(f.api.sent.map((request) => request.text)).toEqual(["the answer"]);

    f.client.running.set(f.chat, false);
    await f.sender.syncChat(f.chat);
    expect(f.api.chatActions).toHaveLength(1);
    expect(f.w.store.facts(chatRef(f.chat), { limit: 500 }).facts).toHaveLength(before + 1);
    const failed: string[] = [];
    for await (const input of f.w.log.readInputs()) {
      if (input.source === "telegram" && input.sourceKey.startsWith("send_failed:")) failed.push(input.sourceKey);
    }
    expect(failed).toEqual([]);
    await f.stop();
  });
});
