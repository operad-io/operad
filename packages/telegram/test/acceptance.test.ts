/**
 * The acceptance paragraph of `docs/backlog/operad-telegram.md`, followed from
 * the first message to an answered pending item: the real kernel, chat and bot
 * plugins, a real runner for the reply, the real client API, and a fake Bot API.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_TYPE, allMessages, chatData } from "@operad-io/chat";
import { Runner, type SourceContext } from "@operad-io/engine";
import {
  PendingSender,
  ReplySender,
  TelegramSource,
  telegramChannel,
  writeOffset,
  type AnswerCallbackRequest,
  type BotApi,
  type EditMessageRequest,
  type GetUpdatesRequest,
  type SendMessageRequest,
  type TelegramUpdate,
} from "../src/index.ts";
import { createTelegramWorld, replyUpdate, tap, update, type TelegramWorld } from "./support.ts";

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A Bot API that holds `getUpdates` until an update past the offset arrives, as a long poll does. */
class LongPollApi implements BotApi {
  private readonly queue: TelegramUpdate[] = [];
  private readonly waiting: (() => void)[] = [];
  readonly sent: (SendMessageRequest & { readonly messageId: number })[] = [];
  readonly edits: EditMessageRequest[] = [];
  readonly callbacks: AnswerCallbackRequest[] = [];
  private readonly watchers: (() => void)[] = [];

  /** What the person does: update ids are the caller's, and one may be sent again. */
  deliver(...updates: TelegramUpdate[]): void {
    this.queue.push(...updates);
    for (const wake of this.waiting.splice(0)) wake();
  }

