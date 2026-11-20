/**
 * Recording what a bot wrote: one commit per reply run in each repository the
 * run changed, in the bot's memory and in the shared wiki. Content a note marks
 * as coming from untrusted material is kept out of `memory/index.md`; the note
 * itself stays where it was written.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withLockFile } from "@operad-io/engine/platform";
import { isRecord, type JsonValue, type PluginStepResult, type StepContext } from "@operad-io/engine";
import {
  MEMORY_COMMIT_STEP,
  ensureMemoryLayout,
  ensureRepository,
  ensureWiki,
  memoryGit,
  pathIn,
  type Repository,
} from "./memory.ts";
import {
  TIDY_APPEND_ONLY_NOTE,
  TIDY_COMMIT_FACT,
  TIDY_ORIGIN,
  applyAppendOnly,
  lastTidyCommit,
  rewriteDrop,
} from "./tidy.ts";

/** The lock one home's memory commits take turns under. */
export const COMMIT_LOCK = "memory-commit.lock";

/** The identity a commit is made with, so a home without one still records its writes. */
const COMMIT_IDENTITY: readonly string[] = [
  "-c",
  "user.name=operad memory",
  "-c",
  "user.email=memory@operad.local",
  "-c",
  "commit.gpgsign=false",
];

/** One commit the step made. */
export interface CommitInfo {
  /** The repository root. */
  readonly root: string;
  /** The paths, relative to the root, that the commit holds. */
  readonly paths: readonly string[];
  /** The commit's subject. */
  readonly message: string;
}

/** A note whose frontmatter says it came from untrusted content. */
export function untrustedNotes(memoryDir: string): string[] {
  const found: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(path, rel);
        continue;
      }
      if (!entry.name.endsWith(".md") || rel === "index.md") continue;
      if (isUntrusted(path)) found.push(rel);
    }
  };
  visit(memoryDir, "");
  return found.sort();
}

/** Reads only the YAML frontmatter of a note; `untrusted: true` marks it. */
function isUntrusted(path: string): boolean {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  const lines = text.split("\n");
  if ((lines[0] ?? "").trim() !== "---") return false;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "---") return false;
    if (/^untrusted:\s*true\s*$/i.test(line.trim())) return true;
  }
  return false;
}

/**
 * The index without the lines that link to an untrusted note. A whole line goes,
 * because one line is one entry; every other line stays as it was. A link is a
 * Markdown link or a wikilink, and either may leave out the note's `.md`. Only a
 * Markdown target can be URL-encoded; a wikilink is read as it was written, and
 * a wikilink with no folder names a note in any folder.
 */
export function withoutUntrustedLines(index: string, untrusted: readonly string[]): string {
  if (untrusted.length === 0) return index;
  const kept: string[] = [];
  for (const line of index.split("\n")) {
    const links = [
      ...[...line.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => ({
        target: linkPath(match[1] ?? ""),
        markdown: true,
      })),
      ...[...line.matchAll(/\[\[([^[\]]+)\]\]/g)].map((match) => ({
        target: linkPath(wikilinkTarget(match[1] ?? "")),
        markdown: false,
      })),
    ];
    const marked = links.some(({ target, markdown }) =>
      markdown ? markdownLinksNote(target, untrusted) : wikilinkLinksNote(target, untrusted),
    );
    if (!marked) kept.push(line);
  }
  return kept.join("\n");
}

/** A wikilink's target without its alias; a table row escapes the pipe as `\|`. */
function wikilinkTarget(body: string): string {
  const target = body.split("|")[0] ?? "";
  return target.endsWith("\\") ? target.slice(0, -1) : target;
}

