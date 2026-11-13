/** The `telegram` section of `config.json`, and what its values mean. */

import type { ActionArgsSchema, JsonValue } from "@operad-io/engine";

/** The bot a chat is opened on when the settings name none. */
export const DEFAULT_BOT = "default";

/** The name of the secret that holds the Bot API token. */
export const TOKEN_SECRET = "token";

/** The JSON Schema of the `telegram` section (also shipped as `telegram.schema.json`). */
export const TELEGRAM_SETTINGS: ActionArgsSchema = {
  type: "object",
  properties: {
    users: {
      type: "array",
      items: { type: "integer", minimum: 1 },
      default: [],
      description:
        "The Telegram user ids whose private messages become chat messages. A message from anyone else is recorded and answered with nothing.",
    },
    bot: {
      type: "string",
      minLength: 1,
      default: DEFAULT_BOT,
      description: "The bot a chat is opened on when a listed user writes first.",
    },
    pending: {
      type: "array",
      items: { type: "string", minLength: 1 },
      default: [],
      description:
        "The plugins whose pending items are also sent to Telegram, such as [\"dev\"]. Items of a chat bound to Telegram are always sent.",
    },
  },
  additionalProperties: false,
};

/** The settings as the source reads them, with every default filled. */
export interface TelegramSettings {
  readonly users: readonly number[];
  readonly bot: string;
  readonly pending: readonly string[];
}

/** Reads a validated settings section. Values the schema refused never reach here. */
export function telegramSettings(settings: Readonly<Record<string, JsonValue>>): TelegramSettings {
  const users = Array.isArray(settings.users)
    ? settings.users.filter((value): value is number => typeof value === "number" && Number.isInteger(value))
    : [];
  const bot = typeof settings.bot === "string" && settings.bot.length > 0 ? settings.bot : DEFAULT_BOT;
  const pending = Array.isArray(settings.pending)
    ? settings.pending.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  return { users, bot, pending };
}
