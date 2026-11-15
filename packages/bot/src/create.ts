/**
 * Making a bot from what this home already knows: the skills other bots mount,
 * the skills in the standard directories, and the MCP servers a person has
 * already approved on another bot. Only what is chosen is written; nothing is
 * inherited from `default`.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  BotError,
  DEFAULT_BOT,
  botDir,
  expandPath,
  listedSkills,
  readBots,
  resolveBot,
  skillName,
  validateBotName,
  workingDirectory,
  type BotSettings,
  type McpServerSettings,
} from "./bot.ts";
import { secretName } from "./mcp.ts";
import { updateBotsFile, validateBots } from "./proposals.ts";

/** One skill this home already knows, by the name a bot page shows. */
export interface SkillChoice {
  readonly name: string;
  readonly path: string;
}

/** One MCP server a person approved on a bot, and the bot it came from. */
export interface McpServerChoice {
  /** The value a person chooses: the server name, or `<bot>/<server>` when two bots differ. */
  readonly key: string;
  readonly bot: string;
  readonly server: string;
  readonly entry: McpServerSettings;
}

/** The working directory used to read a bot's relative skill paths, even when the bot is broken. */
function cwdOf(home: string, name: string, settings: BotSettings): string {
  try {
    return workingDirectory(home, name, settings);
  } catch {
    return name === DEFAULT_BOT ? botDir(home) : join(botDir(home), name);
  }
}

function addSkill(found: Map<string, SkillChoice>, path: string): void {
  const normal = resolve(path);
  if (found.has(normal)) return;
  found.set(normal, { name: skillName(normal), path: normal });
}

/**
 * The skills this home already knows: every bot's listed skills, including the
 * ones inside a listed directory, and the skills in `~/.agents/skills` when it
 * exists. A bot that cannot be used contributes the paths that can be read.
 */