/** A link target as a path: no `./`, no heading and no surrounding space. */
function linkPath(target: string): string {
  return target.trim().replace(/^\.\//, "").split("#")[0] ?? "";
}

/** `decodeURIComponent`, or undefined when a bare `%` makes the target unreadable. */
function decodeLinkPath(path: string): string | undefined {
  try {
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
}

/** Whether a Markdown link target names an untrusted note; the target is a path from the index. */
function markdownLinksNote(path: string, untrusted: readonly string[]): boolean {
  const decoded = decodeLinkPath(path);
  return untrusted.some(
    (note) =>
      note === path || (decoded !== undefined && note === decoded) || note === `${path}.md`,
  );
}

/** Whether a wikilink target names an untrusted note; a bare name names a note in any folder. */
function wikilinkLinksNote(path: string, untrusted: readonly string[]): boolean {
  if (path.length === 0) return false;
  const name = path.replace(/\.md$/, "");
  return untrusted.some((note) => {
    const noteName = note.replace(/\.md$/, "");
    const bare = path.includes("/") ? noteName : (noteName.split("/").pop() ?? "");
    return bare === name;
  });
}

/** Keeps untrusted notes out of the bot's index; returns the notes it removed a line for. */
export function stripUntrustedFromIndex(memoryDir: string): { readonly removed: readonly string[]; readonly changed: boolean } {
  const index = join(memoryDir, "index.md");
  if (!existsSync(index)) return { removed: [], changed: false };
  const notes = untrustedNotes(memoryDir);
  const text = readFileSync(index, "utf8");
  const next = withoutUntrustedLines(text, notes);
  if (next === text) return { removed: [], changed: false };
  writeFileSync(index, next);
  return { removed: notes, changed: true };
}

/**
 * Commits the changes under one directory of a repository, and nothing else.
 * An unchanged directory makes no commit, so a run that wrote nothing records
 * nothing. Returns undefined for that case.
 */
export function commitChanges(
  repository: Repository,
  directory: string,
  message: string,
  options: { readonly allowEmpty?: boolean | undefined } = {},
): CommitInfo | undefined {
  const paths = pathIn(repository.root, directory);
  const status = memoryGit(repository.root, ["status", "--porcelain", "--", paths]);
  if (!status.ok) {
    throw new Error(`git status in ${repository.root} failed: ${status.err || "git wrote nothing"}`);
  }
  if (status.out.length === 0 && options.allowEmpty !== true) return undefined;
  const added = memoryGit(repository.root, ["add", "-A", "--", paths]);
  if (!added.ok) {
    throw new Error(`git add in ${repository.root} failed: ${added.err || "git wrote nothing"}`);
  }
  const committed = memoryGit(repository.root, [
    ...COMMIT_IDENTITY,
    "commit",
    ...(options.allowEmpty === true ? ["--allow-empty"] : []),
    "--no-verify",
    "-m",
    message,
    "--",
    paths,
  ]);
  if (!committed.ok) {
    throw new Error(`git commit in ${repository.root} failed: ${committed.err || "git wrote nothing"}`);
  }
  return { root: repository.root, paths: [paths], message };
}

/** What one bot run changed, as the step reports it. */
export interface MemoryCommitData {
  readonly bot: string;
  readonly chat: string;
  readonly memory: CommitInfo | null;
  readonly wiki: CommitInfo | null;
  readonly unindexed: readonly string[];
}

/** The bot and chat a commit step was called for. */
interface BotChat {
  readonly bot: string;
  readonly chat: string;
  readonly cwd: string;
  /** A tidy run's chat; its commit is what the next check measures from. */
  readonly tidy: boolean;
}

function scheduledOrigin(stored: Readonly<Record<string, unknown>>): string | undefined {
  const scheduled = stored["scheduled"];
  return isRecord(scheduled) && typeof scheduled["entry"] === "string"
    ? scheduled["entry"]
    : undefined;
}

function botChatOf(stored: Readonly<Record<string, unknown>> | undefined, chat: string): BotChat | undefined {
  if (stored === undefined) return undefined;
  const parent = typeof stored["parent"] === "string" ? stored["parent"] : "";
  const cwd = typeof stored["cwd"] === "string" ? stored["cwd"] : "";
  if (!parent.startsWith("bot:") || cwd.length === 0) return undefined;
  return {
    bot: parent.slice("bot:".length),
    chat,
    cwd,
    tidy: scheduledOrigin(stored) === TIDY_ORIGIN,
  };
}

/**
 * The message a commit names the bot and the chat with. The two repositories
 * get a word each, so a person reading `git log` sees which part changed.
 */
export function commitMessage(part: "memory" | "wiki" | "tidy", bot: string, chat: string): string {
  return `${part}: bot ${bot}, chat ${chat}`;
}

/** Commits the bot's memory and the shared wiki; throws with the reason when git refuses. */
export async function commitBotRun(
  home: string,
  bot: BotChat,
  settings: Readonly<Record<string, JsonValue>>,
): Promise<MemoryCommitData> {
  return withLockFile(
    join(home, COMMIT_LOCK),
    () => {
      const memoryDir = join(bot.cwd, "memory");
      ensureMemoryLayout(memoryDir);
      const index = stripUntrustedFromIndex(memoryDir);
      const repository = ensureRepository(memoryDir);
      let message = commitMessage(bot.tidy ? "tidy" : "memory", bot.bot, bot.chat);
      if (bot.tidy) {
        const baseline = lastTidyCommit(repository, memoryDir, bot.bot);
        if (baseline !== undefined && rewriteDrop(repository, memoryDir, baseline).voided) {
          applyAppendOnly(repository, memoryDir, baseline);
          message = `${message}\n\n${TIDY_APPEND_ONLY_NOTE}`;
        }
      }
      const memory = commitChanges(repository, memoryDir, message, { allowEmpty: bot.tidy });
      const wiki = ensureWiki(home, settings);
      const wikiIndex = stripUntrustedFromIndex(wiki.directory);
      const wikiCommit = commitChanges(wiki, wiki.directory, commitMessage("wiki", bot.bot, bot.chat));
      return {
        bot: bot.bot,
        chat: bot.chat,
        memory: memory ?? null,
        wiki: wikiCommit ?? null,
        unindexed: [...new Set([...index.removed, ...wikiIndex.removed])],
      };
    },
    { label: "memory" },
  );
}

/**
 * Step `memory/commit`: called after a bot chat's reply. It writes nothing of
 * the bot's own; it records what the run wrote, in one commit per repository.
 */
export async function runMemoryCommit(ctx: StepContext, params: unknown): Promise<PluginStepResult> {
  const fromParams = isRecord(params) && typeof params.chat === "string" ? params.chat : undefined;
  const chat = fromParams ?? (ctx.object?.type === "chat" ? ctx.object.id : undefined);
  if (chat === undefined) {
    return { result: "failed", data: { message: `${MEMORY_COMMIT_STEP} needs the chat it follows` } };
  }
  const stored = await ctx.store.get("chat", chat);
  const target = botChatOf(stored?.data, chat);
  if (target === undefined) {
    return { result: "done", data: { skipped: "not a chat of a bot" } };
  }
  let outcome: PluginStepResult;
  try {
    const data = await commitBotRun(ctx.home, target, ctx.settings);
    outcome = { result: "done", data: data as unknown as Record<string, JsonValue> };
  } catch (error) {
    outcome = {
      result: "failed",
      data: { message: error instanceof Error ? error.message : String(error) },
    };
  }
  if (target.tidy) {
    await ctx.facts.append({
      type: TIDY_COMMIT_FACT,
      object: { type: "chat", id: chat },
      data: { chat, ok: outcome.result === "done" },
    });
  }
  return outcome;
}

