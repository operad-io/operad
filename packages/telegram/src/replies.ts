/**
 * The reply side of the Telegram plugin: every new assistant message of a chat
 * bound to a Telegram chat is sent to that chat, once.
 *
 * It wakes on the client API's `events()`, which names a chat whenever it
 * changes. What it then reads, the chat's bindings and its messages with their
 * ids and roles, the client API does not give (a row has no channels; the
 * transcript section is rendered Markdown with no message ids), so those two
 * reads stay on the plugin's store. What was sent
 * is recorded in the plugin's own file, per message and per chunk, so a restart
 * sends neither a sent message again nor skips one written while the process was
 * down. A send that fails is retried on the injected wait; a send that gives up
 * is recorded as a `send_failed` event of the plugin and is not tried again. Only replies are sent,
 * never the tool calls (decision 7).
 */

import { CHAT_TYPE, allMessages, chatData, type Message } from "@operad-io/chat";
import { messageOf, type SourceContext } from "@operad-io/engine";
import { BotApiError, type BotApi } from "./api.ts";
import { telegramChunks, type TelegramChunk } from "./format.ts";
import { TELEGRAM_SOURCE } from "./source.ts";
import { readSent, writeSent, type SentRecord, type SentState } from "./state.ts";

/** How a failed send is tried again. */
export interface RetryPolicy {
  /** How many sends of one chunk before giving up. */
  readonly attempts: number;
  /** The wait before the second send; each next wait doubles. */
  readonly baseMs: number;
  /** The longest wait. */
  readonly maxMs: number;
}

/** The event type that records a reply Telegram never took. */
export const SEND_FAILED_EVENT = "send_failed";

export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, baseMs: 1_000, maxMs: 60_000 };

export interface ReplySenderOptions {
  readonly api: BotApi;
  readonly clock?: (() => number) | undefined;
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly retry?: RetryPolicy | undefined;
}

/** The Telegram chat ids a chat is bound to. */
function telegramChatsOf(channels: readonly string[]): readonly number[] {
  const found: number[] = [];
  for (const channel of channels) {
    if (!channel.startsWith(`${TELEGRAM_SOURCE}:`)) continue;
    const id = Number(channel.slice(TELEGRAM_SOURCE.length + 1));
    if (Number.isInteger(id)) found.push(id);
  }
  return found;
}

export class ReplySender {
  private readonly ctx: SourceContext;
  private readonly api: BotApi;
  private readonly clock: () => number;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly retry: RetryPolicy;
  private readonly controller = new AbortController();
  private readonly queues = new Map<string, Promise<void>>();
  private state: SentState;
  private stopped = false;
  private watching: Promise<void> = Promise.resolve();

  constructor(ctx: SourceContext, options: ReplySenderOptions) {
    this.ctx = ctx;
    this.api = options.api;
    this.clock = options.clock ?? ctx.clock;
    this.wait = options.wait;
    this.retry = options.retry ?? DEFAULT_RETRY;
    const existing = readSent(ctx.home);
    this.state = existing ?? { since: this.clock(), sent: {} };
    if (existing === undefined) writeSent(ctx.home, this.state);
    if (ctx.signal.aborted) this.controller.abort();
    else ctx.signal.addEventListener("abort", () => this.controller.abort(), { once: true });
  }

  /** Sends what is waiting on every bound chat, then follows the client's events. */
  start(): { readonly stop: () => Promise<void>; readonly ready: Promise<void> } {
    const iterator = this.ctx.client.events()[Symbol.asyncIterator]();
    // Wake-ups are pulled before the sweep so a change during it is not missed.
    const initial = this.sweepAll().catch((error: unknown) => this.log(`could not send replies: ${messageOf(error)}`));
    this.watching = (async () => {
      await initial;
      while (!this.stopped) {
        const next = await iterator.next();
        if (next.done === true || this.stopped) return;
        const id = next.value.id;
        if (id.length > 0) void this.sweepChat(id).catch((error: unknown) => this.log(`could not send replies: ${messageOf(error)}`));
      }
    })();
    return {
      ready: initial,
      stop: async () => {
        this.stopped = true;
        this.controller.abort();
        await iterator.return?.();
        await this.watching.catch(() => undefined);
        await Promise.all([...this.queues.values()]);
      },
    };
  }

