/**
 * The progress side of the Telegram plugin: while a reply runs, one message is
 * edited to the unfinished part of the chat's transcript, the text being
 * written and the tool calls in progress.
 *
 * It wakes on the client API's `events()`, names a bound chat and reads its
 * transcript section with `after`, the way a client does (ADR 0019); the
 * unfinished `tail` is what it shows, with a last line made from the section's
 * `status` (what the reply is doing and for how long). The first status or tail
 * creates the message. Edits happen at most once every two seconds per chat and
 * only when the reduced Markdown changed. When the reply
 * is recorded, the reply side sends the final reply as new message(s) first and
 * this side deletes the progress message. A failed edit is only logged; it
 * never stops the final reply. What is remembered in `<home>/telegram/` is the
 * message id, so a restart can delete a message a killed serve left behind.
 */

import { CHAT_TYPE, TRANSCRIPT, allEntries, allMessages, chatData } from "@operad-io/chat";
import { messageOf, type SourceContext } from "@operad-io/engine";
import { BotApiError, type BotApi } from "./api.ts";
import { progressStatusLine, telegramProgress, type TelegramChunk } from "./format.ts";
import { telegramChatsOf } from "./replies.ts";
import { delay } from "./source.ts";
import { readProgress, writeProgress, type ProgressRecord, type ProgressState } from "./state.ts";

/** How often one chat's progress message may be edited. */
export const PROGRESS_INTERVAL_MS = 2_000;

/** What finishes a reply: the reply side sends the final messages before the progress message goes. */
export interface ReplySweeper {
  sweepChat(chatId: string): Promise<void>;
}

export interface ProgressSenderOptions {
  readonly api: BotApi;
  readonly replies?: ReplySweeper | undefined;
  readonly clock?: (() => number) | undefined;
  readonly intervalMs?: number | undefined;
  /** Waits `ms` unless `signal` aborts first; a test gives one it moves itself. */
  readonly wait?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
}

/** One chat's progress message and when it may next be changed. */
interface ChatProgress {
  target: number | undefined;
  messageId: number | undefined;
  /** The reduced Markdown last taken by Telegram, so an unchanged text is not edited. */
  text: string | undefined;
  nextAt: number;
  dirty: boolean;
  timer: AbortController | undefined;
}

/** Whether the last person's message already has a reply or a failure line after it. */
function answered(messages: readonly { readonly role: string; readonly sequence: number }[], entries: readonly { readonly kind: string; readonly sequence: number }[]): boolean {
  let lastUser = 0;
  for (const message of messages) {
    if (message.role === "user") lastUser = Math.max(lastUser, message.sequence);
  }
  if (messages.some((message) => message.role === "assistant" && message.sequence > lastUser)) return true;
  return entries.some((entry) => entry.kind === "failure" && entry.sequence > lastUser);
}

export class ProgressSender {
  private readonly ctx: SourceContext;
  private readonly api: BotApi;
  private readonly replies: ReplySweeper | undefined;
  private readonly clock: () => number;
  private readonly intervalMs: number;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly controller = new AbortController();
  private readonly chats = new Map<string, ChatProgress>();
  private readonly working = new Map<string, Promise<void>>();
  private readonly marks = new Map<string, string>();
  private state: ProgressState;
  private stopped = false;
  private iterator: AsyncIterator<{ readonly id: string }> | undefined;
  private watching: Promise<void> = Promise.resolve();

  constructor(ctx: SourceContext, options: ProgressSenderOptions) {
    this.ctx = ctx;
    this.api = options.api;
    this.replies = options.replies;
    this.clock = options.clock ?? ctx.clock;
    this.intervalMs = options.intervalMs ?? PROGRESS_INTERVAL_MS;
    this.wait = options.wait ?? delay;
    this.state = readProgress(ctx.home);
    if (ctx.signal.aborted) this.controller.abort();
    else ctx.signal.addEventListener("abort", () => this.controller.abort(), { once: true });
  }

  /** Deletes a message a killed serve left behind, then follows the client's events. */
  start(): { readonly stop: () => Promise<void>; readonly ready: Promise<void> } {
    const initial = this.cleanLeftovers().catch((error: unknown) =>
      this.log(`could not clean a progress message: ${messageOf(error)}`),
    );
    this.watching = (async () => {
      await initial;
      const iterator = this.ctx.client.events()[Symbol.asyncIterator]();
      this.iterator = iterator;
      try {
        while (!this.stopped) {
          const next = await iterator.next();
          if (next.done === true || this.stopped) return;
          const id = next.value.id;
          if (id.length > 0) this.wake(id);
        }
      } catch (error) {
        if (!this.stopped) await this.log(`could not follow changes for progress: ${messageOf(error)}`);
      } finally {
        if (this.iterator === iterator) this.iterator = undefined;
        try {
          await iterator.return?.();
        } catch {
          // A stream that failed may refuse to close; stop is still complete.
        }
      }
    })();
    return {
      ready: initial,
      stop: async () => {
        this.stopped = true;
        this.controller.abort();
        for (const chat of this.chats.values()) this.cancelTimer(chat);
        try {
          await this.iterator?.return?.();
        } catch {
          // The stream is already unusable; stopping is still complete.
        }
        await this.watching.catch(() => undefined);
        await Promise.all([...this.working.values()]);
      },
    };
  }

