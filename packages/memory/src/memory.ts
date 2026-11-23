/**
 * The memory plugin's settings, the wiki directory and the git repositories the
 * bot's memory and the wiki are kept in. The wiki is a Markdown directory every
 * bot shares; a bot's memory is `memory/` inside its own working directory.
 * Both are used as they are: a directory that is already a git repository keeps
 * its history and layout, and only a directory that is no repository gets one.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findGit, GIT_NOT_INSTALLED, realGitFinderHost } from "@operad-io/engine/platform";
import { configPath, isRecord, prepareSettings, type ActionArgsSchema, type JsonValue } from "@operad-io/engine";

/** The plugin name. */
export const MEMORY_PLUGIN = "memory";

/** The step a chat calls after a reply, when the memory plugin is loaded. */
export const MEMORY_COMMIT_STEP = "memory/commit";

/** The `memory` skill, mounted for every bot while the plugin is enabled. */
export const MEMORY_SKILL_DIR = fileURLToPath(new URL("../skills/memory", import.meta.url));

/** The most of the memory index a reply carries; the tidy step keeps the file below it. */
export const MEMORY_INDEX_MAX = 8000;

/** The wiki directory inside the operad home when the setting is not written. */
export const DEFAULT_WIKI_NAME = "wiki";

/** The JSON Schema of the `memory` section (also shipped as `memory.schema.json`). */
export const MEMORY_SETTINGS: ActionArgsSchema = {
  type: "object",
  properties: {
    wikiDir: {
      type: "string",
      title: "Wiki directory",
      minLength: 1,
      editable: true,
      default: "wiki",
      description:
        "The shared knowledge base: a Markdown directory every bot reads, and the bots whose access profile allows it write. Created when missing and made a git repository when it is not one; a directory that is already a git repository is used as it is, never re-initialised or restructured. `~` is your home directory and a relative path is under the operad home. Default: `wiki` in the operad home, so ~/.operad/wiki for the usual home; a person may point it at a notes library such as an Obsidian vault.",
    },
  },
  additionalProperties: false,
};

/** A `memory` section that cannot be used; the message says why. */
export class MemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryError";
  }
}

