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

import { messageOf } from "@operad-io/engine";
import pkg from "../package.json" with { type: "json" };
import { mkdirSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAT_TYPE, MESSAGE_EVENT, mainChatOf, levelRefusal, agentConditionals, type AgentChoices, type ScheduledChat, chatData, createChat, sendMessage, startingEffort, startingModel, titleFromMessage } from "@operad-io/chat";
import { definePlugin, isRecord, modelIds, type ActionArgSchema, type ActionArgsSchema, type ActionTypeDefinition, type HarnessCapabilities, type HarnessModelInfo, type HarnessModels, type JsonValue, type ObjectRow, type ObjectStore, type ObjectViews, type PluginStepResult, type SectionContent, type StepContext, type StoredObject } from "@operad-io/engine";
import {
  BOT_SETTINGS,
  DEFAULT_BOT,
  BOT_TYPE,
  BotError,
  botDir,
  defaultBotHomeMigrated,
  ensureBotMemory,
  migrateDefaultBotDir,
  readBots,
  repositoryPaths,
  resolveBot,
  skillName,
  workingDirectory,
  type BotSettings,
  type ResolvedBot,
} from "./bot.ts";
import { MEMORY_COMMIT_STEP, memoryNotes } from "@operad-io/memory";
import { createBot, knownMcpServers, knownSkills } from "./create.ts";
import { LOGIN_EVENT, LOGIN_SOURCE, loginAction, loginFlow, loginItems, runLogin as runLoginStep } from "./login.ts";
import { chatSetupAction, runSetup, setupDevPrompt, setupPrompt, setupTitle } from "./setup.ts";
import { ingestReports, runMcpCommand } from "./mcp-proposals.ts";
import {
  PROPOSAL_TYPE,
  proposalActions,
  proposalItems,
  proposalViews,
  runSettingCommand,
  runScheduleCommand,
  runSetupDev,
  runSetupGit,
  runSkillCommand,
} from "./proposals.ts";
import {
  ROUTINE_TYPE,
  SCHEDULE_SOURCE,
  migrateScheduled,
  scheduleActions,
  scheduledChatContext,
  scheduledInstructionFor,
  markdownCode,
  markdownText,
  routinesOf,
  startScheduled,
} from "./schedule.ts";
import { closeOldScheduledChats, routineActions, routineMarkdown, routineViews, ROUTINE_FILTERS } from "./routine.ts";
import { followUpActions, followUpData, followUpMarkdown, followUps, runFollowUpCommand, runFollowUpsCommand } from "./follow-up.ts";
import {
  TIDY_TYPE,
  startTidy,
  tidyActions,
  tidyItems,
  tidyViews,
} from "./tidy.ts";

/** The step a chat calls at every reply to read its bot. */
export const SETTINGS_STEP = "bot/settings";

/** The bot as the row of a list shows it. */
function rowOf(bot: ResolvedBot): Record<string, JsonValue> {
  return {
    name: bot.name,
    cwd: bot.cwd,
    harness: bot.harness,
    useOwnSettings: bot.useOwnSettings,
    model: bot.model,
    effort: bot.effort,
    skills: [...bot.skills],
    speaker: bot.speaker,
    writeWiki: bot.writeWiki,
    accessLevel: bot.accessLevel,
    access: bot.access,
    mcpServers: Object.keys(bot.mcpServers),
  };
}

/** The harnesses that take MCP servers natively; any other does not mount a bot's servers. */
export const MCP_HARNESSES: readonly string[] = ["claude", "radian"];

