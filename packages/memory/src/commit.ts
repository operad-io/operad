/**
 * Recording what a bot wrote: one commit per reply run in each repository the
 * run changed, in the bot's memory and in the shared wiki. Content a note marks
 * as coming from untrusted material is kept out of `memory/index.md`; the note
 * itself stays where it was written.
 */

import { messageOf } from "@operad-io/engine";
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
  restoreInstructions,
  lastTidyCommit,
  rewriteDrop,
} from "./tidy.ts";
import { parseNoteLinks, resolveNoteLink } from "./links.ts";

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
  /** The notes the commit changed, each with a one-line summary. */
  readonly files: readonly WrittenNote[];
}

/** One note a commit changed: its file, named from the repository's label, and a one-line summary. */
export interface WrittenNote {
  readonly file: string;
  readonly summary: string;
}

/** The longest summary kept for a note. */
const SUMMARY_MAX = 120;

function cutSummary(text: string): string {
  const chars = [...text];
  return chars.length <= SUMMARY_MAX ? text : `${chars.slice(0, SUMMARY_MAX - 1).join("")}…`;
}

/** The one line that says what a note is: its frontmatter `description`, `summary` or `title`, else its first heading or line. */
export function noteSummary(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  if ((lines[0] ?? "").trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end > 0) {
      start = end + 1;
      for (const key of ["description", "summary", "title"]) {
        for (const line of lines.slice(1, end)) {
          const trimmed = line.trim();
          if (!trimmed.toLowerCase().startsWith(`${key}:`)) continue;
          const value = trimmed.slice(key.length + 1).trim().replace(/^["']|["']$/g, "").trim();
          if (value.length > 0) return cutSummary(value);
        }
      }
    }
  }
  for (const line of lines.slice(start)) {
    const clean = line.replace(/^#+\s*/, "").trim();
    if (clean.length > 0) return cutSummary(clean);
  }
  return "";
}

/** The notes a staged change touches, with a summary of each note as it now is; a deleted note says so. */
function stagedNotes(repository: Repository, paths: string, label: string): readonly WrittenNote[] {
  const listed = memoryGit(repository.root, ["diff", "--cached", "--name-status", "--no-renames", "-z", "--", paths]);
  if (!listed.ok) return [];
  const parts = listed.out.split("\0").filter((part) => part.length > 0);
  const notes: WrittenNote[] = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const status = parts[index] ?? "";
    const path = parts[index + 1] ?? "";
    if (!path.endsWith(".md")) continue;
    const inside = paths === "." ? path : path.slice(paths.length + 1);
    let summary = "";
    if (!status.startsWith("D")) {
      try {
        summary = noteSummary(readFileSync(join(repository.root, path), "utf8"));
      } catch {
        summary = "";
      }
    }
    notes.push({ file: `${label}/${inside}`, summary });
  }
  return notes;
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
 * because one line is one entry; every other line stays as it was. The link
 * forms are the ones the search index reads (`parseNoteLinks`), and a target is
 * resolved the same way (`resolveNoteLink`): the index sits at the scope root,
 * so a bare name may name a note in any folder.
 */
export function withoutUntrustedLines(index: string, untrusted: readonly string[]): string {
  if (untrusted.length === 0) return index;
  const kept: string[] = [];
  for (const line of index.split("\n")) {
    const marked = parseNoteLinks(line).some(
      (link) => resolveNoteLink("index.md", link, untrusted) !== undefined,
    );
    if (!marked) kept.push(line);
  }
  return kept.join("\n");
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
  options: { readonly allowEmpty?: boolean | undefined; readonly label?: string | undefined } = {},
): CommitInfo | undefined {
  if (!repository.tracked) return undefined;
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
  const files = stagedNotes(repository, paths, options.label ?? paths);
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
  return { root: repository.root, paths: [paths], message, files };
}

/** What one bot run changed, as the step reports it. */
export interface MemoryCommitData {
  readonly bot: string;
  readonly chat: string;
  readonly memory: CommitInfo | null;
  readonly wiki: CommitInfo | null;
  readonly unindexed: readonly string[];
  /** The notes this run wrote, in the memory and in the wiki, each with a one-line summary. */
  readonly wrote: readonly WrittenNote[];
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
        restoreInstructions(repository, memoryDir);
        const baseline = lastTidyCommit(repository, memoryDir, bot.bot);
        if (baseline !== undefined && rewriteDrop(repository, memoryDir, baseline).voided) {
          applyAppendOnly(repository, memoryDir, baseline);
          message = `${message}\n\n${TIDY_APPEND_ONLY_NOTE}`;
        }
      }
      const memory = commitChanges(repository, memoryDir, message, { allowEmpty: bot.tidy, label: "memory" });
      const wiki = ensureWiki(home, settings);
      const wikiIndex = stripUntrustedFromIndex(wiki.directory);
      const wikiCommit = commitChanges(wiki, wiki.directory, commitMessage("wiki", bot.bot, bot.chat), { label: "wiki" });
      return {
        bot: bot.bot,
        chat: bot.chat,
        memory: memory ?? null,
        wiki: wikiCommit ?? null,
        unindexed: [...new Set([...index.removed, ...wikiIndex.removed])],
        wrote: [...(memory?.files ?? []), ...(wikiCommit?.files ?? [])],
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
      data: { message: messageOf(error) },
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

