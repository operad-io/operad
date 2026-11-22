/**
 * Bots: the `bot` section of `config.json`, read at every use, and what a bot
 * means (its working directory, harness, skills, access profile and speaker).
 * The kernel validates the section against {@link BOT_SETTINGS} when it loads;
 * a reply reads the file again, so an edit applies at once.
 */

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { MCP_REPORT_DIR } from "./mcp-constants.ts";
import { added, hasSkill, isDirectory, skillsInside } from "@operad-io/chat";
import { defaultAccess as builtInAccess } from "@operad-io/access-match";
import { readKeptWorkers, withLockFile, writeFileAtomicSync } from "@operad-io/engine/platform";
import { MEMORY_SKILL_DIR, ensureMemoryLayout, memoryEnabled, wikiDirectoryOfHome } from "@operad-io/memory";
import { configPath, isMissingFile, isRecord, prepareSettings, type ActionArgsSchema, type JsonValue, type ObjectStore } from "@operad-io/engine";

/** The object type of a bot. */
export const BOT_TYPE = "bot";

/** The bot every home has. */
export const DEFAULT_BOT = "default";

/** The directory of the bot inside the operad home. */
export const BOT_DIR = "bot";

const NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** Refuses a name that cannot be a bot's directory under the bot home. */
export function validateBotName(name: string): void {
  if (!NAME.test(name)) {
    throw new BotError(
      `bot "${name}": a name is lowercase letters, digits, "-" and "_", and starts with a letter or digit`,
    );
  }
}