/** Moves the old default bot home once, unless the default bot names its own directory. */
async function migrateDefaultHome(
  store: ObjectStore,
  home: string,
  written: Readonly<Record<string, BotSettings>>,
): Promise<void> {
  const settings = written[DEFAULT_BOT];
  if (settings === undefined) return;
  try {
    if (workingDirectory(home, DEFAULT_BOT, settings) !== join(botDir(home), DEFAULT_BOT)) return;
  } catch {
    return;
  }
  if (defaultBotHomeMigrated(home)) return;
  // A bot's directory may have a different name from the bot and may already be gone
  // from the settings; both its stored cwd and its default path are kept in place.
  const botPaths: string[] = [];
  for (const [name, bot] of Object.entries(written)) {
    if (name === DEFAULT_BOT) continue;
    try {
      botPaths.push(workingDirectory(home, name, bot));
    } catch {
      botPaths.push(join(botDir(home), name));
    }
  }
  let cursor: string | undefined;
  do {
    const page = await store.list(BOT_TYPE, { ...(cursor === undefined ? {} : { cursor }) });
    for (const object of page.objects) {
      if (object.id === DEFAULT_BOT) continue;
      const cwd = object.data.cwd;
      botPaths.push(typeof cwd === "string" && cwd.length > 0 ? cwd : join(botDir(home), object.id));
    }
    cursor = page.next;
  } while (cursor !== undefined);
  const repositories = await repositoryPaths(store);
  const grantFiles = [
    join(home, "access-user.json"),
    ...botPaths.map((path) => join(path, "access-user.json")),
    ...repositories.map((path) => join(path, ".operad", "access-user.json")),
  ];
  await migrateDefaultBotDir(home, { botNames: Object.keys(written), botPaths, grantFiles });
}

const GUARD = fileURLToPath(new URL("./guard.ts", import.meta.url));

/** What a harness starts for one of a bot's servers: the guard, which starts the server itself. */
export function guardCommand(home: string, bot: string, server: string): { readonly command: string; readonly args: readonly string[] } {
  return { command: process.execPath, args: [GUARD, "--home", home, "--bot", bot, "--server", server] };
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
  await migrateDefaultHome(store, home, written);
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
    // Routines used to be a field of the bot object; each one is an object of its own now.
    if (current !== undefined && Array.isArray(current.data.scheduled)) {
      await migrateScheduled(store, name, current.data);
    }
    // So are its follow-ups (ADR 0030 D16).
    if (Array.isArray(current?.data.followUps)) {
      data.followUps = current.data.followUps as JsonValue[];
    }
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
  /** What each loaded agent can do; the level a chat starts at must be one its agent carries. */
  readonly capabilities?: Readonly<Record<string, HarnessCapabilities>> | undefined;
  readonly bot: string;
  readonly models?: Readonly<Record<string, HarnessModels>> | undefined;
  readonly efforts?: Readonly<Record<string, { readonly list: readonly string[]; readonly default: string | null }>> | undefined;
  readonly harness?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly title?: string | undefined;
  /** The channels (`telegram:<chat>`) whose messages land in this chat. */
  readonly channels?: readonly string[] | undefined;
  /** The routine that starts the run; absent when a person opens a chat. */
  readonly scheduled?: ScheduledChat | undefined;
  /** True for the record of a run of a routine, which is not a chat. */
  readonly run?: boolean | undefined;
  readonly cause: string;
}

/**
 * The agent a chat gets when nothing names one: the first loaded agent that can
 * carry the level, else the first loaded one (a refusal then names the levels).
 */
export function defaultAgent(
  harnesses: readonly string[],
  capabilities: Readonly<Record<string, HarnessCapabilities>> | undefined,
  level: string,
): string | undefined {
  if (capabilities === undefined) return harnesses[0];
  return harnesses.find((name) => (capabilities[name]?.accessLevels ?? []).includes(level)) ?? harnesses[0];
}

