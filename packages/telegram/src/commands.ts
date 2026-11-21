/**
 * The command side of the Telegram plugin: the bot's command menu, the
 * choices a command without its one choice offers, and the greeting `/start`
 * gets.
 *
 * The plugin handles no command's text. It registers the menu from the chat's
 * action declarations, sends a command's text through `chat:send` as any other
 * message (ADR 0037 D2), and, when a command that takes one choice arrives
 * without it, shows the choices as an inline keyboard. The tap is passed back
 * as `/<name> <choice>`, so the `chat` plugin remains the only place a command
 * runs. After a tap the keyboard goes and the message ends `chosen: X`, as an
 * answered pending item ends `answered: X`. The one action the plugin declares
 * is `/pending`, which prepares the items the source sends after its count line.
 */

import {
  CHAT_TYPE,
  chatCommands,
  chatData,
  findCommand,
  parseCommand,
  type ChatCommand,
} from "@operad-io/chat";
import {
  messageOf,
  type ActionTypeDefinition,
  type SourceContext,
} from "@operad-io/engine";
import {
  BotApiError,
  type BotApi,
  type BotCommand,
  type InlineButton,
  type TelegramCallback,
} from "./api.ts";
import { telegramChunks } from "./format.ts";
import { telegramSettings, type TelegramSettings } from "./settings.ts";
import { boundChats } from "./source.ts";
import {
  pruneCommands,
  readCommands,
  writeCommands,
  type CommandState,
  type SentCommand,
} from "./state.ts";

/** The source of every answer this plugin gives. */
const VIA = "telegram";

/** A name Telegram's menu takes: lowercase letters, digits and underscores, at most 32 characters. */
export const TELEGRAM_COMMAND_NAME = /^[a-z0-9_]{1,32}$/;

/** How many choices one keyboard page shows. */
export const COMMAND_PAGE_SIZE = 8;

/** The most commands Telegram takes in one menu. */
const MENU_MAX = 100;

/** The longest description Telegram takes for one command. */
const DESCRIPTION_MAX = 256;

/** What `/start` answers with. */
export const START_GREETING =
  "Hello. Write a message to start a chat; /help lists the commands you can type.";

/** The name `/pending` is typed by. */
export const PENDING_COMMAND = "pending";

/** What `/pending` says when nothing waits. */
export const PENDING_NOTHING = "nothing is waiting";

/** What the pending side does for `/pending`. */
export interface PendingCommandSender {
  /** The count line, with the item messages ready for the source's chat. */
  prepare(chatId: string, hold?: boolean): Promise<string>;
}

/**
 * The action `/pending` runs. It belongs to `telegram`, not `chat`: only the
 * channel can send the item messages with their buttons, and the chat plugin
 * knows no channel (ADR 0026 D1, ADR 0037 D4).
 */
export function pendingCommandAction(
  sender: () => PendingCommandSender | undefined,
): ActionTypeDefinition {
  const unavailable = "the telegram plugin is not running; /pending needs operad serve";
  return {
    name: PENDING_COMMAND,
    on: CHAT_TYPE,
    command: "Show what is waiting for a person now.",
    when: (state) => sender() !== undefined && !chatData(state).closed,
    why: (object) => {
      if (chatData(object.data).closed) return `${object.id} is closed; it takes no commands`;
      return sender() === undefined ? unavailable : undefined;
    },
    async run(ctx) {
      const current = sender();
      if (current === undefined) throw new Error(unavailable);
      // A Telegram command holds the pending pass until the source sent its count.
      return current.prepare(ctx.object.id, ctx.actor.via === "telegram");
    },
  };
}