/** The JSON Schema of the `bot` section (also shipped as `bot.schema.json`). */
export const BOT_SETTINGS: ActionArgsSchema = {
  type: "object",
  properties: {
    bots: {
      type: "object",
      title: "Bots",
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
              "The working directory. Without it: ~/.operad/bot/<name>, so the default bot is in ~/.operad/bot/default. It must be inside ~/.operad/bot or outside the operad home.",
          },
          harness: {
            type: "string",
            minLength: 1,
            description: "The agent a new chat uses when it names none.",
          },
          useOwnSettings: {
            type: "boolean",
            title: "Use my own agent settings",
            default: false,
            description:
              "The bot's agent then reads your own configuration of that agent. claude: your settings, instruction files, memory, skills, commands, subagents, plugins and MCP servers; pi: your settings, context files, skills, prompt templates and extensions, whose own code at load is not stopped by the profile; codex and radian always read their own configuration, so this switch does not change them. The bot's access profile still refuses what it refuses. Off by default.",
          },
          skills: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description:
              "Skills given to the agent at every reply; the agent may read them but not change them. A path may be a directory with a SKILL.md, a directory whose direct subdirectories each have one (such as ~/.agents/skills), or a .agents directory (such as ~/.agents), whose skills directory is read the same way. Every skill directly inside such a directory is loaded, including one added later. A relative path is under the working directory.",
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
          accessLevel: {
            type: "string",
            title: "Access level",
            enum: ["plan", "ask", "edits", "full"],
            default: "ask",
            description:
              "The level a chat on this bot starts at, when opened from the desktop, the CLI, the MCP server or Telegram; a chat a scheduled prompt opens starts at full. Unlike `access`, which can only tighten the profile, this can loosen it: `full` asks nothing but the deny rules. A chat that chose a level with /access keeps it; a chat that did not follows this setting. See docs/user/access.md.",
          },
          writeWiki: {
            type: "boolean",
            title: "Write the wiki",
            description:
              "Whether this bot may write the shared wiki. Without it the default bot writes it and every other bot only reads it. Read access is always there; a bot that may not write it has the wiki refused for writing.",
          },
          tidyTime: {
            type: "string",
            title: "Tidy time",
            default: "03:30",
            pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
            description:
              "When the nightly memory check runs, as HH:MM in this machine's local time zone, between 03:00 and 03:59 by default. A missed night is caught up once after the machine wakes.",
          },
          runWithoutAsking: {
            type: "boolean",
            title: "Run without asking",
            description:
              "不询问直接运行. When on, the nightly memory tidy runs without a pending card; off, it waits for Run or Skip. Off by default.",
            default: false,
          },
          backgroundModel: {
            type: "string",
            title: "Background model",
            minLength: 1,
            description:
              "The model a memory tidy uses. Without it the bot's agent declares a cheap model for background work (claude: haiku); a bot with neither uses its own model, else the agent's default.",
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
  readonly useOwnSettings?: boolean | undefined;
  readonly model?: string;
  readonly effort?: string;
  readonly skills?: readonly string[];
  readonly speaker?: string;
  readonly writeWiki?: boolean | undefined;
  readonly tidyTime?: string | undefined;
  readonly runWithoutAsking?: boolean | undefined;
  readonly accessLevel?: "plan" | "ask" | "edits" | "full" | undefined;
  readonly backgroundModel?: string | undefined;
  readonly access?: Readonly<Record<string, JsonValue>>;
}

/** A bot as a chat uses it. */
export interface ResolvedBot {
  readonly name: string;
  readonly cwd: string;
  readonly harness: string | null;
  readonly useOwnSettings: boolean;
  readonly model: string | null;
  readonly effort: string | null;
  /** Absolute directories, each with a SKILL.md. */
  readonly skills: readonly string[];
  readonly speaker: string | null;
  /** Whether this bot may write the shared wiki. */
  readonly writeWiki: boolean;
  /** The level a new chat starts at; `ask` unless the bot sets it. */
  readonly accessLevel: "plan" | "ask" | "edits" | "full";
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
    validateBotName(name);
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

/** A path as the bot reads it: `~`, an absolute path, or one under `base`. */
export function expandPath(path: string, base: string): string {
  return expand(path, base);
}

function within(path: string, directory: string): boolean {
  const rel = relative(directory, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Moves one entry into a directory that may already hold the same name. Two
 * directories are merged child by child, so a move killed halfway leaves every
 * entry on one side or the other and the next run finishes it. A single file
 * or link is renamed, which is atomic.
 */
function mergeInto(source: string, destination: string): void {
  if (!exists(destination)) {
    mkdirSync(resolve(destination, ".."), { recursive: true });
    renameSync(source, destination);
    return;
  }
  const from = lstatSync(source);
  const to = lstatSync(destination);
  if (from.isDirectory() && to.isDirectory()) {
    for (const name of readdirSync(source)) mergeInto(join(source, name), join(destination, name));
    rmSync(source, { recursive: true, force: true });
    return;
  }
  // The new home's copy wins; the old home's copy is dropped, never written over it.
  rmSync(source, { recursive: true, force: true });
}

/** What moving the default bot's old home needs from a caller. */
export interface BotDirectoryMigration {
  /** Bot names whose default directory is under the old home; kept in place. */
  readonly botNames?: readonly string[] | undefined;
  /** Every bot's working directory, including a named `cwd` and a removed bot's. */
  readonly botPaths?: readonly string[] | undefined;
  /** Where claude keeps its per-directory sessions; the environment's own when absent. */
  readonly claudeProjects?: string | undefined;
  /** Where radian keeps session journals; the environment's own when absent. */
  readonly radianSessionDirs?: readonly string[] | undefined;
  /** The grant files recording a working directory; `$OPERAD_HOME/access-user.json` when absent. */
  readonly grantFiles?: readonly string[] | undefined;
  /** Called after each top-level entry moved; a test stops a child process here. */
  readonly afterMove?: ((name: string) => void) | undefined;
  /** Called after a grant file's temporary copy is written and before it replaces the file. */
  readonly beforeGrantRename?: ((temporary: string, file: string) => void) | undefined;
}

/** The marker that says the old default home has been handled. */
const MIGRATION_MARKER = ".moved-to-default";

/** What operad itself creates in the old default bot home; everything else stays there. */
const OWNED_ENTRIES: ReadonlySet<string> = new Set(["skills", "memory"]);

/** A marker with this content means only claude's project directory waits for a retry. */
const CLAUDE_PENDING = "claude";

/** The marker that says the grants which named the old home were rewritten. */
const GRANT_MARKER = ".grants-moved-to-default";

function markerState(marker: string): "done" | "claude" | undefined {
  if (!existsSync(marker)) return undefined;
  try {
    return readFileSync(marker, "utf8").trim() === CLAUDE_PENDING ? CLAUDE_PENDING : "done";
  } catch {
    return "done";
  }
}

function writeMarker(marker: string, pending: boolean): void {
  writeFileAtomicSync(marker, pending ? CLAUDE_PENDING : "");
}

function writeDoneMarker(marker: string): void {
  writeFileAtomicSync(marker, "");
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrites the `cwd` of every grant made in the old default home to the new
 * one. The file's other bytes stay as they were; a missing file, a file with
 * no old cwd and a repeated run write nothing. The replacement is a temporary
 * file renamed over the original, so a crash leaves the old or the new whole.
 */
async function migrateGrantCwds(
  oldCwd: string,
  newCwd: string,
  files: readonly string[],
  beforeRename?: ((temporary: string, file: string) => void) | undefined,
): Promise<boolean> {
  const quotedOld = JSON.stringify(oldCwd);
  const quotedNew = JSON.stringify(newCwd);
  const pattern = new RegExp(`("cwd"\\s*:\\s*)${escaped(quotedOld)}`, "g");
  for (const file of new Set(files)) {
    try {
      // The user layer's normal writer holds this same lock, so a grant added
      // while the home moves is never dropped by the rewrite.
      await withLockFile(
        `${file}.lock`,
        () => {
          let text: string;
          try {
            text = readFileSync(file, "utf8");
          } catch (error) {
            if (isMissingFile(error)) return;
            throw error;
          }
          try {
            JSON.parse(text);
          } catch {
            // A file that is not JSON cannot name the old cwd; leave it as it is
            // and count the file as handled, so every read does not parse it again.
            return;
          }
          const next = text.replace(pattern, (_match: string, prefix: string) => `${prefix}${quotedNew}`);
          if (next === text) return;
          writeFileAtomicSync(file, next, {
            beforeRename: (temporary) => beforeRename?.(temporary, file),
          });
        },
        { label: "access user layer" },
      );
    } catch {
      return false;
    }
  }
  return true;
}

/** Whether a claude worker may still be writing under the old working directory. */
function claudeWorkerRunning(home: string): boolean {
  try {
    return readKeptWorkers(home, "claude").length > 0;
  } catch {
    return true;
  }
}

/** Reads only the first line of a file, without loading the rest. */
function firstLine(file: string): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "r");
    const buffer = Buffer.alloc(4096);
    const read = readSync(descriptor, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, read).toString("utf8");
    const newline = text.indexOf("\n");
    return newline < 0 ? text : text.slice(0, newline);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** The working directories of the bots the settings name now. */
function configuredBotPaths(home: string): string[] {
  const found: string[] = [];
  try {
    for (const [name, settings] of Object.entries(readBots(home))) {
      if (name === DEFAULT_BOT) continue;
      try {
        found.push(workingDirectory(home, name, settings));
      } catch {
        // A bot whose directory is invalid has no path to protect here.
      }
    }
  } catch {
    // A settings file that cannot be read contributes no paths.
  }
  return found;
}

/** The top-level old-home entries that belong to some bot other than the default. */
function protectedEntries(
  root: string,
  target: string,
  options: BotDirectoryMigration,
): Set<string> {
  const found = new Set<string>();
  const add = (path: string): void => {
    if (!within(path, root) || samePath(path, target)) return;
    const rel = relative(root, path);
    if (rel === "") {
      // A bot uses the whole old home, so no entry there is the default bot's.
      for (const name of readdirSync(root)) found.add(name);
      return;
    }
    const [first] = rel.split(/[\\/]/);
    if (first !== undefined && first.length > 0) found.add(first);
  };
  for (const name of options.botNames ?? []) if (name !== DEFAULT_BOT) add(join(root, name));
  for (const path of options.botPaths ?? []) add(path);
  return found;
}

/** The directory claude names for a working directory. */
export function claudeProjectDirectory(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Where claude keeps its project directories. */
export function claudeProjectsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["CLAUDE_CONFIG_DIR"];
  const root = configured !== undefined && configured.length > 0 ? configured : join(homedir(), ".claude");
  return join(root, "projects");
}

/**
 * Claude finds a session under the project directory named for the working
 * directory. Moving the default bot's working directory moves that project
 * directory too, so a chat started before the move still resumes.
 */
export function migrateClaudeSessions(
  oldCwd: string,
  newCwd: string,
  projects: string = claudeProjectsDirectory(),
): void {
  const from = join(projects, claudeProjectDirectory(oldCwd));
  const to = join(projects, claudeProjectDirectory(newCwd));
  if (samePath(from, to) || !existsSync(from)) return;
  mergeInto(from, to);
}

/** The directories radian may keep its session journals in. */
export function radianSessionDirectories(env: NodeJS.ProcessEnv = process.env): string[] {
  const found: string[] = [];
  const explicit = env["RADIAN_SESSION_DIR"];
  if (explicit !== undefined && explicit.length > 0) found.push(explicit);
  const configured = env["RADIAN_HOME"];
  const home = configured !== undefined && configured.length > 0 ? configured : join(homedir(), ".radian");
  found.push(join(home, "sessions"));
  found.push(join(homedir(), ".local", "share", "radian", "sessions"));
  return [...new Set(found)];
}

/**
 * Radian binds a session to the workspace in its `SessionCreated` event.
 * Moving the default bot's old workspace rewrites that one line in every
 * journal it belongs to, leaving the rest of the session as it was. Each
 * rewrite uses a temporary file and a rename, so a crash leaves a whole file.
 */
export function migrateRadianSessions(
  oldCwd: string,
  newCwd: string,
  directories: readonly string[] = radianSessionDirectories(),
): void {
  for (const directory of new Set(directories)) {
    if (!isDirectory(directory)) continue;
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(directory, name);
      const head = firstLine(file);
      if (head === undefined) continue;
      let first: unknown;
      try {
        first = JSON.parse(head);
      } catch {
        continue;
      }
      if (!isRecord(first) || first.event !== "SessionCreated" || !isRecord(first.data)) continue;
      if (first.data.workspace !== oldCwd) continue;
      // Only a journal that names the old workspace is read in full, and rewritten once.
      const text = readFileSync(file, "utf8");
      const newline = text.indexOf("\n");
      const next = JSON.stringify({ ...first, data: { ...first.data, workspace: newCwd } });
      writeFileAtomicSync(file, next + (newline < 0 ? "" : text.slice(newline)));
    }
  }
}

/**
 * Moves only what operad itself made in the old bot home into `default/`: the
 * bot's `skills/` and `memory/`. Every other entry stays where it is, as does
 * another bot's directory and a custom `cwd` for the default bot. The move can
 * be repeated: each entry is renamed once, and directories on both sides are
 * merged. Claude's project directory waits while a claude worker is alive, and
 * the marker says so, so the next read retries it without rescanning journals.
 */
export async function migrateDefaultBotDir(
  home: string,
  options: BotDirectoryMigration = {},
): Promise<readonly string[]> {
  const root = botDir(home);
  const target = join(root, DEFAULT_BOT);
  const marker = join(target, MIGRATION_MARKER);
  const state = markerState(marker);
  const rootExists = existsSync(root);
  const grantMarker = join(target, GRANT_MARKER);
  if (!existsSync(grantMarker)) {
    const grants = options.grantFiles ?? [join(home, "access-user.json")];
    if (await migrateGrantCwds(root, target, grants, options.beforeGrantRename)) writeDoneMarker(grantMarker);
  }
  if (state === "done") return [];
  const moved: string[] = [];
  if (rootExists && state === undefined) {
    const protectedNames = protectedEntries(root, target, {
      ...options,
      botPaths: options.botPaths ?? configuredBotPaths(home),
    });
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name === DEFAULT_BOT || protectedNames.has(entry.name)) continue;
      if (!OWNED_ENTRIES.has(entry.name)) continue;
      mergeInto(join(root, entry.name), join(target, entry.name));
      moved.push(entry.name);
      options.afterMove?.(entry.name);
    }
  }
  // A home without the old directory has no journals to read. Mark it done so
  // it never scans them later when another bot brings the directory back.
  if (state === undefined && rootExists) migrateRadianSessions(root, target, options.radianSessionDirs);
  const projects = options.claudeProjects ?? claudeProjectsDirectory();
  const oldProject = join(projects, claudeProjectDirectory(root));
  const claudePending = existsSync(oldProject) && claudeWorkerRunning(home);
  if (!claudePending) migrateClaudeSessions(root, target, projects);
  // Mark only after every entry and session moved, so a crash halfway runs again.
  if (rootExists || state === CLAUDE_PENDING || state === undefined) writeMarker(marker, claudePending);
  return moved;
}

/** Whether the old default bot home has already been handled, including its grants and claude's retry. */
export function defaultBotHomeMigrated(home: string): boolean {
  const target = join(botDir(home), DEFAULT_BOT);
  return markerState(join(target, MIGRATION_MARKER)) === "done" && existsSync(join(target, GRANT_MARKER));
}

/** The memory directory of a bot. */
export function memoryDir(cwd: string): string {
  return join(cwd, "memory");
}

/**
 * Makes a bot's memory directory, returning it. With the home's memory plugin
 * enabled, its three layers are made too; nothing that is there is overwritten.
 */
export function ensureBotMemory(cwd: string, home?: string): string {
  const memory = memoryDir(cwd);
  mkdirSync(memory, { recursive: true });
  if (home !== undefined && memoryEnabled(home)) ensureMemoryLayout(memory);
  return memory;
}

/** The directories no bot may read or write: every other bot's. */
function siblingDirectories(home: string, ownCwd: string, defaultBot: boolean): string[] {
  const root = botDir(home);
  const ownIsRoot = samePath(ownCwd, root);
  const found = new Set<string>();
  const sibling = (path: string): boolean => {
    if (samePath(path, ownCwd)) return false;
    if (!ownIsRoot && (within(ownCwd, path) || within(path, ownCwd))) return false;
    if (ownIsRoot && (samePath(path, join(root, "memory")) || samePath(path, join(root, "skills")))) return false;
    return true;
  };
  // The default bot kept access to the old bot home, so only another bot's
  // directory is denied there. Another bot still denies every entry it does
  // not own, so the default bot's old files are not exposed to it. A bot
  // directory has a `memory/`; a person's other old-home directory does not.
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name);
      if (defaultBot && !existsSync(join(path, "memory"))) continue;
      if (sibling(path)) found.add(path);
    }
  }
  for (const [name, settings] of Object.entries(readBots(home))) {
    try {
      const path = workingDirectory(home, name, settings);
      if (sibling(path)) found.add(path);
    } catch {
      // A bot whose own directory cannot be read contributes no path here.
    }
  }
  return [...found].sort();
}