  /** Checks one chat now, as an event does; resolves when this check is over. */
  syncChat(chatId: string): Promise<void> {
    this.wake(chatId);
    return this.working.get(chatId) ?? Promise.resolve();
  }

  /** Waits for the checks asked so far. */
  async settled(): Promise<void> {
    await Promise.resolve();
    while (this.working.size > 0) {
      await Promise.all([...this.working.values()].map((work) => work.catch(() => undefined)));
    }
  }

  /** Deletes every recorded progress message; one Telegram refuses stays for the next start. */
  private async cleanLeftovers(): Promise<void> {
    const left: Record<string, ProgressRecord> = {};
    for (const [chatId, record] of Object.entries(this.state)) {
      if (this.stopped) return;
      try {
        await this.api.deleteMessage({
          chatId: record.target,
          messageId: record.messageId,
          signal: this.controller.signal,
        });
      } catch (error) {
        if (this.stopped) return;
        left[chatId] = record;
        await this.log(`could not delete a progress message in chat ${chatId}: ${messageOf(error)}`);
      }
    }
    this.state = left;
    writeProgress(this.ctx.home, this.state);
  }

  private chatOf(chatId: string): ChatProgress {
    const existing = this.chats.get(chatId);
    if (existing !== undefined) return existing;
    const created: ChatProgress = {
      target: undefined,
      messageId: undefined,
      text: undefined,
      nextAt: 0,
      dirty: false,
      timer: undefined,
    };
    this.chats.set(chatId, created);
    return created;
  }

  private wake(chatId: string): void {
    if (this.stopped) return;
    const chat = this.chatOf(chatId);
    chat.dirty = true;
    this.cancelTimer(chat);
    this.pump(chatId);
  }

  private pump(chatId: string): void {
    if (this.stopped || this.working.has(chatId)) return;
    const run = this.loop(chatId)
      .catch((error: unknown) => this.log(`could not show progress: ${messageOf(error)}`))
      .finally(() => {
        if (this.working.get(chatId) === run) this.working.delete(chatId);
        const chat = this.chatOf(chatId);
        if (chat.dirty && !this.stopped) this.pump(chatId);
      });
    this.working.set(chatId, run);
  }

  private async loop(chatId: string): Promise<void> {
    const chat = this.chatOf(chatId);
    while (!this.stopped && chat.dirty) {
      chat.dirty = false;
      await this.step(chatId, chat);
    }
  }

  private async step(chatId: string, chat: ChatProgress): Promise<void> {
    if (this.stopped) return;
    const stored = await this.ctx.store.get(CHAT_TYPE, chatId);
    if (stored === undefined) return;
    const target = telegramChatsOf(chatData(stored.data).channels)[0];
    if (target === undefined) return;
    chat.target = target;

    const messages = allMessages(this.ctx.store, chatId);
    const entries = allEntries(this.ctx.store, chatId);
    if (chat.messageId !== undefined && answered(messages, entries)) {
      await this.finish(chatId, chat, true);
      return;
    }

    const mark = this.marks.get(chatId);
    const section = await this.ctx.client.section(chatId, TRANSCRIPT, undefined, {
      ...(mark === undefined ? {} : { after: mark }),
    });
    if (section.mark !== undefined) this.marks.set(chatId, section.mark);
    const tail = section.tail;
    const status = section.status;
    const statusLine = status === undefined ? undefined : progressStatusLine(status, this.clock());
    if ((tail === undefined || tail.trim().length === 0) && statusLine === undefined) {
      if (chat.messageId !== undefined) {
        // A cancelled run may send no event at all: look again while it says
        // the run still goes on, and delete the message once it has ended.
        if (await this.running(chatId)) this.later(chatId, chat);
        else await this.finish(chatId, chat, false);
      }
      return;
    }
    const chunk = telegramProgress(tail ?? "", statusLine);
    if (chunk === undefined) {
      this.later(chatId, chat);
      return;
    }
    if (chat.messageId !== undefined && chat.text === chunk.html) {
      this.later(chatId, chat);
      return;
    }

    const now = this.clock();
    if (chat.messageId !== undefined && now < chat.nextAt) {
      this.schedule(chatId, chat, chat.nextAt - now);
      return;
    }
    await this.apply(chatId, chat, target, chunk);
    this.later(chatId, chat);
  }

