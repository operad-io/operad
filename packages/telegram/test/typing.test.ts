import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_TYPE, MESSAGE_FACT, allMessages, chatRef } from "@operad-io/chat";
import { Secret, type ClientApi, type SourceContext, type ViewEvent } from "@operad-io/engine";
import { fakeClock, type FakeClock } from "@operad-io/engine/testing";
import {
  BotApiError,
  ReplySender,
  TelegramSource,
  EVENT_RETRY_MS,
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
  /** How often a detail page and a list were read; events should use the list. */
  gets = 0;
  lists = 0;
  private wake: ((result: IteratorResult<ViewEvent>) => void) | undefined;
  private fail: ((error: unknown) => void) | undefined;
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
      this.fail = undefined;
      wake({ done: false, value: event });
    } else {
      this.queued.push(event);
    }
  }

  /** Makes the stream the watcher is reading fail, as a killed connection does. */
  failEvents(): void {
    const fail = this.fail;
    this.wake = undefined;
    this.fail = undefined;
    fail?.(new Error("the event stream failed"));
  }

  list: ClientApi["list"] = async (type, options) => {
    this.lists += 1;
    const page = await this.views.list(type, options);
    return {
      ...page,
      rows: page.rows.map((row) => ({ ...row, running: this.running.get(row.id) ?? false })),
    };
  };

  get: ClientApi["get"] = async (id) => {
    this.gets += 1;
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
          return new Promise<IteratorResult<ViewEvent>>((resolve, reject) => {
            this.wake = resolve;
            this.fail = reject;
          });
        },
        return: async () => {
          this.wake?.({ done: true, value: undefined });
          this.wake = undefined;
          this.fail = undefined;
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

/** Lets work already woken by a clock advance run before the next assertion. */
function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Records the reply the chat's user message waits for. */
async function appendReply(f: Fixture): Promise<void> {
  const user = allMessages(f.w.store, f.chat).find((message) => message.role === "user");
  if (user === undefined) throw new Error("the chat has no user message");
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
      replyTo: [user.id],
      runId: "run-typing",
    },
  });
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

  test("is sent when a reply starts, repeated while it is written, and stops once the reply is recorded", async () => {
    const f = await setup();
    f.client.running.set(f.chat, true);
    await f.sender.syncChat(f.chat);
    expect(f.api.chatActions).toHaveLength(1);
    expect(f.api.chatActions[0]).toMatchObject({ chatId: 555, action: "typing" });

    f.clock.advance(TYPING_INTERVAL_MS);
    await f.api.until(() => f.api.chatActions.length >= 2);
    expect(f.api.chatActions).toHaveLength(2);

    // The reply is recorded while the run goes on: writing is over.
    await appendReply(f);
    await f.sender.syncChat(f.chat);
    expect(f.client.running.get(f.chat)).toBe(true);
    f.clock.advance(TYPING_INTERVAL_MS * 3);
    await nextTurn();
    expect(f.api.chatActions).toHaveLength(2);
    await f.stop();
  });

  test("stops when a reply run ends without recording a reply", async () => {
    const f = await setup();
    f.client.running.set(f.chat, true);
    await f.sender.syncChat(f.chat);
    expect(f.api.chatActions).toHaveLength(1);

    // A failed or cancelled run has no reply message; the client says it ended.
    f.client.running.set(f.chat, false);
    await f.sender.syncChat(f.chat);
    f.clock.advance(TYPING_INTERVAL_MS * 3);
    await nextTurn();
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
    await nextTurn();
    expect(f.api.chatActions).toHaveLength(0);
    await f.stop();
  });

  test("a failed send is not retried at once, is renewed on the next interval, and adds nothing to history", async () => {
    const f = await setup();
    const before = f.w.store.facts(chatRef(f.chat), { limit: 500 }).facts.length;
    let attempts = 0;
    f.api.beforeChatAction = () => {
      attempts += 1;
      if (attempts === 1) throw new BotApiError("Forbidden: bot was blocked by the user", { retryable: false });
    };
    f.client.running.set(f.chat, true);
    await f.sender.syncChat(f.chat);
    expect(f.api.chatActions).toHaveLength(1);
    // Another event while the send fails still does not send it again at once.
    await f.sender.syncChat(f.chat);
    expect(f.api.chatActions).toHaveLength(1);

    // The indicator is still renewed when its interval comes.
    f.clock.advance(TYPING_INTERVAL_MS);
    await f.api.until(() => f.api.chatActions.length >= 2);
    expect(f.api.chatActions).toHaveLength(2);
    expect(attempts).toBe(2);

    await appendReply(f);
    await new ReplySender(f.w.ctx, { api: f.api, wait: async () => undefined }).sweepAll();
    expect(f.api.sent.map((request) => request.text)).toEqual(["the answer"]);

    await f.sender.syncChat(f.chat);
    expect(f.api.chatActions).toHaveLength(2);
    expect(f.w.store.facts(chatRef(f.chat), { limit: 500 }).facts).toHaveLength(before + 1);
    const failed: string[] = [];
    for await (const input of f.w.log.readInputs()) {
      if (input.source === "telegram" && input.sourceKey.startsWith("send_failed:")) failed.push(input.sourceKey);
    }
    expect(failed).toEqual([]);
    await f.stop();
  });

  test("coalesces a burst of events into one list and no detail page", async () => {
    const f = await setup();
    f.client.running.set(f.chat, true);
    f.client.lists = 0;
    f.client.gets = 0;
    // The first check runs while the other events arrive: at most one more
    // check follows it, rather than one per event.
    await Promise.all(Array.from({ length: 10 }, () => f.sender.syncChat(f.chat)));
    expect(f.api.chatActions).toHaveLength(1);
    expect(f.client.lists).toBeLessThanOrEqual(2);
    expect(f.client.gets).toBe(0);
    await f.stop();
  });

  test("takes the client's events again after the stream fails", async () => {
    const f = await setup();
    f.client.failEvents();
    // Let the watcher see the failure and arm its retry.
    await Promise.resolve();
    f.client.running.set(f.chat, true);
    f.client.announce(f.chat);
    f.clock.advance(EVENT_RETRY_MS);
    await f.api.until(() => f.api.chatActions.length >= 1);
    expect(f.api.chatActions[0]).toMatchObject({ chatId: 555, action: "typing" });
    await f.stop();
  });

  test("stops when a run ends without an event, as the periodic check sees it", async () => {
    const f = await setup();
    f.client.running.set(f.chat, true);
    await f.sender.syncChat(f.chat);
    expect(f.api.chatActions).toHaveLength(1);

    f.client.running.set(f.chat, false);
    f.clock.advance(TYPING_INTERVAL_MS);
    await f.sender.settled();
    const sent = f.api.chatActions.length;
    expect(sent).toBeLessThanOrEqual(2);
    f.clock.advance(TYPING_INTERVAL_MS * 3);
    await f.sender.settled();
    expect(f.api.chatActions).toHaveLength(sent);
    await f.stop();
  });

});
