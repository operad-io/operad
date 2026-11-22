/**
 * Setup guides in a bot (ADR 0010 D7, ADR 0030 D15): any plugin that ships a
 * guide can be set up by a bot's agent. The plugin's check says what is
 * missing, its guide says how to fix it, and the entries here hand the two to
 * the agent: a command it calls, an action a button runs and a chat command.
 */

import { isAbsolute, resolve } from "node:path";
import { chatData, sendMessage } from "@operad-io/chat";
import type { ActionTypeDefinition, CommandContext, SetupGuide, SetupReader } from "@operad-io/engine";
import { BotError, BOT_TYPE, readBots } from "./bot.ts";

/** Every guide's title: `Setup` and the plugin's name, capitalised (Setup Dev, Setup Telegram). */
export function setupTitle(plugin: string): string {
  return `Setup ${plugin.charAt(0).toUpperCase()}${plugin.slice(1)}`;
}

/** The guide's text with the bot and the target filled in. */
export function renderGuide(text: string, bot: string, target: string): string {
  return text.split("{bot}").join(bot).split("{target}").join(target);
}

/** The line a bot chat starts with, so a sentence is enough to start any plugin's setup. */
export const SETUP_INSTRUCTION =
  "To set up any other plugin that has a setup guide (Setup <name>), call the operad `command` tool with plugin `bot`, verb `setup`, my bot and the plugin's name: it answers with what is missing and the steps. Nothing is turned on until I approve the proposal in Pending.";

/** The plugin's guide, or the reason there is none. */
export async function guideOf(setup: SetupReader | undefined, plugin: string): Promise<SetupGuide> {
  const found = await setup?.get(plugin);
  if (found === undefined) {
    const known = (await setup?.list())?.map((item) => item.plugin) ?? [];
    throw new BotError(
      `setup: the plugin "${plugin}" has no setup guide${known.length === 0 ? "" : `; plugins with one: ${known.join(", ")}`}`,
    );
  }
  return found;
}

/** The text Setup Dev starts a chat with: the `dev` plugin's guide for one repository. */
export async function setupDevPrompt(setup: SetupReader | undefined, bot: string, repo: string): Promise<string> {
  return renderGuide((await guideOf(setup, "dev")).text, bot, repo);
}

/**
 * What the agent is given for a plugin: what its check finds missing, then the
 * guide. A plugin with nothing missing and no target gets one sentence saying so.
 */
export async function setupPrompt(
  setup: SetupReader | undefined,
  bot: string,
  plugin: string,
  target: string,
): Promise<string> {
  const guide = await guideOf(setup, plugin);
  const title = setupTitle(plugin);
  if (guide.missing.length === 0 && target.length === 0) {
    return `${title}: nothing is missing, ${plugin} is set up. Tell me so and stop unless I ask for something to change.`;
  }
  const lines = [`${title}. What the plugin's own check finds missing now:`];
  if (guide.missing.length === 0) lines.push("- nothing (it is set up); the target below still needs its steps");
  for (const item of guide.missing) lines.push(`- ${item.name}: ${item.description}`);
  lines.push("", "Follow only the steps of the guide that fix these items.", "");
  return `${lines.join("\n")}\n${renderGuide(guide.text, bot, target)}`;
}

const USAGE = "usage: operad bot setup <bot> <plugin> [target]";

/** `bot setup <bot> <plugin> [target]`: the steps for the agent. */
export async function runSetup(ctx: CommandContext, argv: readonly string[]): Promise<string> {
  const [bot, plugin, target] = argv;
  if (bot === undefined || plugin === undefined || argv.length > 3) throw new BotError(USAGE);
  if (readBots(ctx.home)[bot] === undefined) throw new BotError(`there is no bot "${bot}"`);
  const where = target === undefined ? "" : isAbsolute(target) ? target : resolve(ctx.cwd, target);
  return setupPrompt(ctx.setup, bot, plugin, where);
}

/** The chat command `/setup <plugin> [target]`: sends the plugin's guide to this chat, so its agent follows it. */
export const chatSetupAction: ActionTypeDefinition = {
  name: "setup",
  on: "chat",
  command: "Set up a plugin: the bot's agent follows its setup guide. /setup <plugin> [target]",
  args: {
    type: "object",
    properties: {
      plugin: { type: "string", minLength: 1, description: "The plugin to set up, such as dev." },
      target: {
        type: "string",
        description: "What the guide works on, when it needs one: for dev the repository's directory.",
      },
    },
    required: ["plugin"],
  },
  when: (state) => botOf(state) !== undefined && chatData(state).closed !== true,
  why: (object) => {
    if (botOf(object.data) === undefined) return `${object.id} is not a bot chat; /setup needs a bot`;
    return chatData(object.data).closed === true ? `${object.id} is closed; it takes no commands` : undefined;
  },
  async run(ctx, args) {
    const bot = botOf(ctx.object.data);
    if (bot === undefined) throw new BotError(`${ctx.object.id} is not a bot chat; /setup needs a bot`);
    const given = args as { readonly plugin: string; readonly target?: string };
    const target = given.target?.trim() ?? "";
    const where = target.length === 0 ? "" : isAbsolute(target) ? target : resolve(ctx.cwd, target);
    const prompt = await setupPrompt(ctx.setup, bot, given.plugin.trim(), where);
    const sent = await sendMessage(ctx, ctx.object.id, prompt);
    return `${setupTitle(given.plugin.trim())}: ${sent}`;
  },
};

function botOf(data: Readonly<Record<string, unknown>>): string | undefined {
  const parent = chatData(data).parent ?? "";
  return parent.startsWith(`${BOT_TYPE}:`) ? parent.slice(BOT_TYPE.length + 1) : undefined;
}