/** What the source asks of the command side. */
export interface CommandResponder {
  /** Sends the greeting when the text is `/start`; true when it was. */
  greet(text: string, target: number): Promise<boolean>;
  /** The command this chat has by this name, or undefined. */
  command(chatId: string, name: string): Promise<ChatCommand | undefined>;
  /** Sends the choices of a command that gives none; true when the keyboard was sent. */
  offer(command: ChatCommand, text: string, chatId: string, target: number): Promise<boolean>;
  /** Sends what a command returned to the Telegram chat. */
  say(target: number, outcome: string): Promise<void>;
  /** A tap on one of the choice keyboards; true when it was one. */
  handleCallback(callback: TelegramCallback): Promise<boolean>;
  /** Registers the menu when the set of commands changed. */
  refresh(chatId?: string): Promise<void>;
}

export interface CommandSenderOptions {
  readonly api: BotApi;
}

/**
 * The text with a bot mention after the command's name taken away, so
 * `/model@operad_bot sonnet` is the same as `/model sonnet`.
 */
export function stripBotName(text: string): string {
  return text.replace(/^(\/[A-Za-z0-9_-]+)@[A-Za-z0-9_]+(?=\s|$)/, "$1");
}

/** The data a choice button carries: its position in the whole list. */
function choiceData(index: number): string {
  return `c:${index}`;
}

/** The data a paging button carries: the page it opens. */
function pageData(page: number): string {
  return `p:${page}`;
}

/** The rows of one page: its choices, then the way to the other pages. */
function keyboardFor(
  choices: readonly string[],
  page: number,
): readonly (readonly InlineButton[])[] {
  const start = page * COMMAND_PAGE_SIZE;
  const rows: InlineButton[][] = choices
    .slice(start, start + COMMAND_PAGE_SIZE)
    .map((choice, offset) => [{ text: choice, data: choiceData(start + offset) }]);
  const pages = Math.ceil(choices.length / COMMAND_PAGE_SIZE);
  if (pages > 1) {
    const arrows: InlineButton[] = [];
    if (page > 0) arrows.push({ text: "«", data: pageData(page - 1) });
    if (page + 1 < pages) arrows.push({ text: "»", data: pageData(page + 1) });
    rows.push(arrows);
  }
  return rows;
}

