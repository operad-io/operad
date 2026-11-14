/**
 * The typing side of the Telegram plugin: a chat bound to Telegram shows the
 * bot as typing while a reply run is writing one.
 *
 * It wakes on the client API's `events()`, which names a chat whenever it
 * changes, and reads whether that chat still has a message to answer and a run
 * working on it. The run flags come from `list`, one read for a burst of
 * events, not a detail page per event. It reads a bound chat's channels from
 * the plugin's store, as the reply side does. Telegram shows the indicator for
 * about five seconds, so it is sent again while the reply is written; it stops
 * when the reply is recorded, even if its run goes on. A failed send is logged
 * once and is not written to history.
 */

import { CHAT_TYPE, allMessages, chatData, unanswered } from "@operad-io/chat";
import { messageOf, type ClientApi, type SourceContext } from "@operad-io/engine";
import type { BotApi } from "./api.ts";
import { telegramChatsOf } from "./replies.ts";
import { delay } from "./source.ts";

/** How often the indicator is renewed; Telegram shows it for about five seconds. */
export const TYPING_INTERVAL_MS = 4_000;

/** How long to wait before following the client's events again after a failure. */
export const EVENT_RETRY_MS = 1_000;

export interface TypingSenderOptions {
  readonly api: BotApi;
  readonly clock?: (() => number) | undefined;
  readonly intervalMs?: number | undefined;
  /** Waits `ms` unless `signal` aborts first; a test gives one it moves itself. */
  readonly wait?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
}

/** One chat's indicator, and the loop that renews it. */
interface Typing {
  readonly controller: AbortController;
  readonly loop: Promise<void>;
}

export class TypingSender {
  private readonly ctx: SourceContext;
  private readonly api: BotApi;
  private readonly client: ClientApi;
  private readonly clock: () => number;
  private readonly intervalMs: number;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly controller = new AbortController();
  private readonly active = new Map<string, Typing>();
  private readonly loops = new Set<Promise<void>>();
  /** Chat ids whose state should be read next; repeated ids coalesce. */
  private readonly wanted = new Set<string>();
  private checking: Promise<void> | undefined;
  private reconciling: Promise<void> | undefined;
  private iterator: AsyncIterator<{ readonly id: string }> | undefined;
  private stopped = false;
  private watching: Promise<void> = Promise.resolve();

  constructor(ctx: SourceContext, options: TypingSenderOptions) {
    this.ctx = ctx;
    this.api = options.api;
    this.client = ctx.client;
    this.clock = options.clock ?? ctx.clock;
    this.intervalMs = options.intervalMs ?? TYPING_INTERVAL_MS;
    this.wait = options.wait ?? delay;
    const abort = (): void => {
      this.controller.abort();
      for (const typing of this.active.values()) typing.controller.abort();
    };
    if (ctx.signal.aborted) abort();
    else ctx.signal.addEventListener("abort", abort, { once: true });
  }

  /** Checks every bound chat once, then follows the client's events. */
  start(): { readonly stop: () => Promise<void>; readonly ready: Promise<void> } {
    const initial = this.syncAll().catch((error: unknown) => this.log(`could not show typing: ${messageOf(error)}`));
    this.watching = (async () => {
      await initial;
      // The periodic pass also ends an indicator whose run-end event was lost
      // by a bounded event stream.
      await Promise.all([this.follow(), this.reconcile()]);
    })();
    return {
      ready: initial,
      stop: async () => {
        this.stopped = true;
        this.controller.abort();
        for (const typing of this.active.values()) typing.controller.abort();
        try {
          await this.iterator?.return?.();
        } catch {
          // The stream is already unusable; stopping is still complete.
        }
        await this.watching.catch(() => undefined);
        while (this.checking !== undefined) await this.checking.catch(() => undefined);
        await Promise.all([...this.loops]);
      },
    };
  }

  /** Follows the client's events, taking the stream again after a failure. */
  private async follow(): Promise<void> {
    while (!this.stopped) {
      const iterator = this.client.events()[Symbol.asyncIterator]();
      this.iterator = iterator;
      try {
        while (!this.stopped) {
          const next = await iterator.next();
          if (next.done === true || this.stopped) return;
          const id = next.value.id;
          if (id.length > 0) {
            void this.syncChat(id).catch((error: unknown) => this.log(`could not show typing: ${messageOf(error)}`));
          }
        }
      } catch (error) {
        if (this.stopped) return;
        void this.log(`could not follow changes for typing: ${messageOf(error)}`).catch(() => undefined);
        await this.wait(EVENT_RETRY_MS, this.controller.signal).catch(() => undefined);
      } finally {
        if (this.iterator === iterator) this.iterator = undefined;
        try {
          await iterator.return?.();
        } catch {
          // A stream that failed may refuse to close; the next stream is new.
        }
      }
    }
  }

