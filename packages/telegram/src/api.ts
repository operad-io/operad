/**
 * The Bot API calls the source makes, behind a small interface so a test gives
 * it a fake. Only `getUpdates` is needed here; the token reaches no log, fact
 * or error.
 */

import { isRecord, messageOf, type Secret } from "@operad-io/engine";

/** Who sent a Telegram message. */
export interface TelegramUser {
  readonly id: number;
}

/** The chat a Telegram message is in. */
export interface TelegramChat {
  readonly id: number;
  /** `private`, `group`, `supergroup` or `channel`. */
  readonly type: string;
}

/** One Telegram message, as far as the source reads it. */
export interface TelegramMessage {
  readonly message_id: number;
  readonly date: number;
  readonly chat: TelegramChat;
  readonly from?: TelegramUser | undefined;
  readonly text?: string | undefined;
  readonly caption?: string | undefined;
  /** The message this one replies to, when it is a reply. */
  readonly reply_to_message?: { readonly message_id: number } | undefined;
}

/** A tap on an inline-keyboard button. */
export interface TelegramCallback {
  readonly id: string;
  readonly from: TelegramUser;
  /** The message the button was on; absent for a message too old to carry it. */
  readonly message?: { readonly message_id: number; readonly chat: TelegramChat } | undefined;
  readonly data?: string | undefined;
}

/** One update from `getUpdates`. */
export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage | undefined;
  readonly callback_query?: TelegramCallback | undefined;
}

/** One long-poll request. */
export interface GetUpdatesRequest {
  /** The first update id to ask for. */
  readonly offset: number;
  /** How long Telegram may hold the request open. */
  readonly timeoutSecs: number;
  readonly signal?: AbortSignal | undefined;
}

/** One message to send. */
export interface SendMessageRequest {
  readonly chatId: number;
  readonly text: string;
  /** `HTML` when the text is already Telegram HTML; absent for plain text. */
  readonly parseMode?: "HTML" | undefined;
  /** An inline keyboard: rows of buttons, each carrying the data a tap returns. */
  readonly keyboard?: readonly (readonly InlineButton[])[] | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** One inline-keyboard button. */
export interface InlineButton {
  readonly text: string;
  /** What `callback_query.data` carries when the button is tapped; at most 64 bytes. */
  readonly data: string;
}

/** A message's new text; its inline keyboard goes. */
export interface EditMessageRequest {
  readonly chatId: number;
  readonly messageId: number;
  readonly text: string;
  readonly signal?: AbortSignal | undefined;
}

/** The answer to a button tap, shown to the person who tapped. */
export interface AnswerCallbackRequest {
  readonly callbackId: string;
  readonly text?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** What a chat shows of the bot while a reply is written. */
export interface SendChatActionRequest {
  readonly chatId: number;
  /** `typing` is the only action this plugin sends. */
  readonly action: "typing";
  readonly signal?: AbortSignal | undefined;
}

/** Why a Bot API call failed, and whether trying again can help. */
export class BotApiError extends Error {
  /** False for a refusal that will not change (a bad request, a blocked bot). */
  readonly retryable: boolean;
  /** How long Telegram asked to wait, in seconds, when it said. */
  readonly retryAfterSecs?: number | undefined;
  /** Telegram could not read the markup of the text. */
  readonly badMarkup: boolean;