/** The one choice a command takes, when that is all it takes; empty otherwise. */
function choicesOf(command: ChatCommand): readonly string[] {
  const args = command.info.args;
  const names = Object.keys(args?.properties ?? {});
  if (names.length !== 1) return [];
  const name = names[0];
  if (name === undefined || !(args?.required ?? []).includes(name)) return [];
  const property = args?.properties?.[name];
  if (property?.enum === undefined) return [];
  return property.enum.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

/** The one line the menu shows for a command. */
function descriptionOf(command: ChatCommand): string {
  const text = (command.info.command ?? "").replace(/\s+/g, " ").trim();
  if (text.length === 0) return command.name;
  return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1)}…` : text;
}

/** The key one keyboard is remembered by. */
function keyOf(target: number, messageId: number): string {
  return `${target}/${messageId}`;
}

export class CommandSender implements CommandResponder {
  private readonly ctx: SourceContext;
  private readonly api: BotApi;
  private readonly settings: TelegramSettings;
  private readonly controller = new AbortController();
  private state: CommandState;
  private stopped = false;
  private watching: Promise<void> = Promise.resolve();
  /** Everything that reads or writes the state runs one at a time. */
  private tail: Promise<unknown> = Promise.resolve();
  private queued = false;
  /** The chat a refresh was last asked about; the newest bound chat when absent. */
  private hint: string | undefined;
  /** The menu last registered, so an unchanged set is not sent again. */
  private registered: string | undefined;

  constructor(ctx: SourceContext, options: CommandSenderOptions) {
    this.ctx = ctx;
    this.api = options.api;
    this.settings = telegramSettings(ctx.settings);
    this.state = readCommands(ctx.home);
    if (ctx.signal.aborted) this.controller.abort();
    else ctx.signal.addEventListener("abort", () => this.controller.abort(), { once: true });
  }

  /** Registers the menu now, then again whenever the client changes a chat. */
  start(): { readonly ready: Promise<void>; readonly stop: () => Promise<void> } {
    const iterator = this.ctx.client.events()[Symbol.asyncIterator]();
    const initial = this.refresh();
    this.watching = (async () => {
      await initial;
      while (!this.stopped) {
        const next = await iterator.next();
        if (next.done === true || this.stopped) return;
        void this.refresh();
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
   * Registers the menu when its set of commands changed. Passes run one at a
   * time; a pass asked for while one runs is done once after it.
   */
  refresh(chatId?: string): Promise<void> {
    this.hint = chatId ?? this.hint;
    if (this.queued) return this.tail.then(() => undefined);
    this.queued = true;
    const run = this.tail.catch(() => undefined).then(async () => {
      this.queued = false;
      const hint = this.hint;
      this.hint = undefined;
      if (this.stopped) return;
      try {
        await this.register(hint);
      } catch (error) {
        await this.ctx.logger.write(`could not set the command menu: ${messageOf(error)}`);
      }
    });
    this.tail = run;
    return run;
  }

  private async register(hint: string | undefined): Promise<void> {
    const chatId = hint ?? (await this.newestChat());
    if (chatId === undefined) return;
    const view = await this.ctx.client.get(`chat:${chatId}`);
    const commands: BotCommand[] = [];
    for (const command of chatCommands(view.actions)) {
      if (!TELEGRAM_COMMAND_NAME.test(command.name)) {
        await this.ctx.logger.write(
          `the command "${command.name}" is not a Telegram command name; it is left out of the menu`,
        );
        continue;
      }
      if (commands.some((entry) => entry.command === command.name)) continue;
      commands.push({ command: command.name, description: descriptionOf(command) });
    }
    const menu = commands.slice(0, MENU_MAX);
    const key = JSON.stringify(menu);
    if (key === this.registered) return;
    await this.api.setMyCommands({ commands: menu, signal: this.controller.signal });
    this.registered = key;
  }

  /** The chat whose commands the menu shows: an open bound chat, else a closed one. */
  private async newestChat(): Promise<string | undefined> {
    const chats = await boundChats(this.ctx);
    return (chats.find((chat) => !chat.closed) ?? chats[0])?.id;
  }

  async greet(text: string, target: number): Promise<boolean> {
    const parsed = parseCommand(text);
    if (parsed === undefined || parsed.name !== "start") return false;
    await this.api.sendMessage({
      chatId: target,
      text: START_GREETING,
      signal: this.controller.signal,
    });
    return true;
  }

  async command(chatId: string, name: string): Promise<ChatCommand | undefined> {
    try {
      const view = await this.ctx.client.get(`chat:${chatId}`);
      return findCommand(chatCommands(view.actions), name);
    } catch {
      return undefined;
    }
  }

  async offer(command: ChatCommand, text: string, chatId: string, target: number): Promise<boolean> {
    const choices = choicesOf(command);
    const parsed = parseCommand(text);
    if (choices.length === 0 || parsed === undefined || parsed.rest.length > 0) return false;
    const message = descriptionOf(command);
    const messageId = await this.api.sendMessage({
      chatId: target,
      text: message,
      keyboard: keyboardFor(choices, 0),
      signal: this.controller.signal,
    });
    this.remember(keyOf(target, messageId), {
      chatId,
      target,
      messageId,
      text: message,
      name: command.name,
      choices,
      page: 0,
    });
    return true;
  }

  async say(target: number, outcome: string): Promise<void> {
    for (const chunk of telegramChunks(outcome)) {
      if (this.stopped) return;
      try {
        await this.api.sendMessage({
          chatId: target,
          text: chunk.html,
          parseMode: "HTML",
          signal: this.controller.signal,
        });
      } catch (error) {
        // The markup Telegram cannot read goes again as plain text.
        if (error instanceof BotApiError && error.badMarkup) {
          try {
            await this.api.sendMessage({
              chatId: target,
              text: chunk.plain,
              signal: this.controller.signal,
            });
            continue;
          } catch (plain) {
            error = plain;
          }
        }
        if (this.stopped) return;
        await this.ctx.logger.write(`could not send what a command returned: ${messageOf(error)}`);
        return;
      }
    }
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.catch(() => undefined).then(work);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private find(
    target: number,
    messageId: number,
  ): { readonly key: string; readonly sent: SentCommand } | undefined {
    const key = keyOf(target, messageId);
    const sent = this.state[key];
    return sent === undefined ? undefined : { key, sent };
  }

  private remember(key: string, sent: SentCommand): void {
    this.state = pruneCommands({ ...this.state, [key]: sent });
    writeCommands(this.ctx.home, this.state);
  }

  private listed(userId: number | undefined): userId is number {
    return userId !== undefined && this.settings.users.includes(userId);
  }

  async handleCallback(callback: TelegramCallback): Promise<boolean> {
    const message = callback.message;
    if (message === undefined) return false;
    return this.exclusive(async () => {
      const found = this.find(message.chat.id, message.message_id);
      if (found === undefined) return false;
      // Only a listed user's tap counts; nobody else is told anything.
      if (!this.listed(callback.from.id)) {
        await this.tell(callback.id, undefined);
        return true;
      }
      const { key, sent } = found;
      const data = callback.data ?? "";
      const shownPage = /^p:(\d+)$/.exec(data)?.[1];
      if (shownPage !== undefined) {
        await this.show(key, sent, Number(shownPage));
        await this.tell(callback.id, undefined);
        return true;
      }
      const position = /^c:(\d+)$/.exec(data)?.[1];
      const choice = position === undefined ? undefined : sent.choices[Number(position)];
      if (choice === undefined) {
        await this.tell(callback.id, "this button is no longer valid");
        return true;
      }
      if (sent.chosen !== undefined) {
        await this.tell(callback.id, undefined);
        return true;
      }
      const words = await this.run(sent, choice, callback.from.id);
      await this.edit(sent, `${sent.text}\n\n${words}`);
      this.remember(key, { ...sent, chosen: choice });
      await this.tell(callback.id, undefined);
      return true;
    });
  }

  /** Shows another page of choices in the same message. */
  private async show(key: string, sent: SentCommand, page: number): Promise<void> {
    const pages = Math.max(1, Math.ceil(sent.choices.length / COMMAND_PAGE_SIZE));
    const shown = Math.min(Math.max(page, 0), pages - 1);
    try {
      await this.api.editMessage({
        chatId: sent.target,
        messageId: sent.messageId,
        text: sent.text,
        keyboard: keyboardFor(sent.choices, shown),
        signal: this.controller.signal,
      });
    } catch (error) {
      if (!this.stopped) {
        await this.ctx.logger.write(`could not change the choices of a command: ${messageOf(error)}`);
      }
      return;
    }
    this.remember(key, { ...sent, page: shown });
  }

  /** Runs the command with the chosen value as its text; the words the message ends with. */
  private async run(sent: SentCommand, choice: string, userId: number): Promise<string> {
    try {
      const result = await this.ctx.client.act("chat:send", `chat:${sent.chatId}`, {
        args: { note: `/${sent.name} ${choice}` },
        actor: { via: VIA, id: String(userId) },
      });
      const outcome = typeof result.value === "string" ? result.value.trim() : "";
      return outcome.startsWith("refused:") ? outcome : `chosen: ${choice}`;
    } catch (error) {
      return `refused: ${messageOf(error)}`;
    }
  }

  private async edit(sent: SentCommand, text: string): Promise<void> {
    try {
      await this.api.editMessage({
        chatId: sent.target,
        messageId: sent.messageId,
        text,
        signal: this.controller.signal,
      });
    } catch (error) {
      if (!this.stopped) {
        await this.ctx.logger.write(`could not change the message of a command: ${messageOf(error)}`);
      }
    }
  }

  private async tell(callbackId: string, text: string | undefined): Promise<void> {
    try {
      await this.api.answerCallback({
        callbackId,
        ...(text === undefined ? {} : { text }),
        signal: this.controller.signal,
      });
    } catch (error) {
      if (!this.stopped) {
        await this.ctx.logger.write(`could not answer a tap: ${messageOf(error)}`);
      }
    }
  }
}
