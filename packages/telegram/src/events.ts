/**
 * The one place the Telegram plugin follows the client API's changes.
 *
 * Every sender used to keep its own `events()` loop and woke on any id without
 * looking at the event, so one running reply woke all of them. Here the stream
 * is read once and each event goes only where it can matter: a live section's
 * tail goes only to the progress side, a stored change goes to the ones that
 * read stored objects, and a chat's change also wakes the source's dedupe
 * memory. A failure is retried on the injected wait, as the typing side did.
 */

import { CHAT_TYPE, TRANSCRIPT } from "@operad-io/chat";
import { messageOf, type SourceContext } from "@operad-io/engine";
import { delay } from "./source.ts";

/** The part of a client event this plugin reads, without importing the host's view type. */
export interface TelegramEvent {
  readonly id: string;
  readonly type?: string | undefined;
  readonly section?: string | undefined;
  readonly tail?: string | undefined;
  readonly status?: { readonly text: string; readonly since: number } | undefined;
}

/** How long to wait before following the client's events again after a failure. */
export const EVENT_RETRY_MS = 1_000;

/** What the one event loop tells each part of the plugin. */
export interface EventSinks {
  /** A live `transcript` tail, or a stored change of a chat with a progress message. */
  readonly progress?: ((event: TelegramEvent) => void) | undefined;
  /** A stored change of a chat bound to Telegram. */
  readonly replies?: ((event: TelegramEvent) => void) | undefined;
  /** A stored change of a chat bound to Telegram. */
  readonly typing?: ((event: TelegramEvent) => void) | undefined;
  /** Any stored change; pending items can be about any object. */
  readonly pending?: ((event: TelegramEvent) => void) | undefined;
  /** A stored change, for the command menu. */
  readonly commands?: (() => void) | undefined;
  /** A chat whose stored state changed, for the source's dedupe memory. */
  readonly source?: ((chatId: string) => void) | undefined;
}

export interface TelegramEventsOptions {
  /** Waits `ms` unless `signal` aborts first; a test gives one it moves itself. */
  readonly wait?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
}

export class TelegramEvents {
  private readonly ctx: SourceContext;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly controller = new AbortController();
  private iterator: AsyncIterator<TelegramEvent> | undefined;
  private stopped = false;
  private watching: Promise<void> = Promise.resolve();

  constructor(ctx: SourceContext, options: TelegramEventsOptions = {}) {
    this.ctx = ctx;
    this.wait = options.wait ?? delay;
    if (ctx.signal.aborted) this.controller.abort();
    else ctx.signal.addEventListener("abort", () => this.controller.abort(), { once: true });
  }

  /** Follows the client's changes until stopped, taking the stream again after a failure. */
  start(sinks: EventSinks): { readonly ready: Promise<void>; readonly stop: () => Promise<void> } {
    this.watching = this.follow(sinks);
    return {
      ready: Promise.resolve(),
      stop: async () => {
        this.stopped = true;
        this.controller.abort();
        try {
          await this.iterator?.return?.();
        } catch {
          // The stream is already unusable; stopping is still complete.
        }
        await this.watching.catch(() => undefined);
      },
    };
  }

  private async follow(sinks: EventSinks): Promise<void> {
    while (!this.stopped) {
      let iterator: AsyncIterator<TelegramEvent> | undefined;
      try {
        // A client that refuses the stream synchronously is a failure like any
        // other: log it, wait, and take the stream again.
        iterator = this.ctx.client.events()[Symbol.asyncIterator]();
        this.iterator = iterator;
        while (!this.stopped) {
          const next = await iterator.next();
          if (next.done === true || this.stopped) return;
          this.dispatch(next.value, sinks);
        }
      } catch (error) {
        if (this.stopped) return;
        void this.ctx.logger.write(`could not follow changes: ${messageOf(error)}`).catch(() => undefined);
        await this.wait(EVENT_RETRY_MS, this.controller.signal).catch(() => undefined);
      } finally {
        if (iterator === undefined) continue;
        if (this.iterator === iterator) this.iterator = undefined;
        try {
          await iterator.return?.();
        } catch {
          // A stream that failed may refuse to close; the next stream is new.
        }
      }
    }
  }

  private dispatch(event: TelegramEvent, sinks: EventSinks): void {
    if (event.id.length === 0) return;
    if (event.section !== undefined) {
      // A live tail is not a stored change; only the progress side reads it.
      if (event.section === TRANSCRIPT && (event.type === undefined || event.type === CHAT_TYPE)) {
        sinks.progress?.(event);
      }
      return;
    }
    sinks.pending?.(event);
    sinks.commands?.();
    const isChat =
      event.type === CHAT_TYPE ||
      (event.type === undefined && this.ctx.store.objectTypesOf(event.id).includes(CHAT_TYPE));
    if (!isChat) return;
    sinks.replies?.(event);
    sinks.typing?.(event);
    sinks.progress?.(event);
    sinks.source?.(event.id);
  }
}
