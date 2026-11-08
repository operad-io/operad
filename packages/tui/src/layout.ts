/**
 * The rows a section takes: the engine's Markdown lines, cleaned of control
 * characters, wrapped by display width. The reducer counts these rows and the
 * view draws a window of them, so they are laid out once per content version
 * and width and kept, not on every key and every render.
 */

import { TextAttributes } from "@opentui/core";
import { renderMarkdownLines } from "@operad-io/engine";
import { sanitize } from "./sanitize.ts";
import { graphemes, wrapGlyphs, type WrapGlyph } from "./wrap.ts";

/** What a run of text is coloured by; the view maps it to its palette. */
export type LayoutRole = "add" | "remove" | "accent" | "weak" | undefined;

/** The style of a run: a role and the text attributes. */
export interface LayoutStyle {
  readonly role: LayoutRole;
  readonly attributes: number;
}

/** A run of text in one style. */
export interface LayoutRun {
  readonly text: string;
  readonly style: LayoutStyle;
}

/** One drawn row: its runs, its plain text and whether it is fenced code. */
export interface LayoutLine {
  readonly text: string;
  readonly code: boolean;
  readonly runs: readonly LayoutRun[];
}

function roleFor(code: number): LayoutRole | null {
  switch (code) {
    case 31:
      return "remove";
    case 32:
      return "add";
    case 36:
      return "accent";
    case 90:
      return "weak";
    default:
      return null;
  }
}

/** Reads the ANSI the engine's renderer emits into styled display characters. */
function glyphsFor(text: string, code: boolean): WrapGlyph<LayoutStyle>[] {
  const glyphs: WrapGlyph<LayoutStyle>[] = [];
  let role: LayoutRole;
  let attributes = 0;
  const pattern = /\x1b\[([0-9;]*)m/g;
  let at = 0;
  const plain = (value: string): void => {
    // The text was cleaned before it was rendered; what is left of ESC is the
    // renderer's own styles, read below. A tab becomes spaces.
    const effective: LayoutRole = code && role === undefined ? "weak" : role;
    for (const char of graphemes(value.replace(/\t/g, "    "))) {
      glyphs.push({ char, value: { role: effective, attributes } });
    }
  };
  for (const match of text.matchAll(pattern)) {
    plain(sanitize(text.slice(at, match.index)));
    at = (match.index ?? 0) + match[0].length;
    for (const part of (match[1] ?? "").split(";")) {
      const value = Number(part);
      if (!Number.isFinite(value)) continue;
      if (value === 0) {
        role = undefined;
        attributes = 0;
      } else if (value === 1) attributes |= TextAttributes.BOLD;
      else if (value === 2) attributes |= TextAttributes.DIM;
      else if (value === 3) attributes |= TextAttributes.ITALIC;
      else if (value === 4) attributes |= TextAttributes.UNDERLINE;
      else if (value === 9) attributes |= TextAttributes.STRIKETHROUGH;
      else {
        const next = roleFor(value);
        if (next !== null) role = next;
      }
    }
  }
  plain(sanitize(text.slice(at)));
  return glyphs;
}

function sameStyle(left: LayoutStyle, right: LayoutStyle): boolean {
  return left.role === right.role && left.attributes === right.attributes;
}

function runsOf(glyphs: readonly WrapGlyph<LayoutStyle>[]): LayoutRun[] {
  const runs: LayoutRun[] = [];
  let text = "";
  let style: LayoutStyle | undefined;
  const flush = (): void => {
    if (text.length > 0 && style !== undefined) runs.push({ text, style });
    text = "";
  };
  for (const glyph of glyphs) {
    if (style !== undefined && !sameStyle(style, glyph.value)) flush();
    style = glyph.value;
    text += glyph.char;
  }
  flush();
  if (runs.length === 0) {
    runs.push({ text: "", style: style ?? { role: undefined, attributes: 0 } });
  }
  return runs;
}

/**
 * Every row one section's Markdown takes at `width` columns, without its
 * trailing blank rows. `width` undefined means no wrapping.
 */
export function layoutMarkdown(
  markdown: string,
  width?: number | undefined,
): readonly LayoutLine[] {
  const rows: LayoutLine[] = [];
  // Cleaned before the renderer adds its own styles, so a literal escape in
  // the text cannot pass for one of them.
  for (const line of renderMarkdownLines(sanitize(markdown), {
    colour: true,
    width,
  })) {
    const glyphs = glyphsFor(line.text, line.code);
    const wrapped = width === undefined ? [glyphs] : wrapGlyphs(glyphs, width);
    for (const row of wrapped) {
      rows.push({
        text: row.map((glyph) => glyph.char).join(""),
        code: line.code,
        runs: runsOf(row),
      });
    }
  }
  while (rows.length > 0 && (rows[rows.length - 1]?.text ?? "") === "") rows.pop();
  return rows;
}

interface Entry {
  readonly version: number;
  readonly markdown: string;
  readonly width: number;
  readonly lines: readonly LayoutLine[];
}

const CACHE_LIMIT = 32;
const cache = new Map<string, Entry>();

/** How many layouts were computed, for a test that checks the cache is used. */
export const layoutStats = { computed: 0 };

/**
 * The layout of one section's content, kept per `key` while its `version` and
 * the `width` stay the same. A key names one section of one open object.
 */
export function cachedLayout(
  key: string,
  version: number,
  markdown: string,
  width: number,
): readonly LayoutLine[] {
  const entry = cache.get(key);
  // The text itself is compared too: the same string is one pointer check, and
  // two states that happen to share a key and a version cannot share rows.
  if (
    entry !== undefined &&
    entry.version === version &&
    entry.width === width &&
    entry.markdown === markdown
  ) {
    return entry.lines;
  }
  layoutStats.computed += 1;
  const lines = layoutMarkdown(markdown, width);
  cache.delete(key);
  cache.set(key, { version, markdown, width, lines });
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return lines;
}