/** Opens a chat on a bot and returns its id. Refuses with a plain message. */
export async function openChat(input: OpenChat): Promise<string> {
  const written = readBots(input.home, input.settings);
  await migrateDefaultHome(input.store, input.home, written);
  const settings = written[input.bot];
  if (settings === undefined) throw new BotError(`there is no bot "${input.bot}"`);
  const bot = resolveBot(input.home, input.bot, settings, await repositoryPaths(input.store));
  // A scheduled prompt runs at full access (ADR 0030 D10); a chat a person
  // opens starts at the bot's level (ADR 0026 D15). A person may still change
  // the level with `/access` afterwards.
  const startingLevel = input.scheduled === undefined ? bot.accessLevel : "full";
  const harness =
    input.harness ?? bot.harness ?? defaultAgent(input.harnesses, input.capabilities, startingLevel);
  if (harness === undefined) {
    throw new BotError("no agent is loaded; load one to chat with the bot");
  }
  if (!input.harnesses.includes(harness)) {
    throw new BotError(
      `agent "${harness}" is not loaded; the loaded ones are: ${input.harnesses.join(", ") || "none"}`,
    );
  }
  // The bot's configured model and effort must be ones the agent lists; an unlisted one is refused by name.
  let model: string | undefined;
  let effort: string | undefined;
  try {
    model = startingModel(harness, input.models?.[harness], input.model, bot.model ?? undefined);
    effort = startingEffort(harness, input.efforts?.[harness], input.effort, bot.effort ?? undefined);
  } catch (error) {
    throw new BotError(messageOf(error));
  }
  const effortDefault = input.efforts?.[harness]?.default ?? undefined;
  // An agent that cannot carry the level is refused here, not at the first reply.
  const refusal = levelRefusal(harness, startingLevel, input.capabilities);
  if (refusal !== undefined) throw new BotError(refusal);
  mkdirSync(bot.cwd, { recursive: true });
  ensureBotMemory(bot.cwd, input.home);
  return createChat(
    input.store,
    {
      parent: `${BOT_TYPE}:${bot.name}`,
      harness,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
      ...(effort === undefined || effortDefault === undefined ? {} : { effortDefault }),
      cwd: bot.cwd,
      access: bot.access,
      accessLevel: startingLevel,
      accessDefault: startingLevel,
      skills: bot.skills,
      title: input.title ?? `Bot (${bot.name})`,
      ...(input.channels === undefined ? {} : { channels: input.channels }),
      ...(input.scheduled === undefined ? {} : { scheduled: input.scheduled }),
      ...(input.run === true ? { run: true } : {}),
      refresh: SETTINGS_STEP,
    },
    input.cause,
  );
}

/** The `chat` arguments with the harness plugins loaded now as the choice. */
function chatArgs(
  harnesses: readonly string[],
  botHarness: unknown,
  models: readonly string[] = [],
  efforts: readonly string[] = [],
  agents: readonly AgentChoices[] = [],
  info?: Readonly<Record<string, HarnessModelInfo>> | undefined,
  capabilities?: Readonly<Record<string, HarnessCapabilities>> | undefined,
  level = "ask",
): ActionArgsSchema {
  const first = defaultAgent(harnesses, capabilities, level);
  const fallback = typeof botHarness === "string" && harnesses.includes(botHarness) ? botHarness : first;
  return {
    type: "object",
    description: "Opens a chat with the bot.",
    properties: {
      agent: {
        type: "string",
        ...(harnesses.length === 0 ? {} : { enum: [...harnesses] }),
        ...(fallback === undefined ? {} : { default: fallback }),
        description: "Which agent answers in this chat; it cannot change later.",
      },
      model: {
        type: "string",
        ...(models.length === 0 ? {} : { enum: [...models] }),
        ...(info === undefined ? {} : { info }),
        description:
          "The model the agent uses; one from that agent's list. The bot's model, else the agent's default, when left out. It can be changed later.",
      },
      effort: {
        type: "string",
        ...(efforts.length === 0 ? {} : { enum: [...efforts] }),
        description:
          "The effort the agent uses; one from that agent's list. The bot's effort, else the agent's default, when left out. It can be changed later.",
      },
      title: { type: "string", minLength: 1, maxLength: 120, description: "What the chat is called." },
      channels: {
        type: "array",
        items: { type: "string", pattern: "^telegram:[^\\s]+$" },
        description:
          "The channels whose messages land in this chat, as telegram:<Telegram chat id>. A channel opens a chat with its own id here.",
      },
      message: {
        type: "string",
        role: "note",
        minLength: 1,
        description:
          "The first message; the chat is created and the message sent in one step. The title is taken from its start when none is given.",
      },
    },
    ...(agents.length === 0 ? {} : { allOf: agentConditionals(agents) }),
    additionalProperties: false,
  };
}

/** The skill choices: a known skill by name, or a path such as `/...`, `~/...` or `skills/...`. */
function skillItem(known: readonly { readonly name: string }[]): ActionArgSchema {
  const branches: ActionArgSchema[] = [];
  const names = [...new Set(known.map((skill) => skill.name))].sort();
  if (names.length > 0) {
    branches.push({
      type: "string",
      enum: names,
      description: "A skill another bot already mounts, or one in ~/.agents/skills.",
    });
  }
  branches.push({
    type: "string",
    pattern: "^(?:.*[/\\\\].*|~.*)$",
    description: "A path to a skill, a directory of skills, or a .agents directory.",
  });
  return branches.length === 1 ? (branches[0] as ActionArgSchema) : { oneOf: branches };
}

