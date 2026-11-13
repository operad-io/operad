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
}

/** One update from `getUpdates`. */
export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage | undefined;
}

/** One long-poll request. */
export interface GetUpdatesRequest {
  /** The first update id to ask for. */
  readonly offset: number;
  /** How long Telegram may hold the request open. */
  readonly timeoutSecs: number;
  readonly signal?: AbortSignal | undefined;
}

/** What the source needs of Telegram. */
export interface BotApi {
  getUpdates(request: GetUpdatesRequest): Promise<readonly TelegramUpdate[]>;
}

export interface BotApiOptions {
  readonly token: Secret<string>;
  /** The API origin; a test may point it at a local fake. */
  readonly baseUrl?: string | undefined;
  /** The request function; a test gives a fake that never reaches the network. */
  readonly fetch?: ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
}

/** Hides the token from anything a caller may log or throw. */
export function redactToken(text: string, token: string): string {
  return token.length === 0 ? text : text.split(token).join("[redacted]");
}

function failure(detail: string | undefined, token: string): Error {
  const suffix = detail === undefined || detail.length === 0 ? "" : `: ${redactToken(detail, token)}`;
  return new Error(`the Telegram Bot API did not answer the update request${suffix}`);
}

function updateOf(value: unknown): TelegramUpdate | undefined {
  if (!isRecord(value) || typeof value.update_id !== "number" || !Number.isInteger(value.update_id)) {
    return undefined;
  }
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
    },
  };
}

/** The Bot API over `fetch`; no runtime package is needed. */
export function createBotApi(options: BotApiOptions): BotApi {
  const token = options.token.reveal();
  const origin = options.baseUrl ?? "https://api.telegram.org";
  const request = options.fetch ?? fetch;
  return {
    async getUpdates(input) {
      const query = new URLSearchParams({
        offset: String(input.offset),
        timeout: String(input.timeoutSecs),
        allowed_updates: JSON.stringify(["message"]),
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
  };
}