/** A path as the memory plugin reads it: `~`, an absolute path, or one under the operad home. */
export function expandMemoryPath(path: string, home: string, userHome: string = homedir()): string {
  if (path === "~") return userHome;
  if (path.startsWith("~/")) return join(userHome, path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(home, path);
}

/** The wiki directory a setting names, with its default. */
export function wikiDirectory(
  home: string,
  settings: Readonly<Record<string, JsonValue>> = {},
  userHome: string = homedir(),
): string {
  const written = settings["wikiDir"];
  const path = typeof written === "string" && written.length > 0 ? written : join(home, DEFAULT_WIKI_NAME);
  return expandMemoryPath(path, home, userHome);
}

/** The `plugins.memory` entry of `config.json`: whether it is on and what it writes. */
function memoryEntry(home: string): { readonly enabled: boolean; readonly settings: unknown } | undefined {
  const path = configPath(home);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  const plugins = isRecord(parsed) ? parsed.plugins : undefined;
  const entry = isRecord(plugins) ? plugins[MEMORY_PLUGIN] : undefined;
  // A plugin may be enabled by its module name alone.
  if (typeof entry === "string") return entry.length > 0 ? { enabled: true, settings: undefined } : undefined;
  if (!isRecord(entry)) return undefined;
  return { enabled: entry.enabled !== false, settings: entry.settings };
}

/** Whether the home configures the memory plugin and has not disabled it. */
export function memoryEnabled(home: string): boolean {
  return memoryEntry(home)?.enabled === true;
}

/**
 * The wiki directory the home's `config.json` names now, without a plugin
 * context: what a bot reads to decide how the wiki is reached.
 */
export function wikiDirectoryOfHome(home: string, userHome: string = homedir()): string {
  const section = memoryEntry(home)?.settings;
  try {
    const settings = prepareSettings(MEMORY_SETTINGS, section, MEMORY_PLUGIN);
    return wikiDirectory(home, settings, userHome);
  } catch {
    return wikiDirectory(home, {}, userHome);
  }
}

/** One git run. */
export interface GitResult {
  readonly ok: boolean;
  readonly out: string;
  readonly err: string;
}

/** Runs git without a shell; output is trimmed. */
export function memoryGit(cwd: string, args: readonly string[]): GitResult {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const program = findGit({ ...realGitFinderHost(), env });
  if (program === undefined) return { ok: false, out: "", err: GIT_NOT_INSTALLED };
  const result = Bun.spawnSync({
    cmd: [program, "-C", cwd, ...args],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  return {
    ok: result.exitCode === 0,
    out: result.stdout.toString().trim(),
    err: result.stderr.toString().trim(),
  };
}

/** A directory and the repository that holds it. */
export interface Repository {
  /** The root of the git work tree. */
  readonly root: string;
  /** The directory given, which is the root when it was initialised here. */
  readonly directory: string;
  /** Whether this call made the repository. */
  readonly created: boolean;
}

/**
 * The repository a directory belongs to, made in the directory when it belongs
 * to none. A directory inside someone else's repository is part of that
 * repository and is used as it is: nothing is initialised again.
 */
export function ensureRepository(directory: string): Repository {
  mkdirSync(directory, { recursive: true });
  // git answers with a real path. Reading the directory through its real path
  // too keeps the two comparable, so a repository that is this directory keeps
  // the name the caller gave it.
  const real = realpathSync(directory);
  const found = memoryGit(real, ["rev-parse", "--show-toplevel"]);
  if (found.ok && found.out.length > 0) {
    const same = found.out === real;
    return { root: same ? directory : found.out, directory: same ? directory : real, created: false };
  }
  const made = memoryGit(real, ["init", "--quiet"]);
  if (!made.ok) {
    throw new MemoryError(`git init in ${directory} failed: ${made.err || "git wrote nothing"}`);
  }
  return { root: directory, directory, created: true };
}

/** The wiki: created when missing, and a repository when it is not one. */
export function ensureWiki(
  home: string,
  settings: Readonly<Record<string, JsonValue>> = {},
): Repository & { readonly path: string } {
  const path = wikiDirectory(home, settings);
  return { ...ensureRepository(path), path };
}

/** The three layers of a bot's memory, made when missing; nothing is overwritten. */
export function ensureMemoryLayout(memoryDir: string): void {
  mkdirSync(join(memoryDir, "log"), { recursive: true });
  const index = join(memoryDir, "index.md");
  if (!existsSync(index)) {
    writeFileSync(index, "# Memory index\n\nOne line per entry. Keep it short: the detail belongs in a topic note.\n");
  }
  const instructions = join(memoryDir, "instructions.md");
  if (!existsSync(instructions)) {
    writeFileSync(instructions, "# Instructions\n\nA person's long-standing instructions to this bot.\n");
  }
}

/** A file a bot's reply carries on its message; the chat plugin reads it and decides what to attach. */
export interface MemoryNote {
  readonly name: string;
  readonly path: string;
  readonly maxChars?: number | undefined;
}

/**
 * The files a bot's reply carries as notes: its memory index, cut at
 * {@link MEMORY_INDEX_MAX}, and the person's instructions. A file that is not
 * there yet is left out; one created later is picked up by the next reply.
 */
export function memoryNotes(memoryDir: string): readonly MemoryNote[] {
  const notes: MemoryNote[] = [];
  const index = join(memoryDir, "index.md");
  if (existsSync(index)) notes.push({ name: "memory/index.md", path: index, maxChars: MEMORY_INDEX_MAX });
  const instructions = join(memoryDir, "instructions.md");
  if (existsSync(instructions)) notes.push({ name: "memory/instructions.md", path: instructions });
  return notes;
}

/** A path inside `root`, as git takes it; `.` for the root itself. */
export function pathIn(root: string, directory: string): string {
  const rel = relative(root, directory);
  return rel === "" ? "." : rel;
}
