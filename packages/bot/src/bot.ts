/**
 * Bots: the `bot` section of `config.json`, read at every use, and what a bot
 * means (its working directory, harness, skills, access profile and speaker).
 * The kernel validates the section against {@link BOT_SETTINGS} when it loads;
 * a reply reads the file again, so an edit applies at once.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { MCP_REPORT_DIR } from "./mcp-constants.ts";
import { configPath, isRecord, prepareSettings, type ActionArgsSchema, type JsonValue, type ObjectStore } from "@operad-io/engine";

/** The object type of a bot. */
export const BOT_TYPE = "bot";

/** The bot every home has. */
export const DEFAULT_BOT = "default";

/** The directory of the bot inside the operad home. */
export const BOT_DIR = "bot";

const NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** The JSON Schema of the `bot` section (also shipped as `bot.schema.json`). */
export const BOT_SETTINGS: ActionArgsSchema = {
  type: "object",
  properties: {
    bots: {
      type: "object",
      editable: true,
      description:
        "The bots, by name. `default` exists even when it is not written here.",
      additionalProperties: {
        type: "object",
        description: "One bot.",
        properties: {
          cwd: {
            type: "string",
            minLength: 1,
            description:
              "The working directory. Without it: ~/.operad/bot for `default`, ~/.operad/bot/<name> for any other. It must be inside ~/.operad/bot or outside the operad home.",
          },
          harness: {
            type: "string",
            minLength: 1,
            description: "The agent a new chat uses when it names none.",
          },
          skills: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description:
              "Directories with a SKILL.md, given to the agent at every reply. A relative path is under the working directory.",
          },
          model: {
            type: "string",
            minLength: 1,
            description: "The model a new chat starts with; it must be one the chat's agent lists. Without it the agent's default.",
          },
          effort: {
            type: "string",
            minLength: 1,
            description: "The effort a new chat starts with; it must be one the chat's agent lists. Without it the agent's default.",
          },
          speaker: {
            type: "string",
            minLength: 1,
            description:
              "How a chat of this bot labels the model's messages in its transcript. Without it the chat plugin's speaker is used.",
          },
          mcpServers: {
            type: "object",
            description:
              "The local MCP servers this bot's chats mount, by name. A server is added only through `bot mcp`, which a person approves; the digest is of its tool names and descriptions, and a chat that finds other tools does not mount the server.",
            additionalProperties: {
              type: "object",
              description: "One local MCP server.",
              properties: {
                command: { type: "string", minLength: 1, description: "The program that starts the server." },
                args: { type: "array", items: { type: "string" }, description: "Its arguments." },
                package: { type: "string", minLength: 1, description: "The package the command runs, when it runs one." },
                version: { type: "string", minLength: 1, description: "The pinned version of that package." },
                secrets: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                  description:
                    "Environment variables the server needs. Each value is the bot plugin's secret `<server>.<variable>`, given to the server only when it starts.",
                },
                tools: {
                  type: "array",
                  description: "The tools the server offered when a person approved it.",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string", minLength: 1 },
                      description: { type: "string" },
                    },
                    additionalProperties: false,
                  },
                },
                digest: { type: "string", minLength: 1, description: "The digest of the tool names and descriptions." },
              },
              additionalProperties: false,
            },
          },
          mcpAllow: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description:
              "MCP tools that run without asking, as `<server>.<tool>` or `<server>.*`. A tool not listed counts as a write and asks first.",
          },
          access: {
            type: "object",
            description:
              "Added to the default access profile: the lists are appended and readOnly can be turned on. A bot can tighten the default, never loosen it.",
            properties: {
              denyPaths: { type: "array", items: { type: "string" } },
              denyCommands: { type: "array", items: { type: "string" } },
              askCommands: { type: "array", items: { type: "string" } },
              askPaths: { type: "array", items: { type: "string" } },
              readOnly: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

/** One local MCP server of a bot, as written in its settings. */
export interface McpServerSettings {
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly package?: string | undefined;
  readonly version?: string | undefined;
  readonly secrets?: readonly string[] | undefined;
  readonly tools?: readonly { readonly name: string; readonly description: string }[] | undefined;
  readonly digest?: string | undefined;
}

/** One bot as written. */
export interface BotSettings {
  readonly mcpServers?: Readonly<Record<string, McpServerSettings>> | undefined;
  readonly mcpAllow?: readonly string[] | undefined;
  readonly cwd?: string;
  readonly harness?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly skills?: readonly string[];
  readonly speaker?: string;
  readonly access?: Readonly<Record<string, JsonValue>>;
}

/** A bot as a chat uses it. */
export interface ResolvedBot {
  readonly name: string;
  readonly cwd: string;
  readonly harness: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  /** Absolute directories, each with a SKILL.md. */
  readonly skills: readonly string[];
  readonly speaker: string | null;
  readonly access: Readonly<Record<string, JsonValue>>;
  /** The local MCP servers the bot lists, by name. */
  readonly mcpServers: Readonly<Record<string, McpServerSettings>>;
}

/** A bot that cannot be used; the message says why. */
export class BotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotError";
  }
}

