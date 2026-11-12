/**
 * The bot plugin: a bot is a working directory, a default harness, skills, a
 * speaker and an access profile; `bot:chat` opens a chat on one. The chat's own
 * plugin is `chat`; this one only says where and under what rules it runs, and
 * says it again at every reply.
 *
 * Hook for Telegram: a chat bound from a channel is made with
 * {@link openChat} on {@link DEFAULT_BOT}; a rule that names another bot is not
 * built yet, and this is the one place it goes.
 */

import { mkdirSync } from "node:fs";
import { CHAT_TYPE, chatData, createChat, sendMessage, titleFromMessage } from "@operad-io/chat";
import { definePlugin, isRecord, type ActionArgsSchema, type ActionTypeDefinition, type JsonValue, type ObjectRow, type ObjectStore, type ObjectViews, type PluginStepResult, type SectionContent, type StepContext, type StoredObject } from "@operad-io/engine";
import {
  BOT_SETTINGS,
  DEFAULT_BOT,
  BOT_TYPE,
  BotError,
  readBots,
  repositoryPaths,
  resolveBot,
  type ResolvedBot,
} from "./bot.ts";
import {
  PROPOSAL_TYPE,
  proposalActions,
  proposalItems,
  proposalViews,
  runSettingCommand,
  runSkillCommand,
} from "./proposals.ts";

/** The step a chat calls at every reply to read its bot. */
export const SETTINGS_STEP = "bot/settings";

/** The bot as the row of a list shows it. */
function rowOf(bot: ResolvedBot): Record<string, JsonValue> {
  return {
    name: bot.name,
    cwd: bot.cwd,
    harness: bot.harness,
    skills: [...bot.skills],
    speaker: bot.speaker,
    access: bot.access,
  };
}

/**
 * Makes the bot objects match the settings: one per bot, the default always,
 * and a bot taken out of the settings is marked removed (its chats stop
 * answering). A bot that cannot be used is stored with its problem.
 */
