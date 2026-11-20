/**
 * The links a note writes: `[[target]]` and relative Markdown links, parsed
 * from the note's text and resolved against the notes the index holds. A link
 * table is a cache like the rest of the index: no note is written, and a link
 * to a page nobody wrote yet stays in the table with no target until that page
 * appears.
 *
 * A link resolves the way Obsidian resolves one. A target that names a path is
 * taken from the scope root; a Markdown target that is not there is taken
 * relative to the note itself. A bare name matches a file name with or without
 * `.md`, and among files of the same name the one nearest the source note wins.
 */

import type { NoteLink } from "./types.ts";

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const WIKILINK = /\[\[([^[\]]+)\]\]/gu;
const MARKDOWN_LINK = /(!?)\[([^\]]*)\]\(([^()\s]*)\)/gu;
const MARKDOWN_EXTENSION = /\.(?:md|markdown)$/iu;

interface PositionedLink {
  readonly at: number;
  readonly link: NoteLink;
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

/**
 * The text with code left out: fenced code blocks and inline code spans are
 * blanked, so a link that is shown as code is not a link. Line breaks stay, so
 * the text around the code is not joined across a removed piece.
 */
export function withoutCode(text: string): string {
  const lines: string[] = [];
  let fence: { readonly character: string; readonly length: number } | undefined;
  for (const line of text.split(/\r?\n/u)) {
    const match = FENCE.exec(line);
    if (fence === undefined) {
      if (match !== null) {
        const run = match[1] ?? "";
        fence = { character: run[0] ?? "`", length: run.length };
        lines.push("");
        continue;
      }
      lines.push(withoutInlineCode(line));
      continue;
    }
    const closes =
      match !== null &&
      (match[1] ?? "").startsWith(fence.character) &&
      (match[1] ?? "").length >= fence.length &&
      (match[2] ?? "").trim().length === 0;
    if (closes) fence = undefined;
    lines.push("");
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

/** The links a note's text writes, in the order they appear. */
export function parseNoteLinks(text: string): readonly NoteLink[] {
  const clean = withoutCode(text);
  const found: PositionedLink[] = [];

  for (const match of clean.matchAll(WIKILINK)) {
    const inner = match[1] ?? "";
    const first = splitPipe(inner)[0] ?? "";
    const { target, heading } = splitHeading(first);
    if (target.length === 0) continue;
    found.push({
      at: match.index ?? 0,
      link: { target, ...(heading === undefined ? {} : { heading }), kind: "wikilink" },
    });
  }

  for (const match of clean.matchAll(MARKDOWN_LINK)) {
    // `![alt](image.png)` embeds an image; it does not link to a note.
    if ((match[1] ?? "") === "!") continue;
    const written = match[3] ?? "";
    if (written.length === 0 || external(written)) continue;
    const split = splitHeading(written);
    const target = decoded(split.target);
    if (target.length === 0) continue;
    found.push({
      at: match.index ?? 0,
      link: {
        target,
        ...(split.heading === undefined ? {} : { heading: decoded(split.heading) }),
        kind: "markdown",
      },
    });
  }

  found.sort((left, right) => left.at - right.at);
  return found.map((entry) => entry.link);
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

function firstOf(candidates: readonly string[], notes: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    if (notes.includes(candidate)) return candidate;
  }
  return undefined;
}

/** The same-named note nearest the source note, with the path breaking a tie. */
function nearestByName(written: string, source: string, notes: readonly string[]): string | undefined {
  const name = nameOf(written.replace(/\/+$/u, ""));
  if (name.length === 0) return undefined;
  const forms = withExtension(name);
  const matches = notes.filter((note) => forms.includes(nameOf(note)));
  if (matches.length === 0) return undefined;
  const from = directoryOf(source);
  return [...matches].sort(
    (left, right) =>
      directorySteps(from, directoryOf(left)) - directorySteps(from, directoryOf(right)) ||
      left.localeCompare(right),
  )[0];
}

/**
 * The note a link points at, or undefined while nothing matches it. A path is
 * taken from the scope root first; a Markdown target that is not there is taken
 * relative to the source note; then a bare name matches a file name. A path
 * that climbs above the scope root matches nothing.
 */
export function resolveNoteLink(
  source: string,
  link: NoteLink,
  notes: readonly string[],
): string | undefined {
  const written = link.target.trim();
  if (written.length === 0) return undefined;

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

  const byPath = firstOf(candidates, notes);
  if (byPath !== undefined) return byPath;
  return nearestByName(written, source, notes);
}