/** The `bot` working directory of a home. */
export function botDir(home: string): string {
  return join(home, BOT_DIR);
}

/**
 * The bots written in the home's `config.json`, with the default one added
 * when absent. The file is read now; `fallback` (the settings the kernel
 * loaded) stands in only when the file or its section is missing.
 */
export function readBots(
  home: string,
  fallback: Readonly<Record<string, JsonValue>> = {},
): Readonly<Record<string, BotSettings>> {
  let section: unknown = fallback;
  const path = configPath(home);
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new BotError(`${path}: cannot read the bot settings: ${String(error)}`);
    }
    const plugins = isRecord(parsed) ? parsed.plugins : undefined;
    const entry = isRecord(plugins) ? plugins.bot : undefined;
    if (isRecord(entry) && entry.settings !== undefined) section = entry.settings;
  }
  const settings = prepareSettings(BOT_SETTINGS, section, "bot");
  const bots = isRecord(settings.bots) ? settings.bots : {};
  const found: Record<string, BotSettings> = {};
  for (const [name, value] of Object.entries(bots)) {
    if (!NAME.test(name)) {
      throw new BotError(
        `bot "${name}": a name is lowercase letters, digits, "-" and "_", and starts with a letter or digit`,
      );
    }
    found[name] = value as BotSettings;
  }
  if (found[DEFAULT_BOT] === undefined) found[DEFAULT_BOT] = {};
  return found;
}

function expand(path: string, base: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(base, path);
}