export function knownSkills(home: string, userHome: string = homedir()): readonly SkillChoice[] {
  const found = new Map<string, SkillChoice>();
  for (const [name, settings] of Object.entries(readBots(home))) {
    const cwd = cwdOf(home, name, settings);
    for (const written of settings.skills ?? []) {
      for (const path of listedSkills(written, cwd).directories) addSkill(found, path);
    }
  }
  const standard = join(userHome, ".agents", "skills");
  for (const path of listedSkills(standard, userHome).directories) addSkill(found, path);
  return [...found.values()].sort(
    (left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
  );
}

/**
 * The MCP servers approved on a bot. An entry is approved when its tool digest
 * is set, which is what makes a chat mount it. A name approved with different
 * entries on several bots is offered as `<bot>/<server>`.
 */
export function knownMcpServers(home: string): readonly McpServerChoice[] {
  const grouped = new Map<string, { readonly bot: string; readonly entry: McpServerSettings }[]>();
  for (const [bot, settings] of Object.entries(readBots(home))) {
    for (const [server, entry] of Object.entries(settings.mcpServers ?? {})) {
      if (entry.digest === undefined) continue;
      const group = grouped.get(server) ?? [];
      group.push({ bot, entry });
      grouped.set(server, group);
    }
  }
  const found: McpServerChoice[] = [];
  for (const [server, group] of grouped) {
    const same = new Set(group.map((item) => JSON.stringify(item.entry))).size === 1;
    if (group.length === 1 || same) {
      const first = group[0];
      if (first !== undefined) found.push({ key: server, bot: first.bot, server, entry: first.entry });
      continue;
    }
    for (const item of group) {
      found.push({ key: `${item.bot}/${server}`, bot: item.bot, server, entry: item.entry });
    }
  }
  return found.sort((left, right) => left.key.localeCompare(right.key));
}

/** One server entry as it was approved, copied field by field. */
function copyEntry(entry: McpServerSettings): McpServerSettings {
  return {
    command: entry.command,
    ...(entry.args === undefined ? {} : { args: [...entry.args] }),
    ...(entry.package === undefined ? {} : { package: entry.package }),
    ...(entry.version === undefined ? {} : { version: entry.version }),
    ...(entry.secrets === undefined ? {} : { secrets: [...entry.secrets] }),
    ...(entry.tools === undefined
      ? {}
      : { tools: entry.tools.map((tool) => ({ name: tool.name, description: tool.description })) }),
    ...(entry.digest === undefined ? {} : { digest: entry.digest }),
  };
}

function add(list: string[], value: string): void {
  const normal = resolve(value);
  if (!list.includes(normal)) list.push(normal);
}

export interface CreateBotInput {
  readonly name: string;
  readonly agent: string;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly speaker?: string | undefined;
  /** Known skills by name, or paths a bot's `skills` setting accepts. */
  readonly skills?: readonly string[] | undefined;
  /** Approved MCP servers, as their choice key. */
  readonly mcpServers?: readonly string[] | undefined;
}

export interface CreateBotOptions {
  /** Where a relative skill path is read from; the home when absent. */
  readonly cwd?: string | undefined;
  readonly userHome?: string | undefined;
}

/** What creating a bot wrote, and the secrets its servers need to start. */
export interface CreatedBot {
  readonly settings: BotSettings;
  /** The secret names of the copied servers, as `<server>.<variable>`. */
  readonly secrets: readonly string[];
}

/**
 * Writes a new bot with exactly the given fields. The name is the same one a
 * bot directory uses and an existing one is refused; skills are the known ones
 * chosen or the paths given; each MCP server is copied from the bot that
 * approved it. No setting comes from `default`.
 */
export async function createBot(
  home: string,
  input: CreateBotInput,
  options: CreateBotOptions = {},
): Promise<CreatedBot> {
  validateBotName(input.name);
  if (input.agent.trim().length === 0) throw new BotError("a new bot needs an agent");
  const bots = readBots(home);
  if (bots[input.name] !== undefined) throw new BotError(`there is already a bot "${input.name}"`);

  const known = knownSkills(home, options.userHome);
  const byName = new Map<string, SkillChoice>();
  const byPath = new Map<string, SkillChoice>();
  for (const skill of known) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
    byPath.set(resolve(skill.path), skill);
  }
  const cwd = options.cwd ?? home;
  const skills: string[] = [];
  const paths: string[] = [];
  for (const value of input.skills ?? []) {
    const chosen = byPath.get(resolve(value)) ?? byName.get(value);
    if (chosen !== undefined) add(skills, chosen.path);
    else paths.push(value);
  }
  for (const value of paths) {
    const expanded = expandPath(value, cwd);
    const listed = listedSkills(value, cwd);
    if (listed.directories.length === 0 && !listed.agents) {
      throw new BotError(`skill "${value}": there is no SKILL.md in ${expanded}`);
    }
    add(skills, expanded);
  }

  const knownServers = knownMcpServers(home);
  const servers: Record<string, McpServerSettings> = {};
  for (const value of input.mcpServers ?? []) {
    const chosen = knownServers.find((item) => item.key === value);
    if (chosen === undefined) {
      throw new BotError(
        `MCP server "${value}" is not approved on another bot; add it with operad bot mcp`,
      );
    }
    servers[chosen.server] = copyEntry(chosen.entry);
  }

  const settings: Record<string, unknown> = { harness: input.agent };
  if (input.model !== undefined) settings.model = input.model;
  if (input.effort !== undefined) settings.effort = input.effort;
  if (input.speaker !== undefined) settings.speaker = input.speaker;
  if (skills.length > 0) settings.skills = skills;
  if (Object.keys(servers).length > 0) settings.mcpServers = servers;

  validateBots({ [input.name]: settings });
  // Refuse a result that could not be used now, such as a skill that vanished.
  resolveBot(home, input.name, settings as BotSettings);

  await updateBotsFile(home, (written) => {
    if (written[input.name] !== undefined) {
      throw new BotError(`there is already a bot "${input.name}"`);
    }
    const next = { ...written, [input.name]: settings };
    validateBots(next);
    return next;
  });

  const secrets: string[] = [];
  for (const [server, entry] of Object.entries(servers)) {
    for (const variable of entry.secrets ?? []) secrets.push(secretName(server, variable));
  }
  return { settings: settings as BotSettings, secrets };
}

