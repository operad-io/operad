/**
 * The source side of the Telegram plugin: long-polls `getUpdates` and turns a
 * private message from a listed user into one user message on that user's bound
 * chat. A message from anyone else is recorded and starts nothing.
 *
 * Dedupe is never the offset. Every update is recorded once as
 * `telegram/update` keyed by its `update_id`, but what keeps a resent update
 * from writing a second message is the bound chat itself: a message is written
 * only when no message of a chat bound to this Telegram chat has a source ref
 * equal to the update id. The settings (`users`, `bot`) are read once, when
 * the source starts.
 */

import {
  CHAT_TYPE,
  MESSAGE_EVENT,
  allMessages,
  chatData,
  parseCommand,
  titleFromMessage,
} from "@operad-io/chat";
import { messageOf, type SourceContext, type SourceHandle } from "@operad-io/engine";
import type { BotApi, TelegramMessage, TelegramUpdate } from "./api.ts";
import { stripBotName, PENDING_COMMAND, type CommandResponder } from "./commands.ts";
import type { PendingResponder } from "./pending.ts";
import { telegramSettings } from "./settings.ts";
import { readOffset, writeOffset } from "./state.ts";

/** The event type the source records an incoming update as. */
export const UPDATE_EVENT = "update";

/** The source of every event this plugin sends. */
export const TELEGRAM_SOURCE = "telegram";

/** The reaction that says a message was received. */
export const RECEIVED_REACTION = "👀";

/** The longest summary an update event carries. */
const SUMMARY_MAX = 300;

/** A delay that ends early when the signal is aborted. */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** What the source asks of the typing side: show an indicator on receipt. */
export interface TypingResponder {
  /** Starts the indicator for an accepted message before its run is reported. */
  received(chatId: string, target: number): void;
}

export interface TelegramSourceOptions {
  readonly api: BotApi;
  readonly clock?: (() => number) | undefined;
  /** How long Telegram may hold a long poll open. */
  readonly longPollSecs?: number | undefined;
  /** The pause between two polls once one returns. */
  readonly pollIntervalMs?: number | undefined;
  readonly wait?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
  /** Takes the taps on pending items' buttons and the replies to their messages. */
  readonly pending?: PendingResponder | undefined;
  /** Takes a command's text, the greeting `/start` and the taps on a command's choices. */
  readonly commands?: CommandResponder | undefined;
  /** Shows typing as soon as an ordinary message is accepted. */
  readonly typing?: TypingResponder | undefined;
}

/** One bound chat and whether it still takes messages. */
export interface BoundChat {
  readonly id: string;
  readonly closed: boolean;
}

