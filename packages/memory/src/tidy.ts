/**
 * The memory tidy's bookkeeping: what changed since the last tidy commit, how
 * far the index is over its limit, and the guard that voids a rewrite which
 * drops too many existing index entries and keeps only additions instead.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  MEMORY_INDEX_MAX,
  ensureRepository,
  memoryGit,
  pathIn,
  type Repository,
} from "./memory.ts";

/** The origin a chat's data records for a tidy run. */
export const TIDY_ORIGIN = "memory-tidy";

/** The fact a tidy chat records once its memory commit was tried. */
export const TIDY_COMMIT_FACT = "memory.tidy";

/** The subject every tidy commit begins with. */
export const TIDY_SUBJECT = "tidy:";

/** The body a voided rewrite's commit carries. */
export const TIDY_APPEND_ONLY_NOTE =
  "append only: the rewrite dropped too many existing entries, so only additions were kept";

/** How much of the old index a rewrite may drop before it is void. */
export const TIDY_MAX_DROP = 0.25;

/** What the last tidy left and what has happened since. */
export interface MemoryTidyState {
  readonly repository: Repository;
  /** The memory directory the state is about. */
  readonly directory: string;
  /** The last tidy commit, or undefined before the first one. */
  readonly baseline: string | undefined;
  /** When that commit was made, in milliseconds since the epoch. */
  readonly since: number | undefined;
  /** Notes added or changed since the baseline, relative to the memory directory. */
  readonly notes: readonly string[];
  /** The index's size in bytes, and whether it is over the limit. */
  readonly indexBytes: number;
  readonly indexOver: boolean;
}

function scoped(repository: Repository, directory: string): string {
  return pathIn(repository.root, directory);
}

/**
 * The latest tidy commit. With a bot name the subject names it, so an empty
 * tidy commit counts too; without one the commit must touch the directory.
 */
export function lastTidyCommit(
  repository: Repository,
  directory: string,
  bot?: string,
): string | undefined {
  const found = memoryGit(repository.root, [
    "log",
    "-1",
    "--format=%H",
    `--grep=^${TIDY_SUBJECT}${bot === undefined ? "" : ` bot ${bot},`}`,
    ...(bot === undefined ? ["--", scoped(repository, directory)] : []),
  ]);
  return found.ok && found.out.length > 0 ? found.out : undefined;
}

function commitTime(repository: Repository, commit: string): number | undefined {
  const found = memoryGit(repository.root, ["log", "-1", "--format=%ct", commit]);
  if (!found.ok) return undefined;
  const seconds = Number(found.out);
  return Number.isFinite(seconds) ? seconds * 1_000 : undefined;
}

/** A path relative to the memory directory, with `/` separators. */
function notePath(repository: Repository, directory: string, path: string): string | undefined {
  const absolute = path.startsWith("/") ? path : join(repository.root, path);
  const rel = relative(directory, absolute);
  if (rel === "" || rel.startsWith("..")) return undefined;
  return rel.split(sep).join("/");
}

function isNote(path: string): boolean {
  return path.endsWith(".md") && path !== "index.md" && path !== "instructions.md";
}

/** Every Markdown note in a directory, relative to it. */
function notesOnDisk(directory: string): string[] {
  const found: string[] = [];
  const visit = (current: string, prefix: string): void => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const path = join(current, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(path, rel);
        continue;
      }
      if (isNote(rel)) found.push(rel);
    }
  };
  visit(directory, "");
  return found;
}

/** The paths git reports as changed since a commit, including the working tree. */
function changedSince(repository: Repository, directory: string, baseline: string): string[] {
  const found: string[] = [];
  const committed = memoryGit(repository.root, [
    "diff",
    "--name-only",
    baseline,
    "HEAD",
    "--",
    scoped(repository, directory),
  ]);
  if (committed.ok && committed.out.length > 0) found.push(...committed.out.split("\n"));
  const working = memoryGit(repository.root, [
    "diff",
    "--name-only",
    "HEAD",
    "--",
    scoped(repository, directory),
  ]);
  if (working.ok && working.out.length > 0) found.push(...working.out.split("\n"));
  const untracked = memoryGit(repository.root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    scoped(repository, directory),
  ]);
  if (untracked.ok && untracked.out.length > 0) found.push(...untracked.out.split("\n"));
  return found;
}

