/**
 * The links a note writes: `[[target]]` and relative Markdown links, parsed
 * from the note's text and resolved against the notes the index holds. A link
 * table is a cache like the rest of the index: no note is written, and a link
 * to a page nobody wrote yet stays in the table with no target until that page
 * appears.
 *
 * A link resolves the way Obsidian resolves one. A target that names a path is
 * taken from the scope root; a Markdown target that is not there is taken
 * relative to the note itself. A bare wikilink name matches a file name with or
 * without `.md`, and among files of the same name the one nearest the source
 * note wins. A path is not reduced to its file name.
 */

import { snippetOf } from "./search/chunks.ts";
import type { NoteLink } from "./search/types.ts";

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const WIKILINK = /\[\[([^[\]]+)\]\]/gu;
const MARKDOWN_LINK = /(!?)\[([^\]]*)\]\(\s*(?:<([^>\n]*)>|([^)\n]*?))\s*\)/gu;
const MARKDOWN_EXTENSION = /\.(?:md|markdown)$/iu;

/** One link a note writes, with the offset at which it starts in the body. */
export interface PositionedNoteLink extends NoteLink {
  readonly at: number;
}

/** One link a note writes, with the line and excerpt a backlink will show. */
export interface PlacedNoteLink extends PositionedNoteLink {
  readonly line: number;
  readonly excerpt: string;
}

/** The line and excerpt around a link that starts at an offset in its note. */
export function linkPlaceAt(
  text: string,
  at: number,
  target: string,
): { readonly line: number; readonly excerpt: string } {
  const before = text.slice(0, at);
  const line = before.length === 0 ? 1 : before.split(/\r?\n/u).length;
  const start = text.lastIndexOf("\n", at - 1) + 1;
  const next = text.indexOf("\n", at);
  const written = text.slice(start, next < 0 ? text.length : next).trim();
  return { line, excerpt: snippetOf(written, [target]) };
}

/** The links a note's text writes, each with the place a backlink shows it. */
export function placedNoteLinks(text: string): readonly PlacedNoteLink[] {
  return parseNoteLinksWithPositions(text).map(({ at, ...link }) => ({
    ...link,
    at,
    ...linkPlaceAt(text, at, link.target),
  }));
}

/** Removes inline code spans from one line, keeping its length and its text around them. */
function withoutInlineCode(line: string): string {
  let kept = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] !== "`") {
      kept += line[index];
      index += 1;
      continue;
    }
    let ticks = 0;
    while (line[index + ticks] === "`") ticks += 1;
    let end = -1;
    let scan = index + ticks;
    while (scan < line.length) {
      if (line[scan] !== "`") {
        scan += 1;
        continue;
      }
      let run = 0;
      while (line[scan + run] === "`") run += 1;
      if (run === ticks) {
        end = scan;
        break;
      }
      scan += run;
    }
    if (end < 0) {
      // An unmatched run of backticks is text, not a code span.
      kept += "`".repeat(ticks);
      index += ticks;
      continue;
    }
    kept += " ".repeat(end + ticks - index);
    index = end + ticks;
  }
  return kept;
}

/** A line with its text blanked, keeping its length so link offsets stay exact. */
function blankLine(line: string, carriage: boolean): string {
  return " ".repeat(line.length) + (carriage ? "\r" : "");
}