/** Every chat bound to Telegram, or to one channel, newest first. */
export async function boundChats(
  ctx: Pick<SourceContext, "store">,
  channel?: string,
): Promise<readonly BoundChat[]> {
  const found: BoundChat[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.store.list(CHAT_TYPE, {
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const object of page.objects) {
      const data = chatData(object.data);
      if (channel !== undefined && !data.channels.includes(channel)) continue;
      if (channel === undefined && data.channels.length === 0) continue;
      found.push({ id: object.id, closed: data.closed });
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return found.sort((left, right) => right.id.localeCompare(left.id));
}

/** The message text the source reads: text, else a caption. */
function messageText(message: TelegramMessage): string | undefined {
  const text = (message.text ?? message.caption ?? "").trim();
  return text.length === 0 ? undefined : text;
}

function summaryOf(message: TelegramMessage | undefined): string | undefined {
  if (message === undefined) return undefined;
  const text = messageText(message);
  if (text === undefined) return undefined;
  const first = text.split(/\r?\n/)[0]?.trim() ?? "";
  return first.length === 0 ? undefined : first.slice(0, SUMMARY_MAX);
}

/** The channel a Telegram chat binds a chat by. */
export function telegramChannel(chatId: string | number): string {
  return `${TELEGRAM_SOURCE}:${chatId}`;
}

export class TelegramSource {
  private readonly ctx: SourceContext;
  private readonly api: BotApi;
  private readonly clock: () => number;
  private readonly longPollSecs: number;
  private readonly pollIntervalMs: number;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly controller = new AbortController();
  private readonly pending: PendingResponder | undefined;
  private readonly commands: CommandResponder | undefined;
  private readonly typing: TypingResponder | undefined;
  private readonly users: readonly number[];
  private readonly bot: string;

  constructor(ctx: SourceContext, options: TelegramSourceOptions) {
    this.ctx = ctx;
    this.api = options.api;
    this.clock = options.clock ?? ctx.clock;
    this.longPollSecs = options.longPollSecs ?? 30;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.wait = options.wait ?? delay;
    this.pending = options.pending;
    this.commands = options.commands;
    this.typing = options.typing;
    const settings = telegramSettings(ctx.settings);
    this.users = settings.users;
    this.bot = settings.bot;
    if (ctx.signal.aborted) this.controller.abort();
    else ctx.signal.addEventListener("abort", () => this.controller.abort(), { once: true });
  }

  /** Reads every update after the recorded offset once and handles it. */
  async poll(): Promise<readonly TelegramUpdate[]> {
    const offset = readOffset(this.ctx.home);
    const updates = await this.api.getUpdates({
      offset,
      timeoutSecs: this.longPollSecs,
      signal: this.controller.signal,
    });
    // One update that cannot be handled is logged and does not stop the ones
    // after it. The offset confirms only the updates before the first failure,
    // so the failed one is read again; the event key keeps the rest one.
    let confirmed = offset;
    let blocked = false;
    for (const update of updates) {
      try {
        await this.handle(update);
        if (!blocked) confirmed = update.update_id + 1;
      } catch (error) {
        blocked = true;
        await this.ctx.logger.write(`update ${update.update_id}: ${messageOf(error)}`);
      }
    }
    if (confirmed > offset) writeOffset(this.ctx.home, confirmed, this.clock());
    return updates;
  }

  /** The long-poll loop; `stop` ends it and aborts a request in flight. */
  start(): SourceHandle {
    let stopped = false;
    const loop = async (): Promise<void> => {
      while (!stopped && !this.controller.signal.aborted) {
        try {
          await this.poll();
        } catch (error) {
          if (stopped || this.controller.signal.aborted) return;
          await this.ctx.logger.write(`could not read updates: ${messageOf(error)}`);
        }
        if (stopped || this.controller.signal.aborted) return;
        await this.wait(this.pollIntervalMs, this.controller.signal);
      }
    };
    void loop();
    return {
      stop: () => {
        stopped = true;
        this.controller.abort();
      },
    };
  }

  private async handle(update: TelegramUpdate): Promise<void> {
    const key = String(update.update_id);
    if (update.callback_query !== undefined) {
      // A tap is handled by the pending side or the command side; either way
      // it is recorded once.
      await this.pending?.handleCallback(update.callback_query);
      await this.commands?.handleCallback(update.callback_query);
      await this.record(key);
      return;
    }
    const message = update.message;
    if (message === undefined) {
      await this.record(key);
      return;
    }
    const summary = summaryOf(message);
    const from = message.from?.id;
    const listed = from !== undefined && this.users.includes(from);
    const raw = messageText(message);
    // A group, a channel, an unlisted sender or a message with no text is
    // recorded and stops there: no chat, no reply, nothing started. A command
    // from anyone else is dropped the same way, without a reply.
    if (message.chat.type !== "private" || !listed || raw === undefined) {
      await this.record(key, undefined, summary);
      return;
    }
    // `/model@operad_bot sonnet` is `/model sonnet`.
    const text = stripBotName(raw);

    // Telegram's own `/start` is a greeting that points at `/help`; it never
    // starts a reply and never needs a chat.
    if (this.commands !== undefined && (await this.commands.greet(text, message.chat.id))) {
      await this.record(key, undefined, summary);
      return;
    }

    // A reply to an item's message that takes a note is that item's answer;
    // a message that is not one is an ordinary message to the chat.
    if (this.pending !== undefined && message.reply_to_message !== undefined && (await this.pending.handleReply(message))) {
      await this.record(key, undefined, summary);
      return;
    }

    const channel = telegramChannel(message.chat.id);
    const bound = await this.boundChats(channel);
    for (const chat of bound) {
      const previous = this.messageFrom(chat.id, key);
      if (previous === undefined) continue;
      // The message is already written; recording the event sendMessage uses
      // again finishes a reply whose event was lost and starts nothing twice.
      if (!chat.closed) {
        await this.ctx.emit({
          source: TELEGRAM_SOURCE,
          type: MESSAGE_EVENT,
          key: previous.id,
          object: `chat:${previous.chatId}`,
        });
      }
      await this.record(key, previous.chatId, summary);
      return;
    }

    const open = bound.find((chat) => !chat.closed);
    const parsed = parseCommand(text);
    // A chat opened by a command is not titled by the command's text.
    const title = parsed === undefined ? text : undefined;
    const chatId = open?.id ?? (await this.openBoundChat(channel, title, from));
    const command =
      parsed === undefined || this.commands === undefined
        ? undefined
        : await this.commands.command(chatId, parsed.name);
    // A command that takes one choice and was sent without it answers with
    // its choices instead of running; a tap runs it as `/<name> <choice>`.
    if (
      command !== undefined &&
      this.commands !== undefined &&
      (await this.commands.offer(command, text, chatId, message.chat.id))
    ) {
      await this.record(key, chatId, summary);
      await this.commands.refresh(chatId);
      return;
    }
    // `/pending` holds the pending pass until its count line; a line that could
    // not be sent still lets the items it prepared go.
    const pendingCommand =
      command !== undefined && command.info.action === PENDING_COMMAND && command.info.plugin === TELEGRAM_SOURCE;
    try {
      const result = await this.ctx.client.act("chat:send", chatId, {
        args: { note: text, ref: key },
        actor: { via: TELEGRAM_SOURCE, id: String(from) },
      });
      // An ordinary message is acknowledged at once, before its run is reported.
      // A command's outcome is its answer, so it gets neither a reaction nor typing.
      if (command === undefined) {
        this.typing?.received(chatId, message.chat.id);
        await this.react(message);
      }
      // What a command returned is the answer the person who typed it sees; an
      // ordinary message's "sent ..." is not sent back.
      if (command !== undefined) {
        const outcome = typeof result.value === "string" && result.value.trim().length > 0 ? result.value : "done";
        await this.commands?.say(message.chat.id, outcome);
      }
    } finally {
      // `/pending` sends its count as a command's answer, then the items it prepared.
      if (pendingCommand) await this.pending?.show(message.chat.id);
    }
    await this.record(key, chatId, summary);
    if (command !== undefined || open === undefined) await this.commands?.refresh(chatId);
  }

  /** Marks an accepted message as received; a refusal is logged once and changes nothing else. */
  private async react(message: TelegramMessage): Promise<void> {
    try {
      await this.api.setMessageReaction({
        chatId: message.chat.id,
        messageId: message.message_id,
        reaction: RECEIVED_REACTION,
        signal: this.controller.signal,
      });
    } catch (error) {
      await this.ctx.logger.write(
        `could not react to message ${message.message_id}: ${messageOf(error)}`,
      );
    }
  }

  private async record(key: string, chatId?: string, summary?: string): Promise<void> {
    const event = {
      source: TELEGRAM_SOURCE,
      type: UPDATE_EVENT,
      key,
      ...(chatId === undefined ? {} : { object: `chat:${chatId}` }),
      ...(summary === undefined ? {} : { summary }),
    };
    await this.ctx.emit(event);
  }

  /** Every chat bound to this channel, newest first. */
  private boundChats(channel: string): Promise<readonly BoundChat[]> {
    return boundChats(this.ctx, channel);
  }

  /** The message already written for this update on a chat, if any. */
  private messageFrom(chatId: string, key: string): { readonly id: string; readonly chatId: string } | undefined {
    const found = allMessages(this.ctx.store, chatId).find(
      (message) =>
        message.role === "user" &&
        message.source.kind === TELEGRAM_SOURCE &&
        message.source.ref === key,
    );
    return found === undefined ? undefined : { id: found.id, chatId };
  }

  private async openBoundChat(channel: string, text: string | undefined, userId: number): Promise<string> {
    // A typed id: another plugin's type may hold an object under the same bare
    // id (the bot plugin's nightly tidy keeps one per bot), and a bare id is
    // then ambiguous.
    const bot = this.bot.startsWith("bot:") ? this.bot : `bot:${this.bot}`;
    const opened = await this.ctx.client.act("bot:chat", bot, {
      args: { title: (text === undefined ? undefined : titleFromMessage(text)) ?? "Telegram", channels: [channel] },
      actor: { via: TELEGRAM_SOURCE, id: String(userId) },
    });
    if (opened.opens === undefined || !opened.opens.startsWith("chat:")) {
      throw new Error("bot:chat opened no chat");
    }
    return opened.opens.slice("chat:".length);
  }
}
