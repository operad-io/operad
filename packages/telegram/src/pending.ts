/**
 * The pending side of the Telegram plugin: what waits for a person goes to
 * Telegram as one message per item, with one button per option.
 *
 * What is sent (ADR 0033 D7): an item waiting in a chat bound to Telegram goes
 * to that Telegram chat; an item of a plugin listed in the `pending` setting
 * goes to every listed user; nothing else. The plugin reads the items from the
 * client API's `pending()` whenever `events()` wakes it, and answers through the
 * same client: `act` for an item an action backs, `answer` for a wait no action
 * backs. Both carry the actor `{ via: "telegram", id }`, and only a listed
 * user's tap or reply counts. A second answer is refused by the client, which
 * is what keeps an answer to one item single; this side only reports it.
 *
 * An action that needs a note, and a free answer, are answered by replying to
 * the item's message. After an answer, from Telegram or anywhere else, the
 * buttons go and the message reads "answered: X".
 */

import { CHAT_TYPE, chatData } from "@operad-io/chat";
import {
  messageOf,
  type Actor,
  type ClientApi,
  type PendingItem,
  type SourceContext,
  type ViewAction,
} from "@operad-io/engine";
import { BotApiError, type BotApi, type InlineButton, type TelegramCallback, type TelegramMessage } from "./api.ts";
import { telegramChatsOf } from "./replies.ts";
import { telegramSettings, type TelegramSettings } from "./settings.ts";
import { readPending, writePending, type PendingState, type SentItem, type SentOption } from "./state.ts";

/** The `via` of every answer this plugin gives. */
const VIA = "telegram";

/** The longest item text sent; Telegram's own limit is 4096 characters. */
const TEXT_MAX = 3_500;

/** What the source asks of the pending side for a tap or a reply. */
export interface PendingResponder {
  /** A tap on a button; true when the tap belonged to a pending item message. */
  handleCallback(callback: TelegramCallback): Promise<boolean>;
  /** A reply to a message; true when the reply answered (or tried to answer) a pending item. */
  handleReply(message: TelegramMessage): Promise<boolean>;
}

export interface PendingSenderOptions {
  readonly api: BotApi;
  readonly clock?: (() => number) | undefined;
}

/** The data a button carries: its option's position on the message. */
function buttonData(index: number): string {
  return `o:${index}`;
}

function stateKey(item: { readonly runId: string; readonly waitId?: string | undefined }, chatId: number): string {
  return `${item.runId}/${item.waitId ?? ""}/${chatId}`;
}

function itemKey(item: { readonly runId: string; readonly waitId?: string | undefined }): string {
  return `${item.runId}/${item.waitId ?? ""}`;
}

/** The part of a state key that names the item, without the Telegram chat. */
function itemKeyOf(key: string): string {
  return key.slice(0, key.lastIndexOf("/"));
}

export class PendingSender implements PendingResponder {
  private readonly ctx: SourceContext;
  private readonly api: BotApi;
  private readonly client: ClientApi;
  private readonly clock: () => number;
  private readonly settings: TelegramSettings;
  private readonly controller = new AbortController();
  private state: PendingState;
  private stopped = false;
  private watching: Promise<void> = Promise.resolve();
  /** Everything that reads or writes the state runs one at a time. */
  private tail: Promise<unknown> = Promise.resolve();
  private queued = false;

  constructor(ctx: SourceContext, options: PendingSenderOptions) {
    this.ctx = ctx;
    this.api = options.api;
    this.client = ctx.client;
    this.clock = options.clock ?? ctx.clock;
    this.settings = telegramSettings(ctx.settings);
    this.state = readPending(ctx.home);
    if (ctx.signal.aborted) this.controller.abort();
    else ctx.signal.addEventListener("abort", () => this.controller.abort(), { once: true });
  }

  /** Sends what waits now, then follows the client's events. */
  start(): { readonly stop: () => Promise<void>; readonly ready: Promise<void> } {
    const iterator = this.client.events()[Symbol.asyncIterator]();
    const initial = this.sync();
    this.watching = (async () => {
      await initial;
      while (!this.stopped) {
        const next = await iterator.next();
        if (next.done === true || this.stopped) return;
        void this.sync();
      }
    })();
    return {
      ready: initial,
      stop: async () => {
        this.stopped = true;
        this.controller.abort();
        await iterator.return?.();
        await this.watching.catch(() => undefined);
        await this.tail.catch(() => undefined);
      },
    };
  }