export async function syncBots(
  store: ObjectStore,
  home: string,
  fallback: Readonly<Record<string, JsonValue>>,
): Promise<void> {
  const written = readBots(home, fallback);
  const repositories = await repositoryPaths(store);
  for (const [name, settings] of Object.entries(written)) {
    let data: Record<string, JsonValue>;
    try {
      data = { ...rowOf(resolveBot(home, name, settings, repositories)), removed: false };
    } catch (error) {
      if (!(error instanceof BotError)) throw error;
      data = { name, removed: false, problem: error.message };
    }
    const current = await store.get(BOT_TYPE, name);
    if (current === undefined || JSON.stringify(current.data) !== JSON.stringify(data)) {
      await store.put(BOT_TYPE, name, data, "bot");
    }
  }
  let cursor: string | undefined;
  do {
    const page = await store.list(BOT_TYPE, { ...(cursor === undefined ? {} : { cursor }) });
    for (const object of page.objects) {
      if (written[object.id] === undefined && object.data.removed !== true) {
        await store.put(BOT_TYPE, object.id, { ...object.data, removed: true }, "bot");
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);
}

/** What opening a chat needs from the host. */
export interface OpenChat {
  readonly store: ObjectStore;
  readonly home: string;
  readonly settings: Readonly<Record<string, JsonValue>>;
  readonly harnesses: readonly string[];
  readonly bot: string;
  readonly harness?: string | undefined;
  readonly title?: string | undefined;
  readonly cause: string;
}

/** Opens a chat on a bot and returns its id. Refuses with a plain message. */
export async function openChat(input: OpenChat): Promise<string> {
  const written = readBots(input.home, input.settings)[input.bot];
  if (written === undefined) throw new BotError(`there is no bot "${input.bot}"`);
  const bot = resolveBot(input.home, input.bot, written, await repositoryPaths(input.store));
  const harness = input.harness ?? bot.harness ?? input.harnesses[0];
  if (harness === undefined) {
    throw new BotError("no harness is loaded; load one to chat with the bot");
  }
  if (!input.harnesses.includes(harness)) {
    throw new BotError(
      `harness "${harness}" is not loaded; the loaded ones are: ${input.harnesses.join(", ") || "none"}`,
    );
  }
  mkdirSync(bot.cwd, { recursive: true });
  return createChat(
    input.store,
    {
      parent: `${BOT_TYPE}:${bot.name}`,
      harness,
      cwd: bot.cwd,
      access: bot.access,
      skills: bot.skills,
      title: input.title ?? `Bot (${bot.name})`,
      refresh: SETTINGS_STEP,
    },
    input.cause,
  );
}

/** The `chat` arguments with the harnesses loaded now as the choice. */
function chatArgs(harnesses: readonly string[], botHarness: unknown): ActionArgsSchema {
  const first = harnesses[0];
  const fallback = typeof botHarness === "string" && harnesses.includes(botHarness) ? botHarness : first;
  return {
    type: "object",
    description: "Opens a chat with the bot.",
    properties: {
      harness: {
        type: "string",
        ...(harnesses.length === 0 ? {} : { enum: [...harnesses] }),
        ...(fallback === undefined ? {} : { default: fallback }),
        description: "One of the loaded harness plugins. It cannot change later.",
      },
      title: { type: "string", minLength: 1, maxLength: 120, description: "What the chat is called." },
      message: {
        type: "string",
        role: "note",
        minLength: 1,
        description:
          "The first message; the chat is created and the message sent in one step. The title is taken from its start when none is given.",
      },
    },
    additionalProperties: false,
  };
}

const chatAction: ActionTypeDefinition = {
  name: "chat",
  on: BOT_TYPE,
  creates: "chat",
  args: chatArgs([], undefined),
  argsFor: (object, env) => chatArgs(env.harnesses ?? [], object.data.harness),
  when: (state, env) => state.removed !== true && typeof state.problem !== "string" && (env.harnesses ?? []).length > 0,
  async why(object, env) {
    if (object.data.removed === true) return `bot ${object.id} is no longer in the settings`;
    if (typeof object.data.problem === "string") return `bot ${object.id}: ${object.data.problem}`;
    if ((env.harnesses ?? []).length === 0) return `bot ${object.id}: no harness is loaded; load one to chat with it`;
    return undefined;
  },
  async run(ctx, args) {
    const input = args as { readonly harness?: string; readonly title?: string; readonly message?: string };
    const id = await openChat({
      store: ctx.store,
      home: ctx.home,
      settings: ctx.settings,
      harnesses: ctx.harnesses,
      bot: ctx.object.id,
      harness: input.harness,
      title: input.title ?? (input.message === undefined ? undefined : titleFromMessage(input.message)),
      cause: "action:bot/chat",
    });
    const sent = input.message === undefined ? undefined : await sendMessage(ctx, id, input.message);
    return { text: `opened chat ${id}${sent === undefined ? "" : `; ${sent}`}`, opens: `chat:${id}` };
  },
};

/**
 * Step `bot/settings`: the working directory, access profile and skills of a
 * chat's bot as they are now. The `chat` reply calls it every time, so
 * tightening access or adding a skill needs no new chat. A bot that is gone or
 * cannot be used fails the reply; it is never answered from an older copy.
 */
export async function runSettings(ctx: StepContext, params: unknown): Promise<PluginStepResult> {
  const chatId = isRecord(params) && typeof params.chat === "string" ? params.chat : undefined;
  const stored = chatId === undefined ? undefined : await ctx.store.get(CHAT_TYPE, chatId);
  if (stored === undefined) return { result: "failed", data: { message: "there is no such chat" } };
  const parent = chatData(stored.data).parent ?? "";
  if (!parent.startsWith(`${BOT_TYPE}:`)) {
    return { result: "failed", data: { message: `chat ${chatId} is not a chat of a bot` } };
  }
  const name = parent.slice(BOT_TYPE.length + 1);
  try {
    const written = readBots(ctx.home, ctx.settings)[name];
    if (written === undefined) {
      return { result: "failed", data: { message: `bot "${name}" is no longer in the settings` } };
    }
    const bot = resolveBot(ctx.home, name, written, await repositoryPaths(ctx.store));
    mkdirSync(bot.cwd, { recursive: true });
    return {
      result: "done",
      data: { cwd: bot.cwd, access: bot.access, skills: [...bot.skills] },
    };
  } catch (error) {
    return { result: "failed", data: { message: error instanceof Error ? error.message : String(error) } };
  }
}

function botMarkdown(object: StoredObject): string {
  const data = object.data;
  const lines = [`**${object.id}**`];
  if (typeof data.problem === "string") lines.push(`Cannot be used: ${data.problem}`);
  if (typeof data.cwd === "string") lines.push(`Working directory: ${data.cwd}`);
  if (typeof data.harness === "string") lines.push(`Default harness: ${data.harness}`);
  if (typeof data.speaker === "string") lines.push(`Speaker: ${data.speaker}`);
  const skills = Array.isArray(data.skills) ? data.skills : [];
  lines.push(skills.length === 0 ? "No skills." : `Skills: ${skills.join(", ")}`);
  return lines.join("\n\n");
}

/** How a bot shows in a list and on its page. */
export const botViews: ObjectViews = {
  row: (object): ObjectRow => ({
    id: object.id,
    title: object.id,
    state: object.data.removed === true ? "removed" : "open",
  }),
  sections: () => [{ id: "bot", title: "Bot" }],
  load: (_ctx, object): SectionContent => ({ markdown: botMarkdown(object) }),
};

/** Builds the bot plugin. */
export function createBotPlugin() {
  return definePlugin({
    name: "bot",
    kind: "domain",
    version: "0.0.0",
    requires: { plugins: { chat: "^0.0.0" } },
    settings: BOT_SETTINGS,
    objects: [
      {
        name: BOT_TYPE,
        filters: [
          { name: "open", states: ["open"], default: true },
          { name: "removed", states: ["removed"] },
        ],
        // Every list and get sees the bots the settings name.
        prepare: ({ store, home, settings }) => syncBots(store, home, settings),
      },
      {
        name: PROPOSAL_TYPE,
        index: ["state", "bot"],
        filters: [
          { name: "pending", states: ["pending"], default: true },
          { name: "applied", states: ["applied"] },
          { name: "rejected", states: ["rejected"] },
        ],
      },
    ],
    steps: [{ name: "settings", results: ["done", "failed"], run: runSettings }],
    actions: [chatAction, ...proposalActions],
    commands: [
      {
        name: "skill",
        args: "<bot> <name> [--from <dir>]",
        run: runSkillCommand,
      },
      {
        name: "setting",
        args: "<bot>",
        run: runSettingCommand,
      },
    ],
    // A proposal waits for no run; each one is a pending item of its bot.
    standing: async (ctx) => proposalItems(ctx.store),
    views: { [BOT_TYPE]: botViews, [PROPOSAL_TYPE]: proposalViews },
  });
}

export default createBotPlugin();

export * from "./bot.ts";
export * from "./proposals.ts";