  constructor(
    message: string,
    options: { retryable: boolean; retryAfterSecs?: number | undefined; badMarkup?: boolean },
  ) {
    super(message);
    this.name = "BotApiError";
    this.retryable = options.retryable;
    this.retryAfterSecs = options.retryAfterSecs;
    this.badMarkup = options.badMarkup === true;
  }
}

/** What the plugin needs of Telegram. */
export interface BotApi {
  getUpdates(request: GetUpdatesRequest): Promise<readonly TelegramUpdate[]>;
  /** Sends one text message; returns its Telegram `message_id`. */
  sendMessage(request: SendMessageRequest): Promise<number>;
  /** Replaces a message's text and removes its inline keyboard. */
  editMessage(request: EditMessageRequest): Promise<void>;
  /** Tells Telegram the tap was seen, with a short note for the person. */
  answerCallback(request: AnswerCallbackRequest): Promise<void>;
  /** Shows what the bot is doing in a chat, such as that it is typing. */
  sendChatAction(request: SendChatActionRequest): Promise<void>;
}

export interface BotApiOptions {
  readonly token: Secret<string>;
  /** The API origin; a test may point it at a local fake. */
  readonly baseUrl?: string | undefined;
  /** The request function; a test gives a fake that never reaches the network. */
  readonly fetch?: ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
  /** How long a send, edit or answer may take before it counts as failed; 30 seconds by default. */
  readonly sendTimeoutMs?: number | undefined;
  /** Makes the signal that ends a send after its time; a test gives one it aborts itself. */
  readonly timeoutSignal?: ((ms: number) => AbortSignal) | undefined;
}

/** Hides the token from anything a caller may log or throw. */
export function redactToken(text: string, token: string): string {
  return token.length === 0 ? text : text.split(token).join("[redacted]");
}

function failure(detail: string | undefined, token: string): Error {
  const suffix = detail === undefined || detail.length === 0 ? "" : `: ${redactToken(detail, token)}`;
  return new Error(`the Telegram Bot API did not answer the update request${suffix}`);
}

function sendFailure(
  detail: string,
  token: string,
  options: { retryable: boolean; retryAfterSecs?: number | undefined; badMarkup?: boolean },
): BotApiError {
  return new BotApiError(
    `the Telegram Bot API did not send the message: ${redactToken(detail, token)}`,
    options,
  );
}

function callbackOf(value: unknown): TelegramCallback | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.from) || typeof value.from.id !== "number") {
    return undefined;
  }
  const message = value.message;
  const chat = isRecord(message) ? message.chat : undefined;
  return {
    id: value.id,
    from: { id: value.from.id },
    ...(isRecord(message) &&
    typeof message.message_id === "number" &&
    isRecord(chat) &&
    typeof chat.id === "number" &&
    typeof chat.type === "string"
      ? { message: { message_id: message.message_id, chat: { id: chat.id, type: chat.type } } }
      : {}),
    ...(typeof value.data === "string" ? { data: value.data } : {}),
  };
}

function updateOf(value: unknown): TelegramUpdate | undefined {
  if (!isRecord(value) || typeof value.update_id !== "number" || !Number.isInteger(value.update_id)) {
    return undefined;
  }
  const callback = callbackOf(value.callback_query);
  if (callback !== undefined) return { update_id: value.update_id, callback_query: callback };
  const message = value.message;
  if (!isRecord(message)) return { update_id: value.update_id };
  const chat = message.chat;
  if (
    typeof message.message_id !== "number" ||
    typeof message.date !== "number" ||
    !isRecord(chat) ||
    typeof chat.id !== "number" ||
    typeof chat.type !== "string"
  ) {
    return { update_id: value.update_id };
  }
  const from = message.from;
  return {
    update_id: value.update_id,
    message: {
      message_id: message.message_id,
      date: message.date,
      chat: { id: chat.id, type: chat.type },
      ...(isRecord(from) && typeof from.id === "number" ? { from: { id: from.id } } : {}),
      ...(typeof message.text === "string" ? { text: message.text } : {}),
      ...(typeof message.caption === "string" ? { caption: message.caption } : {}),
      ...(isRecord(message.reply_to_message) && typeof message.reply_to_message.message_id === "number"
        ? { reply_to_message: { message_id: message.reply_to_message.message_id } }
        : {}),
    },
  };
}