/**
 * The default access profile of a bot: the built-in default, with the operad
 * home and the operad command added. Everything in the operad home except the
 * bot's own directory is denied: the names that are there now, and the ones
 * operad keeps there. Paths are absolute, so a home other than `~/.operad` is
 * covered too. The agent reaches operad through its tools, never a shell.
 */
export function defaultAccess(home: string, wikiWrite = false): Record<string, JsonValue> {
  const inHome = new Set(["store", "secrets", "config.json", MCP_REPORT_DIR]);
  // The wiki is named even when it does not exist yet, so a bot's reach does
  // not change when the memory plugin creates it. A bot that may write it has
  // the wiki's entry in the home deny left out; one that may only read it has
  // the entry and a read path through it.
  const wikiName = wikiHomeName(home, wikiDirectoryOfHome(home));
  if (wikiName !== undefined && wikiName !== BOT_DIR && !wikiWrite) inHome.add(wikiName);
  const skipped = wikiWrite && wikiName !== undefined ? wikiName : undefined;
  if (existsSync(home)) {
    for (const name of readdirSync(home)) {
      if (name !== BOT_DIR && name !== skipped) inHome.add(name);
    }
  }
  const base = builtInAccess();
  return {
    denyPaths: [
      ...(base.denyPaths ?? []),
      ...[...inHome].sort().map((name) => join(home, name)),
    ],
    denyCommands: ["operad", ...(base.denyCommands ?? [])],
    askCommands: [...(base.askCommands ?? [])],
    askPaths: [...(base.askPaths ?? [])],
  };
}