  /** Checks every bound chat once per interval, so a lost event cannot leave typing on. */
  private async reconcile(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.wait(this.intervalMs, this.controller.signal);
      } catch {
        return;
      }
      if (this.stopped) return;
      const pass = this.syncAll().catch((error: unknown) => this.log(`could not show typing: ${messageOf(error)}`));
      this.reconciling = pass;
      try {
        await pass;
      } finally {
        if (this.reconciling === pass) this.reconciling = undefined;
      }
    }
  }

  /** Checks every chat bound to Telegram once. */
  async syncAll(): Promise<void> {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.ctx.store.list(CHAT_TYPE, { ...(cursor === undefined ? {} : { cursor }) });
      for (const object of page.objects) {
        if (telegramChatsOf(chatData(object.data).channels).length > 0) ids.push(object.id);
      }
      cursor = page.next;
    } while (cursor !== undefined);
    await Promise.all(ids.map((id) => this.syncChat(id)));
  }

  /** Shows or stops the indicator of one chat, as the answer now stands. */
  syncChat(chatId: string): Promise<void> {
    this.wanted.add(chatId);
    return this.scheduleChecks();
  }

  /** Waits for the checks asked so far, including one just woken by an event. */
  async settled(): Promise<void> {
    // A watcher woken by the same event queues its check in a following turn.
    await Promise.resolve();
    while (this.checking !== undefined || this.reconciling !== undefined) {
      const work = this.checking ?? this.reconciling;
      if (work === undefined) return;
      await work.catch(() => undefined);
    }
  }

  private scheduleChecks(): Promise<void> {
    const existing = this.checking;
    if (existing !== undefined) return existing;
    const run = this.drainChecks().finally(() => {
      if (this.checking === run) {
        this.checking = undefined;
        if (!this.stopped && this.wanted.size > 0) void this.scheduleChecks();
      }
    });
    this.checking = run;
    return run;
  }

  private async drainChecks(): Promise<void> {
    while (!this.stopped && this.wanted.size > 0) {
      const ids = [...this.wanted];
      this.wanted.clear();
      await this.checkChats(ids);
    }
  }

  /** Reads the chats named by one burst of events, with one list read for their run flags. */
  private async checkChats(ids: readonly string[]): Promise<void> {
    const bound: { readonly chatId: string; readonly target: number }[] = [];
    for (const chatId of ids) {
      if (this.stopped) return;
      const stored = await this.ctx.store.get(CHAT_TYPE, chatId);
      if (stored === undefined) continue;
      const target = telegramChatsOf(chatData(stored.data).channels)[0];
      if (target === undefined) continue;
      bound.push({ chatId, target });
    }
    if (this.stopped || bound.length === 0) return;
    let running: ReadonlyMap<string, boolean>;
    try {
      running = await this.runningOf(bound.map((chat) => chat.chatId));
    } catch (error) {
      await this.log(`could not show typing: ${messageOf(error)}`);
      for (const chat of bound) await this.stopTyping(chat.chatId);
      return;
    }
    for (const chat of bound) {
      if (this.stopped) return;
      if (running.get(chat.chatId) !== true) {
        await this.stopTyping(chat.chatId);
        continue;
      }
      // The reply is recorded on the chat before its run ends. Once it answers
      // every message, writing is over even if the run goes on.
      if (unanswered(allMessages(this.ctx.store, chat.chatId)).length === 0) {
        await this.stopTyping(chat.chatId);
        continue;
      }
      this.startTyping(chat.chatId, chat.target);
    }
  }

  /** The running flags of the named chats from a list read, not a detail page per event. */
  private async runningOf(ids: readonly string[]): Promise<ReadonlyMap<string, boolean>> {
    const wanted = new Set(ids);
    const found = new Map<string, boolean>();
    let cursor: string | undefined;
    do {
      const page = await this.client.list(CHAT_TYPE, { ...(cursor === undefined ? {} : { cursor }) });
      for (const row of page.rows) {
        if (wanted.has(row.id)) found.set(row.id, row.running);
      }
      cursor = page.next;
    } while (cursor !== undefined && found.size < wanted.size);
    return found;
  }

  private startTyping(chatId: string, target: number): void {
    if (this.active.has(chatId) || this.stopped) return;
    const controller = new AbortController();
    const loop = (async () => {
      try {
        await this.type(chatId, target, controller);
      } catch (error) {
        if (!controller.signal.aborted && !this.stopped) {
          await this.log(`could not show typing in chat ${chatId}: ${messageOf(error)}`);
        }
      } finally {
        if (this.active.get(chatId)?.controller === controller) this.active.delete(chatId);
      }
    })();
    this.active.set(chatId, { controller, loop });
    this.loops.add(loop);
    void loop.then(
      () => this.loops.delete(loop),
      () => this.loops.delete(loop),
    );
  }

  /** Sends the indicator now, then again after each interval, until stopped. */
  private async type(chatId: string, target: number, controller: AbortController): Promise<void> {
    let next = this.clock();
    let warned = false;
    while (!controller.signal.aborted && !this.stopped) {
      const wait = next - this.clock();
      if (wait > 0) await this.wait(wait, controller.signal);
      if (controller.signal.aborted || this.stopped) return;
      try {
        await this.api.sendChatAction({ chatId: target, action: "typing", signal: controller.signal });
      } catch (error) {
        if (!controller.signal.aborted && !this.stopped && !warned) {
          warned = true;
          void this.log(`could not show typing in chat ${chatId}: ${messageOf(error)}`).catch(() => undefined);
        }
      }
      next = this.clock() + this.intervalMs;
    }
  }

  /** Ends the indicator of one chat and waits for its loop to finish. */
  private async stopTyping(chatId: string): Promise<void> {
    const typing = this.active.get(chatId);
    if (typing === undefined) return;
    this.active.delete(chatId);
    typing.controller.abort();
    await typing.loop;
  }

  private async log(message: string): Promise<void> {
    await this.ctx.logger.write(message);
  }
}