/** The Bot API over `fetch`; no runtime package is needed. */
export function createBotApi(options: BotApiOptions): BotApi {
  const token = options.token.reveal();
  const origin = options.baseUrl ?? "https://api.telegram.org";
  const request = options.fetch ?? fetch;
  const sendTimeoutMs = options.sendTimeoutMs ?? 30_000;
  /** The caller's signal joined with the send's own time limit. */
  const limited = (signal: AbortSignal | undefined): AbortSignal => {
    const timeout = (options.timeoutSignal ?? AbortSignal.timeout.bind(AbortSignal))(sendTimeoutMs);
    return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  };
  /** One Bot API call whose result nobody reads. */
  const post = async (method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<void> => {
    let response: Response;
    try {
      response = await request(`${origin}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: limited(signal),
      });
    } catch (error) {
      throw sendFailure(messageOf(error), token, { retryable: true });
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw sendFailure(`HTTP ${response.status} with no JSON`, token, {
        retryable: response.status >= 500 || response.status === 429,
      });
    }
    if (isRecord(body) && body.ok === true) return;
    const description =
      isRecord(body) && typeof body.description === "string" ? body.description : `HTTP ${response.status}`;
    throw sendFailure(description, token, { retryable: response.status === 429 || response.status >= 500 });
  };
  return {
    async editMessage(input) {
      await post(
        "editMessageText",
        {
          chat_id: input.chatId,
          message_id: input.messageId,
          text: input.text,
          reply_markup: { inline_keyboard: [] },
          link_preview_options: { is_disabled: true },
        },
        input.signal,
      );
    },
    async answerCallback(input) {
      await post(
        "answerCallbackQuery",
        {
          callback_query_id: input.callbackId,
          ...(input.text === undefined ? {} : { text: input.text }),
        },
        input.signal,
      );
    },
    async sendChatAction(input) {
      await post(
        "sendChatAction",
        { chat_id: input.chatId, action: input.action },
        input.signal,
      );
    },
    async getUpdates(input) {
      const query = new URLSearchParams({
        offset: String(input.offset),
        timeout: String(input.timeoutSecs),
        allowed_updates: JSON.stringify(["message", "callback_query"]),
      });
      const url = `${origin}/bot${token}/getUpdates?${query.toString()}`;
      let response: Response;
      try {
        response = await request(url, {
          method: "GET",
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch (error) {
        throw failure(messageOf(error), token);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw failure(`HTTP ${response.status} with no JSON`, token);
      }
      if (!isRecord(body) || body.ok !== true) {
        const description = isRecord(body) && typeof body.description === "string" ? body.description : undefined;
        throw failure(description ?? `HTTP ${response.status}`, token);
      }
      if (!Array.isArray(body.result)) {
        throw failure("the result is not an array of updates", token);
      }
      const updates: TelegramUpdate[] = [];
      for (const value of body.result) {
        const update = updateOf(value);
        if (update !== undefined) updates.push(update);
      }
      return updates;
    },
    async sendMessage(input) {
      const url = `${origin}/bot${token}/sendMessage`;
      const payload = {
        chat_id: input.chatId,
        text: input.text,
        ...(input.parseMode === undefined ? {} : { parse_mode: input.parseMode }),
        ...(input.keyboard === undefined
          ? {}
          : {
              reply_markup: {
                inline_keyboard: input.keyboard.map((row) =>
                  row.map((button) => ({ text: button.text, callback_data: button.data })),
                ),
              },
            }),
        link_preview_options: { is_disabled: true },
      };
      let response: Response;
      try {
        response = await request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: limited(input.signal),
        });
      } catch (error) {
        throw sendFailure(messageOf(error), token, { retryable: true });
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw sendFailure(`HTTP ${response.status} with no JSON`, token, {
          retryable: response.status >= 500 || response.status === 429,
        });
      }
      if (isRecord(body) && body.ok === true && isRecord(body.result) && typeof body.result.message_id === "number") {
        return body.result.message_id;
      }
      const description =
        isRecord(body) && typeof body.description === "string" ? body.description : `HTTP ${response.status}`;
      const parameters = isRecord(body) && isRecord(body.parameters) ? body.parameters : undefined;
      const retryAfter =
        parameters !== undefined && typeof parameters.retry_after === "number" ? parameters.retry_after : undefined;
      throw sendFailure(description, token, {
        retryable: response.status === 429 || response.status >= 500,
        retryAfterSecs: retryAfter,
        badMarkup: response.status === 400 && /can't parse entities/i.test(description),
      });
    },
  };
}
