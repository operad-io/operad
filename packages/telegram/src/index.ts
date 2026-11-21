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
import { createBotApi, type BotApi } from "./api.ts";
import { CommandSender, pendingCommandAction } from "./commands.ts";
import { TelegramEvents } from "./events.ts";
import { TELEGRAM_SETTINGS, TOKEN_SECRET } from "./settings.ts";
import { PendingSender } from "./pending.ts";
import { ProgressSender } from "./progress.ts";
import { ReplySender } from "./replies.ts";
import { TelegramSource, delay } from "./source.ts";
import { TypingSender } from "./typing.ts";

/** What a test gives the plugin instead of what it builds itself. */
export interface TelegramPluginOptions {
  /** The Bot API to use; by default the real one, from the token. */
  readonly api?: BotApi | undefined;
  readonly clock?: (() => number) | undefined;
  readonly wait?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
  readonly intervalMs?: number | undefined;
}

/** Builds the Telegram source plugin. */
export function createTelegramPlugin(options: TelegramPluginOptions = {}) {
  /** The pending side of the running source, which `/pending` reads. */
  let pendingSender: PendingSender | undefined;
  return definePlugin({
    name: "telegram",
    kind: "source",
    version: pkg.version,
    settings: TELEGRAM_SETTINGS,
    actions: [pendingCommandAction(() => pendingSender)],
    async start(ctx): Promise<SourceHandle> {
      const token = await ctx.secrets.get(TOKEN_SECRET);
      if (token === undefined) {
        throw new Error(
          "the telegram plugin has no token; set it with `operad secret set telegram token`",
        );
      }
      const api = options.api ?? createBotApi({ token });
      const wait = options.wait ?? delay;
      const events = new TelegramEvents(ctx, { wait });
      const pending = new PendingSender(ctx, { api, wait });
      pendingSender = pending;
      const commands = new CommandSender(ctx, { api });
      const typingSender = new TypingSender(ctx, {
        api,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        wait,
        ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
      });
      const typing = typingSender.start(events);
      const replySender = new ReplySender(ctx, { api, wait });
      const replies = replySender.start(events);
      const progressSender = new ProgressSender(ctx, {
        api,
        replies: replySender,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        wait,
      });
      const progress = progressSender.start(events);
      const telegram = new TelegramSource(ctx, { api, pending, commands, typing: typingSender });
      const source = telegram.start();
      const menu = commands.start(events);
      const sent = pending.start(events);
      const watching = events.start({
        progress: (event) => progressSender.handleEvent(event),
        replies: (event) => replySender.handleEvent(event),
        typing: (event) => typingSender.handleEvent(event),
        pending: (event) => pending.handleEvent(event),
        commands: () => {
          void commands.refresh();
        },
        source: (chatId) => telegram.changed(chatId),
      });
      return {
        stop: async () => {
          await source.stop();
          await menu.stop();
          await watching.stop();
          await typing.stop();
          await progress.stop();
          await replies.stop();
          await sent.stop();
          if (pendingSender === pending) pendingSender = undefined;
        },
      };
    },
  });
}

export default createTelegramPlugin();

export * from "./api.ts";
export * from "./commands.ts";
export * from "./format.ts";
export * from "./pending.ts";
export * from "./progress.ts";
export * from "./replies.ts";
export * from "./settings.ts";
export * from "./source.ts";
export * from "./state.ts";
export * from "./typing.ts";