/** The arguments of `bot:create`, with the choices this home knows now. */
function createArgs(
  home: string | undefined,
  harnesses: readonly string[],
  models: readonly string[],
  efforts: readonly string[],
  agents: readonly AgentChoices[],
  info?: Readonly<Record<string, HarnessModelInfo>> | undefined,
  capabilities?: Readonly<Record<string, HarnessCapabilities>> | undefined,
): ActionArgsSchema {
  const skills = home === undefined ? [] : knownSkills(home);
  const servers = home === undefined ? [] : knownMcpServers(home);
  const first = defaultAgent(harnesses, capabilities, "ask");
  return {
    type: "object",
    description: "Creates a bot with exactly the skills and MCP servers chosen for it.",
    properties: {
      name: {
        type: "string",
        description:
          "The new bot's name, used for its directory under ~/.operad/bot; lowercase letters, digits, - and _.",
      },
      agent: {
        type: "string",
        ...(harnesses.length === 0 ? {} : { enum: [...harnesses] }),
        ...(first === undefined ? {} : { default: first }),
        description: "The agent a new chat of this bot starts with.",
      },
      model: {
        type: "string",
        ...(models.length === 0 ? {} : { enum: [...models] }),
        ...(info === undefined ? {} : { info }),
        description: "The model a new chat starts with; one the chosen agent lists. Left out: the agent's default.",
      },
      effort: {
        type: "string",
        ...(efforts.length === 0 ? {} : { enum: [...efforts] }),
        description: "The effort a new chat starts with; one the chosen agent lists. Left out: the agent's default.",
      },
      speaker: {
        type: "string",
        minLength: 1,
        description: "How this bot's chats label the model's messages; left out: the chat plugin's speaker.",
      },
      skills: {
        type: "array",
        items: skillItem(skills),
        description:
          "The skills exactly this bot has. A known skill is chosen by name, or a path is given; without it the bot has none. A path that is a directory of skills gives every skill inside it.",
      },
      mcpServers: {
        type: "array",
        items: { type: "string", ...(servers.length === 0 ? {} : { enum: servers.map((server) => server.key) }) },
        description:
          "MCP servers a person already approved on another bot, copied with their pin and digest. Without it the bot has none; a new server goes through bot mcp.",
      },
    },
    required: ["name", "agent"],
    ...(agents.length === 0 ? {} : { allOf: agentConditionals(agents) }),
    additionalProperties: false,
  };
}

const createAction: ActionTypeDefinition = {
  name: "create",
  on: BOT_TYPE,
  args: createArgs(undefined, [], [], [], []),
  argsFor: (_object, env) => {
    const info: Record<string, HarnessModelInfo> = {};
    for (const name of env.harnesses ?? []) {
      for (const [id, model] of Object.entries(env.models?.[name]?.info ?? {})) info[id] = model;
    }
    return createArgs(
      env.home,
      env.harnesses ?? [],
      [...new Set((env.harnesses ?? []).flatMap((name) => modelIds(env.models?.[name])))],
      [...new Set((env.harnesses ?? []).flatMap((name) => env.efforts?.[name]?.list ?? []))],
      (env.harnesses ?? []).map((name) => ({
        name,
        models: env.models?.[name],
        efforts: env.efforts?.[name],
        preferredModel: null,
        preferredEffort: null,
      })),
      Object.keys(info).length === 0 ? undefined : info,
      env.capabilities,
    );
  },
  when: (state, env) => state.removed !== true && (env.harnesses ?? []).length > 0,
  async why(object, env) {
    if (object.data.removed === true) return `bot ${object.id} is no longer in the settings`;
    if ((env.harnesses ?? []).length === 0) return "no agent is loaded; load one to create a bot";
    return undefined;
  },
  async run(ctx, args) {
    const input = args as {
      readonly name?: string;
      readonly agent?: string;
      readonly model?: string;
      readonly effort?: string;
      readonly speaker?: string;
      readonly skills?: readonly string[];
      readonly mcpServers?: readonly string[];
    };
    const name = input.name ?? "";
    const agent = input.agent ?? "";
    if (!ctx.harnesses.includes(agent)) {
      throw new BotError(
        `agent "${agent}" is not loaded; the loaded ones are: ${ctx.harnesses.join(", ") || "none"}`,
      );
    }
    try {
      if (input.model !== undefined) startingModel(agent, ctx.models?.[agent], input.model);
      if (input.effort !== undefined) startingEffort(agent, ctx.efforts?.[agent], input.effort);
    } catch (error) {
      throw new BotError(messageOf(error));
    }
    const created = await createBot(
      ctx.home,
      {
        name,
        agent,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.speaker === undefined ? {} : { speaker: input.speaker }),
        ...(input.skills === undefined ? {} : { skills: input.skills }),
        ...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers }),
      },
      { cwd: ctx.cwd },
    );
    await syncBots(ctx.store, ctx.home, ctx.settings);
    const secrets =
      created.secrets.length === 0
        ? ""
        : `; its MCP servers need ${created.secrets
            .map((secret) => `${secret} (operad secret set bot ${secret})`)
            .join(", ")}`;
    return { text: `created bot "${name}"${secrets}`, opens: `${BOT_TYPE}:${name}` };
  },
};