/** What has changed in a bot's memory since its last tidy commit. */
export function memoryTidyState(memoryDir: string, bot?: string): MemoryTidyState {
  const repository = ensureRepository(memoryDir);
  const baseline = lastTidyCommit(repository, memoryDir, bot);
  const paths =
    baseline === undefined
      ? notesOnDisk(memoryDir)
      : changedSince(repository, memoryDir, baseline)
          .map((path) => notePath(repository, memoryDir, path))
          .filter((path): path is string => path !== undefined);
  const notes = [...new Set(paths.filter(isNote))].sort();
  const index = join(memoryDir, "index.md");
  const indexBytes = existsSync(index) ? Buffer.byteLength(readFileSync(index, "utf8"), "utf8") : 0;
  return {
    repository,
    directory: memoryDir,
    baseline,
    since: baseline === undefined ? undefined : commitTime(repository, baseline),
    notes,
    indexBytes,
    indexOver: indexBytes > MEMORY_INDEX_MAX,
  };
}

/** The list items of an index; one line is one entry. */
export function indexEntries(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line));
}

function indexAt(repository: Repository, directory: string, commit: string): string {
  const path = scoped(repository, directory);
  const file = path === "." ? "index.md" : `${path}/index.md`;
  const found = memoryGit(repository.root, ["show", `${commit}:${file}`]);
  return found.ok ? found.out : "";
}

/** How many old index entries a rewrite drops, and whether that voids it. */
export function rewriteDrop(
  repository: Repository,
  directory: string,
  baseline: string,
): { readonly before: number; readonly removed: number; readonly voided: boolean } {
  const before = indexEntries(indexAt(repository, directory, baseline));
  if (before.length === 0) return { before: 0, removed: 0, voided: false };
  const index = join(directory, "index.md");
  const after = new Set(indexEntries(existsSync(index) ? readFileSync(index, "utf8") : ""));
  const removed = before.filter((entry) => !after.has(entry)).length;
  return {
    before: before.length,
    removed,
    voided: removed > 0 && removed / before.length >= TIDY_MAX_DROP,
  };
}

/** The old text with every line the rewrite added, and no line it removed. */
export function appendOnlyMerge(before: string, after: string): string {
  if (before === after) return before;
  const known = new Set(before.split("\n"));
  const additions = after.split("\n").filter((line) => !known.has(line));
  if (additions.length === 0) return before;
  return `${before.endsWith("\n") || before.length === 0 ? before : `${before}\n`}${additions.join("\n")}`;
}

/**
 * Puts a memory directory back to append only: a tracked file the run deleted
 * comes back, and a changed one keeps its old lines and gains the new ones.
 * Files the run added stay. Returns the files it rewrote.
 */
export function applyAppendOnly(
  repository: Repository,
  directory: string,
  baseline: string,
): readonly string[] {
  const listed = memoryGit(repository.root, [
    "ls-tree",
    "-r",
    "--name-only",
    baseline,
    "--",
    scoped(repository, directory),
  ]);
  if (!listed.ok) return [];
  const rewritten: string[] = [];
  for (const path of listed.out.split("\n")) {
    if (path.length === 0) continue;
    const shown = memoryGit(repository.root, ["show", `${baseline}:${path}`]);
    if (!shown.ok) continue;
    const before = shown.out;
    const file = join(repository.root, ...path.split("/"));
    const after = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    if (after === before) continue;
    const next = after === undefined ? before : appendOnlyMerge(before, after);
    if (next !== after) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, next);
      rewritten.push(notePath(repository, directory, file) ?? path);
    }
  }
  return rewritten.sort();
}

/** The tidy commit a chat made in the memory repository, if it made one. */
export function tidyCommitForChat(
  repository: Repository,
  directory: string,
  chat: string,
): string | undefined {
  const escaped = chat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = memoryGit(repository.root, [
    "log",
    "-1",
    "--format=%H",
    "--extended-regexp",
    "--grep",
    `^tidy: bot .+, chat ${escaped}$`,
  ]);
  return found.ok && found.out.length > 0 ? found.out : undefined;
}

/** Where a tidy commit's run is read from: its memory directory and bot. */
export interface TidySummaryScope {
  /** The memory directory the run changed; the repository's directory by default. */
  readonly directory?: string | undefined;
  /** The bot whose tidy this is; without it a commit must touch the directory. */
  readonly bot?: string | undefined;
}

