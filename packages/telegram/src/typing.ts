/**
 * The typing side of the Telegram plugin: a chat bound to Telegram shows the
 * bot as typing while a reply run is writing one.
 *
 * It wakes on the client API's `events()`, which names a chat whenever it
 * changes, and asks the client API's `get()` whether a run is working on that
 * chat. It reads a bound chat's channels from the plugin's store, as the reply
 * side does. Telegram shows the indicator for about five seconds, so it is sent
 * again while the run is active; a failed send is not retried and is not
 * written to history.
 */

import { CHAT_TYPE, chatData } from "@operad-io/chat";
import { messageOf, type ClientApi, type SourceContext } from "@operad-io/engine";
import type { BotApi } from "./api.ts";
import { telegramChatsOf } from "./replies.ts";
import { delay } from "./source.ts";

/** How often the indicator is renewed; Telegram shows it for about five seconds. */
export const TYPING_INTERVAL_MS = 4_000;

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
  private readonly checks = new Map<string, Promise<void>>();
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
    const iterator = this.client.events()[Symbol.asyncIterator]();
    const initial = this.syncAll().catch((error: unknown) => this.log(`could not show typing: ${messageOf(error)}`));
    this.watching = (async () => {
      await initial;
      while (!this.stopped) {
        const next = await iterator.next();
        if (next.done === true || this.stopped) return;
        const id = next.value.id;
        if (id.length > 0) {
          void this.syncChat(id).catch((error: unknown) => this.log(`could not show typing: ${messageOf(error)}`));
        }
      }
    })();
    return {
      ready: initial,
      stop: async () => {
        this.stopped = true;
        this.controller.abort();
        for (const typing of this.active.values()) typing.controller.abort();
        await iterator.return?.();
        await this.watching.catch(() => undefined);
        await Promise.all([...this.checks.values()]);
        await Promise.all([...this.loops]);
      },
    };
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

  /** Shows or stops the indicator of one chat, as the reply run now stands. */
  syncChat(chatId: string): Promise<void> {
    const previous = this.checks.get(chatId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.check(chatId));
    const settled = run.catch(() => undefined);
    this.checks.set(chatId, settled);
    void settled.then(() => {
      if (this.checks.get(chatId) === settled) this.checks.delete(chatId);
    });
    return run;
  }

  private async check(chatId: string): Promise<void> {
    if (this.stopped) return;
    const stored = await this.ctx.store.get(CHAT_TYPE, chatId);
    if (stored === undefined) return;
    const target = telegramChatsOf(chatData(stored.data).channels)[0];
    if (target === undefined) return;
    let running: boolean;
    try {
      running = (await this.client.get(chatId)).row.running;
    } catch {
      await this.stopTyping(chatId);
      return;
    }
    if (this.stopped) return;
    if (!running) {
      await this.stopTyping(chatId);
      return;
    }
    this.startTyping(chatId, target);
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
          await this.log(`could not show typing in chat ${chatId}: ${messageOf(error)}`);
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