const chatAction: ActionTypeDefinition = {
  name: "chat",
  on: BOT_TYPE,
  creates: "chat",
  args: chatArgs([], undefined),
  argsFor: (object, env) => {
    const info: Record<string, HarnessModelInfo> = {};
    for (const name of env.harnesses ?? []) {
      for (const [id, model] of Object.entries(env.models?.[name]?.info ?? {})) info[id] = model;
    }
    return chatArgs(
      env.harnesses ?? [],
      object.data.harness,
      [...new Set((env.harnesses ?? []).flatMap((name) => modelIds(env.models?.[name])))],
      [...new Set((env.harnesses ?? []).flatMap((name) => env.efforts?.[name]?.list ?? []))],
      (env.harnesses ?? []).map((name) => ({
        name,
        models: env.models?.[name],
        efforts: env.efforts?.[name],
        preferredModel: typeof object.data.model === "string" ? object.data.model : null,
        preferredEffort: typeof object.data.effort === "string" ? object.data.effort : null,
      })),
      Object.keys(info).length === 0 ? undefined : info,
      env.capabilities,
      typeof object.data.accessLevel === "string" ? object.data.accessLevel : "ask",
    );
  },
  when: (state, env) => state.removed !== true && typeof state.problem !== "string" && (env.harnesses ?? []).length > 0,
  async why(object, env) {
    if (object.data.removed === true) return `bot ${object.id} is no longer in the settings`;
    if (typeof object.data.problem === "string") return `bot ${object.id}: ${object.data.problem}`;
    if ((env.harnesses ?? []).length === 0) return `bot ${object.id}: no agent is loaded; load one to chat with it`;
    return undefined;
  },
  async run(ctx, args) {
    const input = args as {
      readonly agent?: string;
      readonly model?: string;
      readonly effort?: string;
      readonly title?: string;
      readonly channels?: readonly string[];
      readonly message?: string;
    };
    const scheduled =
      ctx.actor.via === SCHEDULE_SOURCE
        ? { bot: ctx.object.id, entry: ctx.actor.id }
        : undefined;
    const id = await openChat({
      store: ctx.store,
      home: ctx.home,
      settings: ctx.settings,
      harnesses: ctx.harnesses,
      capabilities: ctx.capabilities,
      models: ctx.models,
      efforts: ctx.efforts,
      bot: ctx.object.id,
      harness: input.agent,
      model: input.model,
      effort: input.effort,
      title: input.title ?? (input.message === undefined ? undefined : titleFromMessage(input.message)),
      channels: input.channels,
      ...(scheduled === undefined ? {} : { scheduled, run: true }),
      cause: "action:bot/chat",
    });
    const sent =
      input.message === undefined
        ? undefined
        : await sendMessage(
            ctx.actor.via === SCHEDULE_SOURCE ? { ...ctx, source: SCHEDULE_SOURCE } : ctx,
            id,
            input.message,
            undefined,
            [],
            scheduled === undefined ? undefined : await scheduledInstructionFor(ctx.store, ctx.object.id, scheduled.entry),
          );
    return { text: `opened chat ${id}${sent === undefined ? "" : `; ${sent}`}`, opens: `chat:${id}` };
  },
};