function within(path: string, directory: string): boolean {
  const rel = relative(directory, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The default access profile of a bot: no credentials, no secrets, no operad
 * command (the agent reaches operad through its tools). Everything in the
 * operad home except the bot's own directory is denied: the names that are
 * there now, and the ones operad keeps there. Paths are absolute, so a home
 * other than `~/.operad` is covered too.
 */
export function defaultAccess(home: string): Record<string, JsonValue> {
  const inHome = new Set(["store", "secrets", "config.json", MCP_REPORT_DIR]);
  if (existsSync(home)) {
    for (const name of readdirSync(home)) if (name !== BOT_DIR) inHome.add(name);
  }
  return {
    denyPaths: [
      "~/.ssh",
      "~/.gnupg",
      "~/.aws",
      "~/.config/gh",
      "~/.radian",
      "~/Library/Keychains",
      "~/Library/Application Support/Google/Chrome",
      "~/Library/Application Support/Firefox",
      "~/Library/Safari",
      ".git/config",
      ".git/hooks",
      ...[...inHome].sort().map((name) => join(home, name)),
    ],
    denyCommands: [
      "operad",
      "sudo",
      "su",
      "rm -rf /",
      "rm -rf ~",
      "mkfs",
      "dd",
      "diskutil",
      "shutdown",
      "reboot",
      "launchctl",
      "crontab -r",
      "git push --force*",
      "git push --delete",
      "curl … | sh",
      "wget … | sh",
      "pkill",
      "killall",
    ],
    askCommands: ["git push", "brew install", "npm install -g", "pip install", "osascript", "open"],
    askPaths: ["~/.zshrc", "~/.*profile"],
  };
}

function appended(base: JsonValue | undefined, extra: unknown): JsonValue[] {
  const list = Array.isArray(base) ? [...base] : [];
  if (Array.isArray(extra)) {
    for (const item of extra) if (typeof item === "string" && !list.includes(item)) list.push(item);
  }
  return list;
}

/** The access profile of a bot: the default, tightened by what the bot adds. */
export function accessFor(
  home: string,
  settings: BotSettings,
  repositories: readonly string[] = [],
  skillPaths: readonly string[] = [],
): Record<string, JsonValue> {
  const access = defaultAccess(home);
  // A repository is reached through operad's tools (dev's verbs), never by
  // touching its files, so its path is denied to the agent. Skill directories
  // are changed only through a proposal a person confirms, so they are denied
  // to the agent too (the harness still receives their paths as skills).
  access.denyPaths = appended(access.denyPaths, [...repositories, ...skillPaths]);
  const own = settings.access ?? {};
  for (const field of ["denyPaths", "denyCommands", "askCommands", "askPaths"] as const) {
    access[field] = appended(access[field], own[field]);
  }
  if (own.readOnly === true) access.readOnly = true;
  // The field puts MCP tools under the profile: one not listed asks first.
  access.allowMcp = appended([], settings.mcpAllow);
  return access;
}

/** The skill directories of a bot, checked now. */
function skillDirectories(settings: BotSettings, cwd: string): string[] {
  return (settings.skills ?? []).map((written) => {
    const path = expand(written, cwd);
    const file = join(path, "SKILL.md");
    if (!existsSync(file) || !statSync(file).isFile()) {
      throw new BotError(`skill "${written}": there is no SKILL.md in ${path}`);
    }
    return path;
  });
}

/** The working directory of a bot; refused when it would put the operad home in reach. */
export function workingDirectory(home: string, name: string, settings: BotSettings): string {
  const root = botDir(home);
  const cwd =
    settings.cwd === undefined
      ? name === DEFAULT_BOT
        ? root
        : join(root, name)
      : expand(settings.cwd, root);
  if (within(home, cwd)) {
    throw new BotError(
      `bot "${name}": the working directory ${cwd} is the operad home or holds it; use a subdirectory of ${root}`,
    );
  }
  if (within(cwd, home) && !within(cwd, root)) {
    throw new BotError(
      `bot "${name}": the working directory ${cwd} is inside the operad home but outside ${root}`,
    );
  }
  return cwd;
}

/** The paths of the repositories dev knows, from the object store. */
export async function repositoryPaths(store: ObjectStore): Promise<string[]> {
  const found: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list("repo", { ...(cursor === undefined ? {} : { cursor }) });
    for (const object of page.objects) {
      if (typeof object.data.path === "string" && object.data.path.length > 0) found.push(object.data.path);
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return found;
}

/** One bot as a chat uses it now; the working directory is not created here. */
export function resolveBot(
  home: string,
  name: string,
  settings: BotSettings,
  repositories: readonly string[] = [],
): ResolvedBot {
  const cwd = workingDirectory(home, name, settings);
  const skills = skillDirectories(settings, cwd);
  return {
    name,
    cwd,
    harness: settings.harness ?? null,
    model: settings.model ?? null,
    effort: settings.effort ?? null,
    skills,
    speaker: settings.speaker ?? null,
    access: accessFor(home, settings, repositories, [...skills, join(cwd, "skills")]),
    mcpServers: settings.mcpServers ?? {},
  };
}
