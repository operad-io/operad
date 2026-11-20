/**
 * Notes a chat's refresh step puts on the message: files whose whole text the
 * agent should see when its session may not know them. A bot's memory index and
 * its instructions are the first use. A note is never part of the system
 * prompt, and the hashes of what this session last saw live on the chat object,
 * so a serve restart keeps them and a chat holds only its current files.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isRecord } from "@operad-io/engine";
import type { FoldEntry } from "@operad-io/harness-process";
import type { ChatNoteHashes } from "./model.ts";

/** One file a chat's refresh step gives as a note on the message. */
export interface NoteFile {
  /** The name the prompt shows, such as `memory/index.md`. */
  readonly name: string;
  /** The file to read; an absolute path, or one under the chat's working directory. */
  readonly path: string;
  /** The most characters attached; the rest is cut with a line saying it was cut. */
  readonly maxChars?: number | undefined;
}

/** A note as this reply reads it: the descriptor, where it is, its whole text and that text's hash. */
export interface NoteContent {
  readonly file: NoteFile;
  /** The file's resolved path. */
  readonly path: string;
  readonly text: string;
  readonly hash: string;
}

/** The notes a refresh step names, ignoring a malformed one. */
export function noteFilesOf(value: unknown): readonly NoteFile[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const files: NoteFile[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = item.name;
    const path = item.path;
    if (typeof name !== "string" || name.length === 0) continue;
    if (typeof path !== "string" || path.length === 0) continue;
    const limit = item.maxChars;
    const maxChars =
      typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined;
    files.push({ name, path, ...(maxChars === undefined ? {} : { maxChars }) });
  }
  return files;
}

/** The hash a note's whole text is compared by. */
export function noteHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Reads the notes of this reply. A file that cannot be read is left out and its
 * problem logged: a missing note never fails the answer.
 */
export async function readNoteFiles(
  files: readonly NoteFile[],
  cwd: string,
  onProblem?: ((message: string) => void) | undefined,
): Promise<readonly NoteContent[]> {
  const notes: NoteContent[] = [];
  for (const file of files) {
    const path = isAbsolute(file.path) ? file.path : join(cwd, file.path);
    try {
      const text = await readFile(path, "utf8");
      notes.push({ file, path, text, hash: noteHash(text) });
    } catch (error) {
      onProblem?.(`the note ${file.name} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return notes;
}

/** The notes this message carries: all of them in a new session or after a compaction, else the changed ones. */
export function notesToAttach(
  notes: readonly NoteContent[],
  hashes: ChatNoteHashes | undefined,
  session: string | undefined,
): readonly NoteContent[] {
  if (notes.length === 0) return [];
  if (session === undefined) return notes;
  // A hash one session saw says nothing about the session now in force.
  if (hashes === undefined || hashes.session !== session) return notes;
  return notes.filter((note) => hashes.files[note.file.name] !== note.hash);
}

/** The tool names that write a file; a run that reports one may have written that note itself. */
const EDIT_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit", "patch", "apply_patch"]);

/** The tool names that run a shell command; one may write a note through redirection. */
const SHELL_TOOLS = new Set(["bash", "sh", "shell", "exec", "exec_command", "run_shell_command", "terminal"]);

/** A shell command that writes a file: redirection, tee, in-place edit, or a file operation. */
const SHELL_WRITE = /(?:>>?|\btee\b|\b(?:rm|mv|cp|touch|truncate|dd|install)\b|\bsed\b[^\n]*\s-i\b|\bperl\b[^\n]*\s-[a-z]*i)/;

/** Whether a tool call's summarized input names this note. */
function mentionsNote(input: string | null | undefined, note: NoteContent): boolean {
  if (input === null || input === undefined || input.length === 0) return false;
  return input.includes(note.path) || input.includes(note.file.path) || input.includes(note.file.name);
}

/** Whether a tool call is one that may write the note it names. */
function writesNamedNote(entry: FoldEntry, note: NoteContent): boolean {
  if (entry.kind !== "tool" || !mentionsNote(entry.input, note)) return false;
  const tool = entry.toolName.toLowerCase();
  if (EDIT_TOOLS.has(tool)) return true;
  return SHELL_TOOLS.has(tool) && SHELL_WRITE.test(entry.input ?? "");
}

/**
 * The notes this run wrote itself, from the tool calls it reported. A change no
 * call of this run claims is somebody else's: another chat, a scheduled run or
 * a tidy step, even when it happened while this reply was running.
 */
export function notesWrittenHere(
  notes: readonly NoteContent[],
  entries: readonly FoldEntry[],
): ReadonlySet<string> {
  const written = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "tool" || entry.result !== "done") continue;
    for (const note of notes) {
      if (writesNamedNote(entry, note)) written.add(note.file.name);
    }
  }
  return written;
}

/**
 * The state after this reply. The session knows the text it was given, so an
 * unchanged file keeps the hash it had before the run. A file this run wrote
 * itself keeps its hash after the run; a file somebody else changed during the
 * run keeps the older hash, so the next message carries the new text whole.
 * A compacted session knows none of them, so the next message carries them all.
 */
export function noteHashesAfter(
  before: readonly NoteContent[],
  after: readonly NoteContent[],
  written: ReadonlySet<string>,
  session: string | undefined,
  compacted: boolean,
): ChatNoteHashes {
  const files: Record<string, string> = {};
  if (!compacted) {
    const now = new Map(after.map((note) => [note.file.name, note]));
    for (const note of before) {
      const name = note.file.name;
      const latest = now.get(name);
      files[name] = written.has(name) && latest !== undefined ? latest.hash : note.hash;
    }
    // A note that first appeared during the run is the session's only if this run wrote it.
    for (const note of after) {
      if (files[note.file.name] === undefined && written.has(note.file.name)) {
        files[note.file.name] = note.hash;
      }
    }
  }
  return { ...(session === undefined ? {} : { session }), files };
}

/** Cuts text to a character count without splitting a surrogate pair. */
function cutCharacters(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** The line a cut note ends with. */
export function cutNoteLine(name: string, maxChars: number): string {
  return `[${name} was cut at ${maxChars} characters.]`;
}

/** One note as the prompt shows it: its name, its text (cut when a limit is set) and an end marker. */
export function noteBlock(notes: readonly NoteContent[]): string {
  return notes
    .map((note) => {
      const limit = note.file.maxChars;
      const body =
        limit !== undefined && note.text.length > limit
          ? `${cutCharacters(note.text, limit)}\n\n${cutNoteLine(note.file.name, limit)}`
          : note.text;
      return `[${note.file.name}]\n${body}\n[End of ${note.file.name}]`;
    })
    .join("\n\n");
}