// Setup Dev (ADR 0030 D15): opens a chat on the bot whose first message shows
// the chat's title and carries the prepared prompt for one repository as a
// hidden instruction. The chat is an ordinary one; what the agent proposes is a
// pending item.
const setupDevAction: ActionTypeDefinition = {
  name: "setup-dev",
  on: BOT_TYPE,
  creates: "chat",
  args: {
    type: "object",
    description: "Opens a chat that has the bot's agent set up dev for a repository and propose the result.",
    properties: {
      path: {
        type: "string",
        minLength: 1,
        description: "The directory of the repository or folder: any folder, with or without git, but not a subfolder of a git repository.",
      },
    },
    required: ["path"],
  },
  when: (state, env) => state.removed !== true && typeof state.problem !== "string" && (env.harnesses ?? []).length > 0,
  async why(object, env) {
    if (object.data.removed === true) return `bot ${object.id} is no longer in the settings`;
    if (typeof object.data.problem === "string") return `bot ${object.id}: ${object.data.problem}`;
    if ((env.harnesses ?? []).length === 0) return `bot ${object.id}: no agent is loaded; load one to chat with it`;
    return undefined;
  },
  async run(ctx, args) {
    const repo = (args as { readonly path: string }).path.trim();
    if (repo.length === 0) throw new BotError("setup-dev needs the repository's directory");
    const where = isAbsolute(repo) ? repo : resolve(ctx.cwd, repo);
    const title = `Setup Dev (${basename(where)})`;
    const id = await openChat({
      store: ctx.store,
      home: ctx.home,
      settings: ctx.settings,
      harnesses: ctx.harnesses,
      capabilities: ctx.capabilities,
      models: ctx.models,
      efforts: ctx.efforts,
      bot: ctx.object.id,
      title,
      cause: "action:bot/setup-dev",
    });
    // The person sees the chat's title; the prompt is the agent's hidden instruction.
    const sent = await sendMessage(ctx, id, title, undefined, [], await setupDevPrompt(ctx.setup, ctx.object.id, where));
    return { text: `opened chat ${id}; ${sent}`, opens: `chat:${id}` };
  },
};

// Setup <plugin> (ADR 0010 D7): opens a chat on the bot whose first message shows
// the chat's title and carries the plugin's guide, with what its check finds
// missing, as a hidden instruction.
const setupAction: ActionTypeDefinition = {
  name: "setup",
  on: BOT_TYPE,
  creates: "chat",
  args: {
    type: "object",
    description: "Opens a chat that has the bot's agent set up a plugin by its guide.",
    properties: {
      plugin: { type: "string", minLength: 1, description: "The plugin to set up, such as dev." },
      target: {
        type: "string",
        description: "What the guide works on, when it needs one: for dev the repository's directory.",
      },
    },
    required: ["plugin"],
  },
  when: setupDevAction.when,
  why: setupDevAction.why,
  async run(ctx, args) {
    const given = args as { readonly plugin: string; readonly target?: string };
    const plugin = given.plugin.trim();
    const target = given.target?.trim() ?? "";
    const where = target.length === 0 ? "" : isAbsolute(target) ? target : resolve(ctx.cwd, target);
    const prompt = await setupPrompt(ctx.setup, ctx.object.id, plugin, where);
    const title = `${setupTitle(plugin)}${where.length === 0 ? "" : ` (${basename(where)})`}`;
    const id = await openChat({
      store: ctx.store,
      home: ctx.home,
      settings: ctx.settings,
      harnesses: ctx.harnesses,
      capabilities: ctx.capabilities,
      models: ctx.models,
      efforts: ctx.efforts,
      bot: ctx.object.id,
      title,
      cause: "action:bot/setup",
    });
    const sent = await sendMessage(ctx, id, title, undefined, [], prompt);
    return { text: `opened chat ${id}; ${sent}`, opens: `chat:${id}` };
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
    await ingestReports(ctx.store, ctx.home);
    const bots = readBots(ctx.home, ctx.settings);
    await migrateDefaultHome(ctx.store, ctx.home, bots);
    const written = bots[name];
    if (written === undefined) {
      return { result: "failed", data: { message: `bot "${name}" is no longer in the settings` } };
    }
    const bot = resolveBot(ctx.home, name, written, await repositoryPaths(ctx.store));
    mkdirSync(bot.cwd, { recursive: true });
    ensureBotMemory(bot.cwd, ctx.home);
    // Only the servers the bot lists, and only on a harness that takes MCP servers natively.
    const mounts = MCP_HARNESSES.includes(chatData(stored.data).harness);
    const mcpServers: Record<string, JsonValue> = {};
    for (const [server, entry] of Object.entries(bot.mcpServers)) {
      if (mounts && entry.digest !== undefined) mcpServers[server] = { ...guardCommand(ctx.home, name, server) } as unknown as JsonValue;
    }
    return {
      result: "done",
      data: {
        cwd: bot.cwd,
        access: bot.access,
        skills: [...bot.skills],
        mcpServers,
        useOwnSettings: bot.useOwnSettings,
        // A chat that never chose a level follows the bot's setting; a scheduled chat keeps `full`.
        ...(chatData(stored.data).scheduled === undefined ? { accessDefault: bot.accessLevel } : {}),
        // The memory index and the person's instructions ride on the message,
        // whole when this session has not seen them, under ADR 0026 D18.
        notes: memoryNotes(join(bot.cwd, "memory")) as unknown as JsonValue,
        // The memory plugin records what this reply wrote, once the round ends.
        ...(ctx.stepLoaded !== undefined && ctx.stepLoaded(MEMORY_COMMIT_STEP) ? { after: MEMORY_COMMIT_STEP } : {}),
        // A run of a routine is not a chat: it proposes no schedule and sets no follow-up.
        ...(chatData(stored.data).run === true ? {} : { context: scheduledChatContext(stored.id) }),
      },
    };
  } catch (error) {
    return { result: "failed", data: { message: messageOf(error) } };
  }
}