  /** Looks again after the interval while a progress message is on the chat. */
  private later(chatId: string, chat: ChatProgress): void {
    if (chat.messageId === undefined) return;
    this.schedule(chatId, chat, this.intervalMs);
  }

  /** Whether the client still says a run works on the chat. */
  private async running(chatId: string): Promise<boolean> {
    try {
      const view = await this.ctx.client.get(chatId);
      return view.row.running === true;
    } catch {
      return false;
    }
  }

  private schedule(chatId: string, chat: ChatProgress, ms: number): void {
    if (chat.timer !== undefined || this.stopped) return;
    const timer = new AbortController();
    chat.timer = timer;
    void this.wait(Math.max(0, ms), timer.signal).then(
      () => {
        // A canceled timer is not a wake: its chat was already pumped or stopped.
        if (chat.timer !== timer) return;
        chat.timer = undefined;
        if (this.stopped) return;
        chat.dirty = true;
        this.pump(chatId);
      },
      () => {
        if (chat.timer === timer) chat.timer = undefined;
      },
    );
  }

  private cancelTimer(chat: ChatProgress): void {
    const timer = chat.timer;
    if (timer === undefined) return;
    chat.timer = undefined;
    timer.abort();
  }

  /** Sends the first progress message or edits the one that is there. */
  private async apply(chatId: string, chat: ChatProgress, target: number, chunk: TelegramChunk): Promise<void> {
    chat.nextAt = this.clock() + this.intervalMs;
    let plain = false;
    let creating = chat.messageId === undefined;
    for (let attempt = 1; !this.stopped; ) {
      try {
        if (creating) {
          chat.messageId = await this.api.sendMessage({
            chatId: target,
            text: plain ? chunk.plain : chunk.html,
            ...(plain ? {} : { parseMode: "HTML" as const }),
            signal: this.controller.signal,
          });
          creating = false;
        } else {
          const messageId = chat.messageId;
          if (messageId === undefined) return;
          await this.api.editMessage({
            chatId: target,
            messageId,
            text: plain ? chunk.plain : chunk.html,
            ...(plain ? {} : { parseMode: "HTML" as const }),
            signal: this.controller.signal,
          });
        }
        const messageId = chat.messageId;
        if (messageId === undefined) return;
        chat.target = target;
        chat.text = chunk.html;
        this.remember(chatId, { target, messageId, text: chunk.html });
        return;
      } catch (error) {
        if (this.stopped) return;
        if (error instanceof BotApiError && error.badMarkup && !plain) {
          plain = true;
          attempt -= 1;
          continue;
        }
        const asked = error instanceof BotApiError && error.retryAfterSecs !== undefined ? error.retryAfterSecs * 1_000 : 0;
        if (asked > 0 && attempt < 3) {
          const wait = Math.max(asked, chat.nextAt - this.clock());
          await this.wait(wait, this.controller.signal);
          chat.nextAt = this.clock() + this.intervalMs;
          attempt += 1;
          continue;
        }
        await this.log(`could not show progress in chat ${chatId}: ${messageOf(error)}`);
        return;
      }
    }
  }

  /** Sends the final reply first, then removes the progress message. */
  private async finish(chatId: string, chat: ChatProgress, final: boolean): Promise<void> {
    const messageId = chat.messageId;
    const target = chat.target;
    if (messageId === undefined || target === undefined) return;
    if (final && this.replies !== undefined) {
      try {
        await this.replies.sweepChat(chatId);
      } catch (error) {
        if (!this.stopped) await this.log(`could not send the final reply of chat ${chatId}: ${messageOf(error)}`);
      }
    }
    try {
      await this.api.deleteMessage({ chatId: target, messageId, signal: this.controller.signal });
    } catch (error) {
      if (this.stopped) return;
      await this.log(`could not delete the progress message of chat ${chatId}: ${messageOf(error)}`);
      return;
    }
    chat.messageId = undefined;
    chat.target = undefined;
    chat.text = undefined;
    this.forget(chatId);
  }

  private remember(chatId: string, record: ProgressRecord): void {
    this.state = { ...this.state, [chatId]: record };
    writeProgress(this.ctx.home, this.state);
  }

  /** Forgets a chat's record after its message is deleted. */
  private forget(chatId: string): void {
    const { [chatId]: _gone, ...rest } = this.state;
    this.state = rest;
    writeProgress(this.ctx.home, this.state);
  }

  private async log(message: string): Promise<void> {
    await this.ctx.logger.write(message);
  }
}