  async getUpdates(request: GetUpdatesRequest): Promise<readonly TelegramUpdate[]> {
    for (;;) {
      const fresh = this.queue.filter((item) => item.update_id >= request.offset);
      if (fresh.length > 0) return fresh;
      if (request.signal?.aborted === true) return [];
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
        request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }

  async sendMessage(request: SendMessageRequest): Promise<number> {
    const messageId = 9_000 + this.sent.length + 1;
    this.sent.push({ ...request, messageId });
    this.changed();
    return messageId;
  }

  async editMessage(request: EditMessageRequest): Promise<void> {
    this.edits.push(request);
    this.changed();
  }

  async answerCallback(request: AnswerCallbackRequest): Promise<void> {
    this.callbacks.push(request);
    this.changed();
  }

  private changed(): void {
    for (const watcher of [...this.watchers]) watcher();
  }

  /** Resolves when `found` holds; looked at again after every call the bot makes. */
  async until(found: () => boolean): Promise<void> {
    if (found()) return;
    await new Promise<void>((resolve) => {
      const watcher = (): void => {
        if (!found()) return;
        this.watchers.splice(this.watchers.indexOf(watcher), 1);
        resolve();
      };
      this.watchers.push(watcher);
    });
  }
}

/** Starts the plugin's three parts as `start(ctx)` does, on one fake Bot API. */
function startPlugin(ctx: SourceContext, api: BotApi) {
  const pending = new PendingSender(ctx, { api });
  const source = new TelegramSource(ctx, { api, pending, wait: async () => undefined }).start();
  const replies = new ReplySender(ctx, { api, wait: async () => undefined }).start();
  const sent = pending.start();
  return {
    ready: sent.ready,
    async stop(): Promise<void> {
      source.stop();
      await replies.stop();
      await sent.stop();
    },
  };
}

test("from the first Telegram message to an answered pending item", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-acceptance-"));
  roots.push(root);
  const rounds: Record<string, unknown>[] = [];
  const w: TelegramWorld = await createTelegramWorld({
    root,
    users: [42],
    follow: true,
    // The agent answers a greeting, and asks before it runs a command.
    agent: async (ctx, params) => {
      rounds.push(params);
      const text = String(params.prompt);
      if (!text.includes("run ls")) return { result: "done", data: { finalMessage: "Hi **friend**", sessionId: "s-1" } };
      const answer = await ctx.ask({ prompt: "Run this command? ls", choices: ["allow_once", "reject_once"], graceSecs: 600 });
      return { result: "done", data: { finalMessage: `ls was ${answer.choice}`, sessionId: "s-1" } };
    },
  });

  // The test is the serve loop: a run the kernel records is given to a runner.
  const runners: Promise<unknown>[] = [];
  const driven = new Set<string>();
  const drive = async (): Promise<void> => {
    for (const run of await w.log.runs()) {
      if (driven.has(run.runId) || run.object === undefined) continue;
      driven.add(run.runId);
      const found = w.registry.flow(run.flow);
      if (found === undefined) throw new Error(`no flow ${run.flow}`);
      const [type, id] = run.object.split(":");
      if (type === undefined || id === undefined) throw new Error(`object ${run.object}`);
      runners.push(
        new Runner({
          log: w.log,
          flow: found.flow,
          runId: run.runId,
          registry: w.registry,
          lockRoot: join(root, "locks"),
          object: { type, id },
        }).run(),
      );
    }
  };
  const ctx: SourceContext = {
    ...w.ctx,
    emit: async (event) => {
      await w.ctx.emit(event);
      await drive();
    },
  };

  const api = new LongPollApi();
  const plugin = startPlugin(ctx, api);
  await plugin.ready;

  // 1. A listed user writes first: a chat opens on the default bot, bound to that Telegram chat,
  //    and the reply comes back to Telegram.
  api.deliver(update(100, 42, 555, "hello"));
  await api.until(() => api.sent.length === 1);
  expect(api.sent[0]).toMatchObject({ chatId: 555 });
  expect(api.sent[0]?.text).toContain("Hi");
  const chats = (await w.store.list(CHAT_TYPE)).objects;
  expect(chats).toHaveLength(1);
  const chat = chats[0];
  if (chat === undefined) throw new Error("no chat");
  expect(chatData(chat.data).channels).toEqual([telegramChannel(555)]);
  expect(chatData(chat.data).harness).toBe("test-agent");

  // ...and the same exchange is the chat's transcript, which is what the phone shows.
  await Promise.all(runners);
  const transcript = (await w.views.section(`chat:${chat.id}`, "transcript")).markdown;
  expect(transcript).toContain("hello");
  expect(transcript).toContain("Hi **friend**");
  expect(allMessages(w.store, chat.id)[0]).toMatchObject({ from: { via: "telegram", id: "42" } });

  // 2. A question in that chat arrives as a card with buttons, and the same item is pending for the phone.
  api.deliver(update(101, 42, 555, "please run ls"));
  await api.until(() => api.sent.length === 2);
  const card = api.sent[1];
  if (card === undefined) throw new Error("no card");
  expect(card.text).toContain("Run this command? ls");
  expect(card.keyboard?.flat().map((button) => button.text)).toEqual(["allow_once", "reject_once"]);
  const waiting = await w.views.pending();
  expect(waiting).toHaveLength(1);
  expect(waiting[0]?.object).toBe(`chat:${chat.id}`);

  // 3. A tap answers it: the run goes on, the buttons go, the message says what was chosen,
  //    and the item leaves the pending list everywhere.
  const button = card.keyboard?.flat()[0];
  if (button === undefined) throw new Error("no button");
  api.deliver(tap(102, 42, 555, card.messageId, button.data));
  await api.until(() => api.sent.length === 3);
  expect(api.sent[2]?.text).toContain("ls was allow_once");
  expect(api.edits.some((edit) => edit.messageId === card.messageId && edit.text.includes("answered: allow_once"))).toBe(true);
  expect(await w.views.pending()).toEqual([]);
  await Promise.all(runners);

  // 4. History says which Telegram message started each run, and who answered the question.
  const history = (await w.views.section(`chat:${chat.id}`, "history")).markdown;
  expect(history).toContain("telegram");
  expect(history).toContain("allow_once");
  const keys: string[] = [];
  for await (const input of w.log.readInputs()) if (input.source === "telegram") keys.push(input.sourceKey);
  expect(keys).toContain("100");
  expect(keys).toContain("101");

  // 5. The same updates read again, as after a restart of serve, write no second message,
  //    start no second run and send nothing twice.
  await plugin.stop();
  const runsBefore = (await w.log.runs()).length;
  const sentBefore = api.sent.length;
  // The offset was not saved before serve was killed, so Telegram sends the same updates again.
  writeOffset(w.home, 100, 1_700_000_000_000);
  const again = new LongPollApi();
  again.deliver(update(100, 42, 555, "hello"), update(101, 42, 555, "please run ls"), tap(102, 42, 555, card.messageId, button.data));
  const restarted = startPlugin(ctx, again);
  await restarted.ready;
  await again.until(() => again.callbacks.length >= 1);
  expect(allMessages(w.store, chat.id).filter((message) => message.role === "user")).toHaveLength(2);
  expect((await w.log.runs()).length).toBe(runsBefore);
  expect(again.sent).toEqual([]);
  expect(sentBefore).toBe(3);
  await restarted.stop();
  await w.close();
});