async function botMarkdown(store: ObjectStore, object: StoredObject): Promise<string> {
  const data = object.data;
  const lines = [`**${object.id}**`];
  if (typeof data.problem === "string") lines.push(`Cannot be used: ${markdownText(data.problem)}`);
  if (typeof data.cwd === "string") lines.push(`Working directory: ${markdownCode(data.cwd)}`);
  if (typeof data.harness === "string") lines.push(`Default agent: ${markdownText(data.harness)}`);
  if (typeof data.speaker === "string") lines.push(`Speaker: ${markdownText(data.speaker)}`);
  const skills = Array.isArray(data.skills)
    ? data.skills.filter((path): path is string => typeof path === "string")
    : [];
  lines.push(skills.length === 0 ? "No skills." : `Skills: ${skills.map((path) => markdownText(skillName(path))).join(", ")}`);
  lines.push(data.writeWiki === true ? "Wiki: read and write." : "Wiki: read only.");
  const servers = Array.isArray(data.mcpServers) ? data.mcpServers : [];
  if (servers.length > 0) {
    lines.push(
      `MCP servers: ${servers.map((name) => markdownText(String(name))).join(", ")}`,
      `They are mounted in chats on ${MCP_HARNESSES.join(" and ")}. A chat on pi does not mount them: pi takes no MCP servers yet, so it cannot use ${servers.join(", ")}.`,
    );
  }
  lines.push(routineMarkdown(await routinesOf(store, object.id), Date.now()).join("\n"));
  lines.push(followUpMarkdown(followUps(data)).join("\n"));
  return lines.join("\n\n");
}

/** The server's IANA time zone, the one cron expressions run in; read at each call so `TZ` can be set. */
export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** How a bot shows in a list and on its page. */
export const botViews: ObjectViews = {
  row: (object): ObjectRow => ({
    id: object.id,
    title: object.id,
    state: object.data.removed === true ? "removed" : "open",
    data: {
      timeZone: serverTimeZone(),
      followUps: followUpData(followUps(object.data)) as unknown as JsonValue,
    },
  }),
  sections: () => [{ id: "bot", title: "Bot" }],
  // The bot's main chat rides on its page, so a client that opens the bot can go on to it.
  load: async (ctx, object): Promise<SectionContent> => {
    const main = object.data.removed === true ? undefined : await mainChatOf(ctx.store, `${BOT_TYPE}:${object.id}`);
    return {
      markdown: await botMarkdown(ctx.store, object),
      data: { mainChat: main === undefined ? null : `${CHAT_TYPE}:${main}` },
    };
  },
};