/** A Markdown block that ends a paragraph, so an indented line after it is code. */
const BLOCK_START = /^ {0,3}(?:#{1,6}(?:\s|$)|>|(?:[-*_]\s*){3,}|\|?\s*:?-{3,}:?\s*\|?)/u;

/**
 * The text with code left out: fenced and indented code blocks and inline code
 * spans are blanked, so a link that is shown as code is not a link. Each
 * blanked line keeps its length, and line breaks stay, so the text around the
 * code is neither joined across a removed piece nor shifted for a reader.
 */
export function withoutCode(text: string): string {
  const lines: string[] = [];
  let fence: { readonly character: string; readonly length: number } | undefined;
  let indented = false;
  // An indented code block cannot interrupt a paragraph; ordinary text does.
  let paragraph = false;
  for (const line of text.split("\n")) {
    const carriage = line.endsWith("\r");
    const content = carriage ? line.slice(0, -1) : line;
    const match = FENCE.exec(content);
    if (fence !== undefined) {
      const closes =
        match !== null &&
        (match[1] ?? "").startsWith(fence.character) &&
        (match[1] ?? "").length >= fence.length &&
        (match[2] ?? "").trim().length === 0;
      if (closes) fence = undefined;
      lines.push(blankLine(content, carriage));
      paragraph = false;
      continue;
    }
    if (match !== null) {
      const run = match[1] ?? "";
      fence = { character: run[0] ?? "`", length: run.length };
      indented = false;
      lines.push(blankLine(content, carriage));
      paragraph = false;
      continue;
    }
    const isIndented = /^(?: {4}|\t)/u.test(content);
    if (indented) {
      if (isIndented || content.trim().length === 0) {
        lines.push(blankLine(content, carriage));
        paragraph = false;
        continue;
      }
      indented = false;
    }
    if (isIndented && !paragraph) {
      indented = true;
      lines.push(blankLine(content, carriage));
      paragraph = false;
      continue;
    }
    lines.push(withoutInlineCode(content) + (carriage ? "\r" : ""));
    paragraph = content.trim().length > 0 && !BLOCK_START.test(content);
  }
  return lines.join("\n");
}

/**
 * The parts of a wikilink, split at its pipe. A `\|` is the same separator
 * written so a Markdown table around the link does not split its row.
 */
function splitPipe(text: string): readonly string[] {
  const parts: string[] = [];
  let current = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (character === "\\" && text[index + 1] === "|") {
      parts.push(current);
      current = "";
      index += 1;
      continue;
    }
    if (character === "|") {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

/** A written target split at its first `#` into the note and the heading. */
function splitHeading(text: string): { readonly target: string; readonly heading?: string } {
  const at = text.indexOf("#");
  if (at < 0) return { target: text.trim() };
  const target = text.slice(0, at).trim();
  const heading = text.slice(at + 1).trim();
  return heading.length === 0 ? { target } : { target, heading };
}

/**
 * A percent-decoded target. A bare `%` is not an escape and must not make the
 * parser throw: such a target is kept as it was written.
 */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Whether a Markdown target points outside the notes: a scheme or `//`. */
function external(target: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target) || target.startsWith("//");
}

/** The links a note's text writes, with where they start, in the order they appear. */
export function parseNoteLinksWithPositions(text: string): readonly PositionedNoteLink[] {
  const clean = withoutCode(text);
  const found: PositionedNoteLink[] = [];

  for (const match of clean.matchAll(WIKILINK)) {
    const inner = match[1] ?? "";
    const first = splitPipe(inner)[0] ?? "";
    const { target, heading } = splitHeading(first);
    // `[[#Heading]]` names a heading in the note that writes it.
    if (target.length === 0 && heading === undefined) continue;
    found.push({
      at: match.index ?? 0,
      target,
      ...(heading === undefined ? {} : { heading }),
      kind: "wikilink",
    });
  }

  for (const match of clean.matchAll(MARKDOWN_LINK)) {
    // `![alt](image.png)` embeds an image; it does not link to a note.
    if ((match[1] ?? "") === "!") continue;
    // A destination may be enclosed in angle brackets; either form may hold a space.
    const written = match[4] ?? match[3] ?? "";
    if (written.trim().length === 0 || external(written.trim())) continue;
    const split = splitHeading(written);
    const target = decoded(split.target);
    if (target.length === 0) continue;
    found.push({
      at: match.index ?? 0,
      target,
      ...(split.heading === undefined ? {} : { heading: decoded(split.heading) }),
      kind: "markdown",
    });
  }

  found.sort((left, right) => left.at - right.at);
  return found;
}

/** The links a note's text writes, in the order they appear. */
export function parseNoteLinks(text: string): readonly NoteLink[] {
  return parseNoteLinksWithPositions(text).map(({ at: _at, ...link }) => link);
}

/** A path inside its scope root: `/` separators, no `.` or `..` parts. */
export function normaliseNotePath(path: string): string | undefined {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length === 0 ? undefined : parts.join("/");
}

/** The paths a written note name can be: it, and the same with `.md`. */
function withExtension(path: string): readonly string[] {
  return MARKDOWN_EXTENSION.test(path) ? [path] : [path, `${path}.md`];
}

/** The directory part of a note path, empty at the root. */
function directoryOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

/** The file part of a note path. */
function nameOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? path : path.slice(at + 1);
}

/** The steps from one directory to another in the same scope tree. */
function directorySteps(from: string, to: string): number {
  const source = from === "" ? [] : from.split("/");
  const target = to === "" ? [] : to.split("/");
  let common = 0;
  while (common < source.length && common < target.length && source[common] === target[common]) {
    common += 1;
  }
  return source.length - common + target.length - common;
}

/** A note set prepared for many resolutions: path lookup and file-name lookup. */
export interface NoteLookup {
  /** Whether a path from the scope root names a note. */
  has(path: string): boolean;
  /** The same-named note nearest the source note, with the path breaking a tie. */
  nearestByName(written: string, source: string): string | undefined;
}

/** Prepares a note set once, so resolving many links does not scan it per link. */
export function noteLookup(notes: readonly string[]): NoteLookup {
  const paths = new Set(notes);
  const byName = new Map<string, string[]>();
  for (const note of notes) {
    const name = nameOf(note);
    const list = byName.get(name) ?? [];
    list.push(note);
    byName.set(name, list);
  }
  return {
    has: (path) => paths.has(path),
    nearestByName: (written, source) => {
      const name = nameOf(written.replace(/\/+$/u, ""));
      if (name.length === 0) return undefined;
      const matches = withExtension(name).flatMap((form) => byName.get(form) ?? []);
      if (matches.length === 0) return undefined;
      const from = directoryOf(source);
      return [...matches].sort(
        (left, right) =>
          directorySteps(from, directoryOf(left)) - directorySteps(from, directoryOf(right)) ||
          left.localeCompare(right),
      )[0];
    },
  };
}

function asLookup(notes: readonly string[] | NoteLookup): NoteLookup {
  return isNoteLookup(notes) ? notes : noteLookup(notes);
}

function isNoteLookup(notes: readonly string[] | NoteLookup): notes is NoteLookup {
  return !Array.isArray(notes);
}

/**
 * The note a link points at, or undefined while nothing matches it. A path is
 * taken from the scope root first; a Markdown target that is not there is taken
 * relative to the source note. Only a bare wikilink name matches a file name. A
 * path that climbs above the scope root matches nothing.
 */
export function resolveNoteLink(
  source: string,
  link: NoteLink,
  notes: readonly string[] | NoteLookup,
): string | undefined {
  const lookup = asLookup(notes);
  const written = link.target.trim();
  if (written.length === 0) {
    return link.heading !== undefined && lookup.has(source) ? source : undefined;
  }

  const fromRoot = normaliseNotePath(written.replace(/^\/+/u, ""));
  const candidates: string[] = [];
  if (fromRoot !== undefined) candidates.push(...withExtension(fromRoot));
  if (link.kind === "markdown" && !written.startsWith("/")) {
    const directory = directoryOf(source);
    const fromSource = normaliseNotePath(directory === "" ? written : `${directory}/${written}`);
    if (fromSource !== undefined) {
      for (const candidate of withExtension(fromSource)) {
        if (!candidates.includes(candidate)) candidates.push(candidate);
      }
    }
  }

  const byPath = candidates.find((candidate) => lookup.has(candidate));
  if (byPath !== undefined) return byPath;
  // Only a bare wikilink name falls back to a file name; a path is a path.
  if (link.kind !== "wikilink" || written.includes("/")) return undefined;
  return lookup.nearestByName(written, source);
}