/** The first path segment of the wiki under the home, when it is inside it. */
function wikiHomeName(home: string, wiki: string): string | undefined {
  const rel = relative(home, wiki);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  const [first] = rel.split(/[\\/]/);
  return first !== undefined && first.length > 0 ? first : undefined;
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
  readPaths: readonly string[] = [],
  cwd?: string,
  defaultBot = false,
): Record<string, JsonValue> {
  const writeWiki = settings.writeWiki ?? defaultBot;
  const wiki = wikiDirectoryOfHome(home);
  const access = defaultAccess(home, writeWiki);
  // A repository is reached through operad's tools (dev's verbs), never by
  // touching its files, so its path is denied to the agent. Skill directories
  // are changed only through a proposal a person confirms, so they are denied
  // for writing too; `readPaths` lets the agent read them without lifting the
  // deny (the harness still receives their paths as skills). Every other bot's
  // directory is denied too, for reading and writing.
  const siblings = cwd === undefined ? [] : siblingDirectories(home, cwd, defaultBot);
  access.denyPaths = appended(access.denyPaths, [...repositories, ...skillPaths, ...siblings]);
  // A wiki a bot may not write is refused for writing wherever it is, and a
  // read path lets it read through that deny.
  if (!writeWiki) {
    access.denyPaths = appended(access.denyPaths, [wiki]);
    access.readPaths = appended(access.readPaths, [wiki]);
  }
  if (readPaths.length > 0) access.readPaths = appended(access.readPaths, readPaths);
  const own = settings.access ?? {};
  for (const field of ["denyPaths", "denyCommands", "askCommands", "askPaths"] as const) {
    access[field] = appended(access[field], own[field]);
  }
  if (own.readOnly === true) access.readOnly = true;
  // The field puts MCP tools under the profile: one not listed asks first.
  access.allowMcp = appended([], settings.mcpAllow);
  return access;
}