  /**
   * One pass: send every item that waits and was not sent, and change the
   * message of every sent item that no longer waits. Passes run one at a time;
   * a pass asked for while one runs is done once after it.
   */
  sync(): Promise<void> {
    if (this.queued) return this.tail.then(() => undefined);
    this.queued = true;
    const run = this.tail.catch(() => undefined).then(async () => {
      this.queued = false;
      if (this.stopped) return;
      try {
        await this.pass();
      } catch (error) {
        await this.ctx.logger.write(`could not send pending items: ${messageOf(error)}`);
      }
    });
    this.tail = run;
    return run;
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.catch(() => undefined).then(work);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async pass(): Promise<void> {
    const items = await this.client.pending();
    const waiting = new Set<string>();
    for (const item of items) {
      if (!this.answerable(item)) continue;
      waiting.add(itemKey(item));
      const targets = await this.targetsOf(item);
      const fresh = targets.filter((chatId) => this.state[stateKey(item, chatId)] === undefined);
      if (fresh.length === 0) continue;
      const built = await this.build(item);
      if (built === undefined) continue;
      for (const chatId of fresh) {
        if (this.stopped) return;
        await this.send(item, chatId, built.text, built.options);
      }
    }
    for (const [key, sent] of Object.entries(this.state)) {
      if (this.stopped) return;
      if (sent.answered !== undefined || waiting.has(itemKeyOf(key))) continue;
      await this.settle(key, sent, await this.answeredWith(sent));
    }
  }

  /** An item a person can answer here: it names a question, or an object to act on. */
  private answerable(item: PendingItem): boolean {
    if (item.kind === "candidate" || item.kind === "refused") return false;
    if (item.announce === false) return false;
    return item.waitId !== undefined || (item.object !== undefined && item.actions.length > 0);
  }

  /** The Telegram chats an item goes to: its bound chat, and every listed user when its plugin is listed. */
  private async targetsOf(item: PendingItem): Promise<readonly number[]> {
    const targets = new Set<number>();
    if (item.object?.startsWith("chat:") === true) {
      const stored = await this.ctx.store.get(CHAT_TYPE, item.object.slice("chat:".length));
      if (stored !== undefined) {
        for (const chatId of telegramChatsOf(chatData(stored.data).channels)) targets.add(chatId);
      }
    }
    const listed = this.settings.pending;
    const ofListed =
      item.actions.some((action) => listed.includes(action.plugin)) ||
      (item.kind === "standing" && listed.includes(item.flow));
    if (ofListed) for (const user of this.settings.users) targets.add(user);
    return [...targets];
  }

  /** The text of an item's message and what it offers. */
  private async build(item: PendingItem): Promise<{ readonly text: string; readonly options: readonly SentOption[] } | undefined> {
    const infos = await this.actionsOf(item);
    const names = item.choices.length > 0 ? item.choices : item.actions.map((action) => action.action);
    const options: SentOption[] = [];
    for (const name of names) {
      if (options.some((option) => option.label === name)) continue;
      const action = item.actions.find((candidate) => candidate.action === name);
      if (action !== undefined && item.object !== undefined) {
        const info = infos.find((candidate) => candidate.plugin === action.plugin && candidate.action === action.action);
        options.push({
          label: name,
          how: "act",
          action: `${action.plugin}:${action.action}`,
          ...(info?.noteRequired === true ? { note: true as const } : {}),
        });
      } else if (item.waitId !== undefined && item.choices.length > 0) {
        options.push({ label: name, how: "choice" });
      }
    }
    if (options.length === 0 && item.waitId !== undefined) options.push({ label: "answer", how: "free", note: true });
    if (options.length === 0) return undefined;

    const lines: string[] = [];
    const title = item.row?.title;
    if (title !== undefined && title.length > 0 && !item.prompt.includes(title)) lines.push(title);
    lines.push(item.prompt);
    for (const option of options) {
      if (option.note !== true) continue;
      lines.push(
        option.how === "free"
          ? "Reply to this message with your answer."
          : `Reply to this message to ${option.label}; your reply is the note.`,
      );
    }
    const text = lines.join("\n\n");
    return { text: text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}…` : text, options };
  }

  /** The actions an item's object offers, with what each needs; none when they cannot be read. */
  private async actionsOf(item: PendingItem): Promise<readonly ViewAction[]> {
    if (item.object === undefined) return [];
    try {
      return (await this.client.get(item.object)).actions;
    } catch {
      return [];
    }
  }

  private async send(item: PendingItem, chatId: number, text: string, options: readonly SentOption[]): Promise<void> {
    const keyboard: InlineButton[][] = [];
    options.forEach((option, index) => {
      if (option.note !== true) keyboard.push([{ text: option.label, data: buttonData(index) }]);
    });
    let messageId: number;
    try {
      messageId = await this.api.sendMessage({
        chatId,
        text,
        ...(keyboard.length === 0 ? {} : { keyboard }),
        signal: this.controller.signal,
      });
    } catch (error) {
      if (this.stopped) return;
      await this.ctx.logger.write(`could not send pending item ${item.runId} to ${chatId}: ${messageOf(error)}`);
      return;
    }
    this.remember(stateKey(item, chatId), {
      runId: item.runId,
      ...(item.waitId === undefined ? {} : { waitId: item.waitId }),
      ...(item.object === undefined ? {} : { object: item.object }),
      chatId,
      messageId,
      text,
      options,
      at: this.clock(),
    });
  }

  /** What an item answered somewhere else was answered with: the latest action run on its object since it was sent. */
  private async answeredWith(sent: SentItem): Promise<string | undefined> {
    if (sent.object === undefined) return undefined;
    const split = sent.object.indexOf(":");
    if (split <= 0) return undefined;
    const ref = { type: sent.object.slice(0, split), id: sent.object.slice(split + 1) };
    let latest: string | undefined;
    try {
      let cursor: string | undefined;
      do {
        const page = this.ctx.store.facts(ref, cursor === undefined ? {} : { cursor });
        for (const fact of page.facts) {
          if (fact.type !== "action_invoked" || fact.at < sent.at) continue;
          const action = fact.data.action;
          if (typeof action !== "string") continue;
          const name = action.slice(action.lastIndexOf("/") + 1);
          if (sent.options.some((option) => option.label === name)) latest = name;
        }
        cursor = page.next;
      } while (cursor !== undefined);
    } catch {
      return undefined;
    }
    if (latest !== undefined) return latest;
    return this.chosenIn(sent);
  }

  /** The choice a question was answered with, from the object's history ("you chose X"), when no action shows it. */
  private async chosenIn(sent: SentItem): Promise<string | undefined> {
    if (sent.object === undefined || sent.waitId === undefined) return undefined;
    let markdown: string;
    try {
      markdown = (await this.client.section(sent.object, "history")).markdown;
    } catch {
      return undefined;
    }
    const labels = sent.options.filter((option) => option.how === "choice").map((option) => option.label);
    let chosen: string | undefined;
    for (const line of markdown.split("\n")) {
      const at = line.indexOf("you chose ");
      if (at < 0) continue;
      const rest = line.slice(at + "you chose ".length);
      const found = labels.find((label) => rest.startsWith(label) && !/^\w/.test(rest.slice(label.length)));
      if (found !== undefined) chosen = found;
    }
    return chosen;
  }

  /** Changes the other copies of an item that was answered in one chat, with the same words. */
  private async settleSiblings(key: string, label: string): Promise<void> {
    for (const [other, copy] of Object.entries(this.state)) {
      if (other === key || copy.answered !== undefined || itemKeyOf(other) !== itemKeyOf(key)) continue;
      await this.settle(other, copy, label);
    }
  }

  /** Changes the message of an answered item: the buttons go, the text ends "answered: X". */
  private async settle(key: string, sent: SentItem, label: string | undefined): Promise<void> {
    const words = label === undefined ? "answered" : `answered: ${label}`;
    try {
      await this.api.editMessage({
        chatId: sent.chatId,
        messageId: sent.messageId,
        text: `${sent.text}\n\n${words}`,
        signal: this.controller.signal,
      });
    } catch (error) {
      if (this.stopped) return;
      await this.ctx.logger.write(`could not change the message of pending item ${sent.runId}: ${messageOf(error)}`);
    }
    this.remember(key, { ...sent, answered: label ?? "answered" });
  }

  private remember(key: string, item: SentItem): void {
    this.state = { ...this.state, [key]: item };
    writePending(this.ctx.home, this.state);
  }

  private find(chatId: number, messageId: number): { readonly key: string; readonly sent: SentItem } | undefined {
    for (const [key, sent] of Object.entries(this.state)) {
      if (sent.chatId === chatId && sent.messageId === messageId) return { key, sent };
    }
    return undefined;
  }

  private listed(userId: number | undefined): userId is number {
    return userId !== undefined && this.settings.users.includes(userId);
  }

  async handleCallback(callback: TelegramCallback): Promise<boolean> {
    const message = callback.message;
    if (message === undefined) {
      // Telegram shows a spinner on the button until the tap is answered.
      await this.tell(callback.id, undefined);
      return false;
    }
    return this.exclusive(async () => {
      const found = this.find(message.chat.id, message.message_id);
      if (found === undefined) {
        await this.tell(callback.id, undefined);
        return false;
      }
      // Only a listed user's tap counts; nobody else is told anything.
      if (!this.listed(callback.from.id)) {
        await this.tell(callback.id, undefined);
        return true;
      }
      const { key, sent } = found;
      if (sent.answered !== undefined) {
        await this.tell(callback.id, `already answered: ${sent.answered}`);
        return true;
      }
      const index = /^o:(\d+)$/.exec(callback.data ?? "")?.[1];
      const option = index === undefined ? undefined : sent.options[Number(index)];
      if (option === undefined || option.note === true) {
        await this.tell(callback.id, "this button is no longer valid");
        return true;
      }
      const refusal = await this.answer(sent, option, { via: VIA, id: String(callback.from.id) }, undefined);
      if (refusal === undefined) {
        await this.settle(key, sent, option.label);
        await this.settleSiblings(key, option.label);
        await this.tell(callback.id, undefined);
      } else {
        await this.tell(callback.id, refusal);
        // The client refused: if the item was answered elsewhere the message follows.
        await this.pass().catch(() => undefined);
      }
      return true;
    });
  }

  async handleReply(message: TelegramMessage): Promise<boolean> {
    const to = message.reply_to_message?.message_id;
    const text = (message.text ?? message.caption ?? "").trim();
    if (to === undefined || text.length === 0) return false;
    return this.exclusive(async () => {
      const found = this.find(message.chat.id, to);
      if (found === undefined || !this.listed(message.from?.id)) return false;
      const { key, sent } = found;
      const noted = sent.options.filter((option) => option.note === true);
      // A reply to an item with nothing to say in a reply is an ordinary message.
      if (noted.length === 0) return false;
      const reply = (words: string): Promise<number> =>
        this.api.sendMessage({ chatId: message.chat.id, text: words, signal: this.controller.signal });
      if (sent.answered !== undefined) {
        await reply(`already answered: ${sent.answered}`).catch(() => undefined);
        return true;
      }
      let option = noted[0];
      let note = text;
      if (noted.length > 1) {
        const named = noted.find((candidate) => text.toLowerCase().startsWith(`${candidate.label.toLowerCase()}:`));
        if (named === undefined) {
          const names = noted.map((candidate) => `"${candidate.label}:"`).join(" or ");
          await reply(`Start your reply with ${names}, then your note.`).catch(() => undefined);
          return true;
        }
        option = named;
        note = text.slice(named.label.length + 1).trim();
      }
      if (option === undefined) return false;
      const refusal = await this.answer(sent, option, { via: VIA, id: String(message.from?.id) }, note);
      if (refusal === undefined) {
        const words = option.how === "free" ? note : option.label;
        await this.settle(key, sent, words);
        await this.settleSiblings(key, words);
      } else {
        await reply(refusal).catch(() => undefined);
        await this.pass().catch(() => undefined);
      }
      return true;
    });
  }

  /** Gives the answer through the client; the refusal in words, or undefined when it was taken. */
  private async answer(sent: SentItem, option: SentOption, actor: Actor, note: string | undefined): Promise<string | undefined> {
    try {
      if (option.how === "act") {
        if (sent.object === undefined || option.action === undefined) return "this item has no object to act on";
        await this.client.act(option.action, sent.object, {
          ...(note === undefined ? {} : { note }),
          // A tap on the button of an action that asks to confirm is the confirmation.
          yes: true,
          actor,
        });
      } else {
        if (sent.waitId === undefined) return "this item names no question";
        await this.client.answer({
          runId: sent.runId,
          waitId: sent.waitId,
          choice: option.how === "free" ? (note ?? "") : option.label,
          ...(option.how === "choice" && note !== undefined ? { note } : {}),
          actor,
        });
      }
      return undefined;
    } catch (error) {
      return messageOf(error);
    }
  }

  private async tell(callbackId: string, text: string | undefined): Promise<void> {
    try {
      await this.api.answerCallback({ callbackId, ...(text === undefined ? {} : { text }), signal: this.controller.signal });
    } catch (error) {
      if (error instanceof BotApiError || !this.stopped) {
        await this.ctx.logger.write(`could not answer a tap: ${messageOf(error)}`);
      }
    }
  }
}