/**
 * The tidy commit a run measured from: the latest tidy commit before `commit`,
 * or undefined before the first one.
 */
function previousTidyCommit(
  repository: Repository,
  directory: string,
  commit: string,
  bot?: string,
): string | undefined {
  const found = memoryGit(repository.root, [
    "log",
    "-1",
    "--format=%H",
    `${commit}^`,
    `--grep=^${TIDY_SUBJECT}${bot === undefined ? "" : ` bot ${bot},`}`,
    ...(bot === undefined ? ["--", scoped(repository, directory)] : []),
  ]);
  return found.ok && found.out.length > 0 ? found.out : undefined;
}

/** The diff stat of a run from its baseline, or from an empty tree before one. */
function runStat(
  repository: Repository,
  directory: string,
  baseline: string | undefined,
  commit: string,
): string {
  const paths = ["--", scoped(repository, directory)];
  if (baseline !== undefined) {
    return memoryGit(repository.root, ["diff", "--stat", baseline, commit, ...paths]).out;
  }
  const empty = memoryGit(repository.root, ["mktree"]);
  return empty.ok && empty.out.length > 0
    ? memoryGit(repository.root, ["diff", "--stat", empty.out, commit, ...paths]).out
    : memoryGit(repository.root, ["show", "--stat", "--format=", commit, ...paths]).out;
}

/** A tidy commit's subject, whether it was voided, and its run's diff-stat line. */
export interface TidyCommitSummary {
  readonly hash: string;
  readonly subject: string;
  readonly voided: boolean;
  readonly changed: boolean;
  readonly summary: string;
}

/**
 * Reads what a tidy run did, for the tidy object's section or the notice. The
 * stat runs from the commit the run measured from, so a chat's ordinary memory
 * commit between the two is part of the run.
 */
export function tidyCommitSummary(
  repository: Repository,
  commit: string,
  scope: TidySummaryScope = {},
): TidyCommitSummary {
  const directory = scope.directory ?? repository.directory;
  const body = memoryGit(repository.root, ["show", "-s", "--format=%s%n%b", commit]);
  const baseline = previousTidyCommit(repository, directory, commit, scope.bot);
  const stat = runStat(repository, directory, baseline, commit);
  const lines = stat.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const summary = lines.at(-1) ?? "No file statistics.";
  return {
    hash: commit,
    subject: body.out.split("\n")[0] ?? "",
    voided: body.out.includes("append only:"),
    changed: /changed|insertion|deletion/.test(summary),
    summary,
  };
}

const INSTRUCTIONS_FILE = "instructions.md";

/**
 * Makes the person's instructions read-only for the length of a tidy run. A
 * tidy never changes them; the run's commit puts them back anyway, in case the
 * run got past the mode.
 */
export function lockInstructions(memoryDir: string): void {
  const file = join(memoryDir, INSTRUCTIONS_FILE);
  if (existsSync(file)) chmodSync(file, 0o444);
}

/** Ends the read-only mode of the instructions. */
export function unlockInstructions(memoryDir: string): void {
  const file = join(memoryDir, INSTRUCTIONS_FILE);
  if (existsSync(file)) chmodSync(file, 0o644);
}

/**
 * Ends the read-only mode and puts the instructions back as the last commit
 * has them, whatever the run did to the file (changed it, deleted it, or made
 * it writable and rewrote it). A file no commit has yet is only made writable.
 * Returns true when it had to rewrite the file.
 */
export function restoreInstructions(repository: Repository, directory: string): boolean {
  const file = join(directory, INSTRUCTIONS_FILE);
  const path = relative(repository.root, file).split(sep).join("/");
  // The file is tracked and differs from the last commit: check it out again.
  // Git writes the bytes as they were, which a trimmed `show` would not.
  const tracked = memoryGit(repository.root, ["ls-tree", "--name-only", "HEAD", "--", path]);
  const changed = memoryGit(repository.root, ["status", "--porcelain", "--", path]);
  let restored = false;
  if (tracked.ok && tracked.out.length > 0 && changed.out.length > 0) {
    if (existsSync(file)) chmodSync(file, 0o644);
    restored = memoryGit(repository.root, ["checkout", "HEAD", "--", path]).ok;
  }
  if (existsSync(file)) chmodSync(file, 0o644);
  return restored;
}
