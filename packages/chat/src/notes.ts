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

/** A note as this reply reads it: the descriptor, its whole text and the hash of that text. */
export interface NoteContent {
  readonly file: NoteFile;
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
      notes.push({ file, text, hash: noteHash(text) });
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

/** The state after this reply: the session, and the hash of each note it leaves knowing. */
export function noteHashesAfter(
  notes: readonly NoteContent[],
  session: string | undefined,
  compacted: boolean,
): ChatNoteHashes {
  const files: Record<string, string> = {};
  // A compacted session knows none of them, so the next message carries them all.
  if (!compacted) {
    for (const note of notes) files[note.file.name] = note.hash;
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