/** Builds the bot plugin. */
export function createBotPlugin() {
  return definePlugin({
    name: "bot",
    kind: "domain",
    // The version comes from package.json so the two cannot drift apart.
    version: pkg.version,
    // Patch releases of chat only: a new minor may change what bot relies on.
    requires: { plugins: { chat: "~0.3.0" } },
    settings: BOT_SETTINGS,
    // A bot page is that bot's settings page; bots live under settings, not in a tab.
    objectsUnderSettings: true,
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
      { name: TIDY_TYPE, index: ["bot", "state"] },
      { name: ROUTINE_TYPE, index: ["bot"], filters: ROUTINE_FILTERS },
    ],
    steps: [
      { name: "settings", results: ["done", "failed"], run: runSettings },
      { name: "login", results: ["done", "failed"], callsNamedByData: true, timeoutSecs: 700, run: runLoginStep },
    ],
    flows: [loginFlow],
    // A scheduled prompt opens a chat and sends its first message from the
    // bot source; that message is not a person's, so the reply is a background run.
    rules: [
      {
        source: SCHEDULE_SOURCE,
        type: MESSAGE_EVENT,
        start: { flow: "chat:reply" },
        object: "$event.object",
        mode: "auto" as const,
      },
      // The person's own login on a bot; it asks through the agent's login step.
      {
        source: LOGIN_SOURCE,
        type: LOGIN_EVENT,
        start: { flow: "bot:login" },
        object: "$event.object",
        mode: "auto" as const,
      },
    ],
    actions: [chatAction, setupDevAction, setupAction, chatSetupAction, createAction, loginAction, ...proposalActions, ...scheduleActions, ...routineActions, ...followUpActions, ...tidyActions],
    commands: [
      {
        name: "skill",
        args: "<bot> <name> [--from <dir>]",
        run: runSkillCommand,
      },
      {
        name: "mcp",
        args: "<bot> <name> [<command> [args...]]",
        run: runMcpCommand,
      },
      {
        name: "setting",
        args: "<bot>",
        run: runSettingCommand,
      },
      {
        name: "setup-dev",
        args: "<bot> <repository directory> [< dev.json]",
        run: runSetupDev,
      },
      {
        name: "setup-git",
        args: "<bot> <folder> [< {gitignore, identity}]",
        run: runSetupGit,
      },
      {
        name: "setup",
        args: "<bot> <plugin> [target]",
        run: runSetup,
      },
      {
        name: "schedule",
        args: "<bot> add|edit|remove <name> [--words <text>] [--schedule <cron>] [--prompt <text>] [--model <model>] [--effort <effort>]",
        run: runScheduleCommand,
      },
      {
        name: "follow-up",
        args: "<chat> --at <time> --do <one sentence>",
        run: runFollowUpCommand,
      },
      {
        name: "follow-ups",
        args: "<chat> [--cancel <id>]",
        run: runFollowUpsCommand,
      },
    ],
    // A proposal waits for no run; each one is a pending item of its bot.
    standing: async (ctx) => {
      await ingestReports(ctx.store, ctx.home);
      await syncBots(ctx.store, ctx.home, ctx.settings);
      return [...(await proposalItems(ctx.store)), ...(await tidyItems(ctx.store)), ...(await loginItems(ctx))];
    },
    // The bot is its own source for its scheduled prompts and its nightly
    // memory tidy. It declares `start` while staying a domain plugin, so
    // `serve` starts it like any source.
    start: async (ctx) => {
      await migrateDefaultHome(ctx.store, ctx.home, readBots(ctx.home, ctx.settings));
      // Chats the old scheduled prompts and memory tidies opened are closed once (ADR 0030 D10).
      await closeOldScheduledChats(ctx.store, ctx.client);
      const scheduled = await startScheduled(ctx);
      const tidy = await startTidy(ctx);
      return {
        stop: async () => {
          await scheduled.stop();
          await tidy.stop();
        },
      };
    },
    views: { [BOT_TYPE]: botViews, [PROPOSAL_TYPE]: proposalViews, [TIDY_TYPE]: tidyViews, [ROUTINE_TYPE]: routineViews },
  });
}

export default createBotPlugin();

export * from "./bot.ts";
export * from "./create.ts";
export * from "./login.ts";
export * from "./proposals.ts";
export * from "./setup-dev.ts";
export * from "./setup-git.ts";
export * from "./setup.ts";
export * from "./schedule.ts";
export * from "./routine.ts";
export * from "./follow-up.ts";
export * from "./tidy.ts";
export * from "./mcp.ts";
export * from "./mcp-proposals.ts";
export { runGuard, markedResult, MATERIAL_NOTE, reportPath } from "./guard.ts";
export { probeServer, type McpTool } from "./mcp-client.ts";