/** What one written skill path names now, without refusing one that is merely empty. */
export interface ListedSkills {
  /** The skill directories directly inside it, or itself when it holds a SKILL.md. */
  readonly directories: string[];
  /** True when the path is a `.agents` directory, whose `skills` directory is read. */
  readonly agents: boolean;
}

/** Reads a written skill path: a skill, a directory of skills, or a `.agents` directory. */
export function listedSkills(written: string, cwd: string): ListedSkills {
  const path = expand(written, cwd);
  if (hasSkill(path)) return { directories: [path], agents: false };
  const agents = isDirectory(path) && basename(path) === ".agents";
  return { directories: skillsInside(agents ? join(path, "skills") : path), agents };
}

interface SkillList {
  /** The skill directories given to the agent. */
  readonly directories: string[];
  /** The directories a listed path names, denied for writing. */
  readonly roots: string[];
}

/**
 * The skills a bot lists, read now. A path may be a skill itself, a directory
 * of skills (such as `~/.agents/skills`), or a `.agents` directory (such as
 * `~/.agents`), whose `skills` directory is read the same way. Every skill
 * directly inside is included, so one added later is read at the next reply.
 */
function skillList(settings: BotSettings, cwd: string): SkillList {
  const directories: string[] = [];
  const roots: string[] = [];
  for (const written of settings.skills ?? []) {
    const path = expand(written, cwd);
    if (hasSkill(path)) {
      added(roots, path);
      added(directories, path);
      continue;
    }
    const agents = isDirectory(path) && basename(path) === ".agents";
    const parent = agents ? join(path, "skills") : path;
    if (isDirectory(path)) added(roots, parent);
    const inside = skillsInside(parent);
    if (inside.length > 0) {
      for (const skill of inside) added(directories, skill);
      continue;
    }
    // A `.agents` directory may get its first skill after the setting is written.
    if (agents) continue;
    throw new BotError(`skill "${written}": there is no SKILL.md in ${path}`);
  }
  return { directories, roots };
}