  /** Sweeps every chat bound to Telegram once. */
  async sweepAll(): Promise<void> {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.ctx.store.list(CHAT_TYPE, { ...(cursor === undefined ? {} : { cursor }) });
      for (const object of page.objects) {
        if (telegramChatsOf(chatData(object.data).channels).length > 0) ids.push(object.id);
      }
      cursor = page.next;
    } while (cursor !== undefined);
    await Promise.all(ids.map((id) => this.sweepChat(id)));
  }

  /** Sends the unsent assistant messages of one chat; one sweep of a chat runs at a time. */
  sweepChat(chatId: string): Promise<void> {
    const previous = this.queues.get(chatId) ?? Promise.resolve();
    const run = previous.then(() => this.sweep(chatId));
    const settled = run.catch(() => undefined);
    this.queues.set(chatId, settled);
    void settled.then(() => {
      if (this.queues.get(chatId) === settled) this.queues.delete(chatId);
    });
    return run;
  }

  private async sweep(chatId: string): Promise<void> {
    if (this.stopped) return;
    const stored = await this.ctx.store.get(CHAT_TYPE, chatId);
    if (stored === undefined) return;
    const targets = telegramChatsOf(chatData(stored.data).channels);
    const target = targets[0];
    if (target === undefined) return;
    for (const message of allMessages(this.ctx.store, chatId)) {
      if (this.stopped) return;
      if (message.role !== "assistant" || message.at < this.state.since) continue;
      const key = `${chatId}/${message.id}`;
      const record = this.state.sent[key];
      if (record?.done === true) continue;
      await this.send(chatId, key, message, target, record);
    }
  }

  private async send(
    chatId: string,
    key: string,
    message: Message,
    target: number,
    record: SentRecord | undefined,
  ): Promise<void> {
    const chunks = telegramChunks(message.text);
    let sent = record?.chunks ?? 0;
    let telegramId = record?.telegramId;
    if (chunks.length === 0) {
      this.remember(key, { chunks: 0, done: true });
      return;
    }
    while (sent < chunks.length) {
      const chunk = chunks[sent];
      if (chunk === undefined) break;
      let id: number;
      try {
        id = await this.sendChunk(target, chunk);
      } catch (error) {
        if (this.stopped) return;
        await this.giveUp(chatId, message, sent, chunks.length, error);
        this.remember(key, { chunks: sent, ...(telegramId === undefined ? {} : { telegramId }), done: true, failed: true });
        return;
      }
      sent += 1;
      telegramId = id;
      this.remember(key, { chunks: sent, telegramId, done: sent >= chunks.length });
    }
  }

  /** One chunk: HTML first, plain text when Telegram cannot read the markup, retried on failure. */
  private async sendChunk(target: number, chunk: TelegramChunk): Promise<number> {
    let plain = false;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.api.sendMessage({
          chatId: target,
          text: plain ? chunk.plain : chunk.html,
          ...(plain ? {} : { parseMode: "HTML" as const }),
          signal: this.controller.signal,
        });
      } catch (error) {
        if (this.stopped) throw error;
        if (error instanceof BotApiError && error.badMarkup && !plain) {
          plain = true;
          attempt -= 1;
          continue;
        }
        const retryable = error instanceof BotApiError ? error.retryable : true;
        if (!retryable || attempt >= this.retry.attempts) throw error;
        const backoff = Math.min(this.retry.maxMs, this.retry.baseMs * 2 ** (attempt - 1));
        const asked = error instanceof BotApiError && error.retryAfterSecs !== undefined ? error.retryAfterSecs * 1_000 : 0;
        await this.wait(Math.max(backoff, asked), this.controller.signal);
        if (this.stopped) throw error;
      }
    }
  }

  /**
   * Says that a reply did not reach Telegram: a line in the plugin's log and a
   * `telegram/send_failed` event on the chat, keyed by the message so a retry
   * after a crash records it once. It is the plugin's own record; nothing is
   * written into the chat's messages or entries, which are the chat plugin's.
   */
  private async giveUp(chatId: string, message: Message, sent: number, total: number, error: unknown): Promise<void> {
    const part = total > 1 ? ` (part ${sent + 1} of ${total})` : "";
    const text = `could not send the reply${part}; gave up after ${this.retry.attempts} tries: ${messageOf(error)}`;
    await this.ctx.logger.write(`reply ${message.id} of chat ${chatId}: ${text}`);
    await this.ctx.emit({
      source: TELEGRAM_SOURCE,
      type: SEND_FAILED_EVENT,
      key: `${SEND_FAILED_EVENT}:${chatId}/${message.id}`,
      object: `chat:${chatId}`,
      summary: text,
    });
  }

  private remember(key: string, record: SentRecord): void {
    this.state = { since: this.state.since, sent: { ...this.state.sent, [key]: record } };
    writeSent(this.ctx.home, this.state);
  }

  private async log(message: string): Promise<void> {
    await this.ctx.logger.write(message);
  }
}
