/**
 * The `telegram` plugin: the first channel and the first outside source.
 *
 * `start(ctx)` long-polls the Bot API and turns a private message from a listed
 * user into one user message on that user's chat, opened on the configured bot
 * and bound through the chat's `channels`. The token is the plugin's secret
 * `token`; it never reaches a fact, a log line or an error.
 */

import pkg from "../package.json" with { type: "json" };
import { definePlugin, type SourceHandle } from "@operad-io/engine";
import { createBotApi } from "./api.ts";
import { TELEGRAM_SETTINGS, TOKEN_SECRET } from "./settings.ts";
import { ReplySender } from "./replies.ts";
import { TelegramSource, delay } from "./source.ts";

/** Builds the Telegram source plugin. */
export function createTelegramPlugin() {
  return definePlugin({
    name: "telegram",
    kind: "source",
    version: pkg.version,
    settings: TELEGRAM_SETTINGS,
    async start(ctx): Promise<SourceHandle> {
      const token = await ctx.secrets.get(TOKEN_SECRET);
      if (token === undefined) {
        throw new Error(
          "the telegram plugin has no token; set it with `operad secret set telegram token`",
        );
      }
      const api = createBotApi({ token });
      const source = new TelegramSource(ctx, { api }).start();
      const replies = new ReplySender(ctx, { api, wait: delay }).start();
      return {
        stop: async () => {
          await source.stop();
          await replies.stop();
        },
      };
    },
  });
}

export default createTelegramPlugin();

export * from "./api.ts";
export * from "./format.ts";
export * from "./replies.ts";
export * from "./settings.ts";
export * from "./source.ts";
export * from "./state.ts";