/** The name a skill's SKILL.md gives, else its directory name. */
export function skillName(path: string): string {
  try {
    const found = /^name:\s*(\S+)/m.exec(readFileSync(join(path, "SKILL.md"), "utf8"))?.[1];
    if (found !== undefined) return found.replace(/^["']|["']$/g, "");
  } catch {
    // A page can still name a skill whose SKILL.md cannot be read.
  }
  return basename(path);
}

/** The working directory of a bot; refused when it would put the operad home in reach. */
export function workingDirectory(home: string, name: string, settings: BotSettings): string {
  const root = botDir(home);
  const cwd = settings.cwd === undefined ? join(root, name) : expand(settings.cwd, root);
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

/** One bot as a chat uses it now; its working directory and memory are created here. */
export function resolveBot(
  home: string,
  name: string,
  settings: BotSettings,
  repositories: readonly string[] = [],
): ResolvedBot {
  const cwd = workingDirectory(home, name, settings);
  ensureBotMemory(cwd, home);
  const list = skillList(settings, cwd);
  const skills = [...list.directories];
  const skillPaths = [...list.roots, join(cwd, "skills")];
  // The memory skill is mounted for every bot while the memory plugin is
  // enabled, so a bot that lists no skills still knows where its memory is.
  if (memoryEnabled(home)) {
    added(skills, MEMORY_SKILL_DIR);
    added(skillPaths, MEMORY_SKILL_DIR);
  }
  return {
    name,
    cwd,
    harness: settings.harness ?? null,
    useOwnSettings: settings.useOwnSettings === true,
    model: settings.model ?? null,
    effort: settings.effort ?? null,
    skills,
    speaker: settings.speaker ?? null,
    writeWiki: settings.writeWiki ?? name === DEFAULT_BOT,
    accessLevel: settings.accessLevel ?? "ask",
    access: accessFor(home, settings, repositories, skillPaths, skillPaths, cwd, name === DEFAULT_BOT),
    mcpServers: settings.mcpServers ?? {},
  };
}
