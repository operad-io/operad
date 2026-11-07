/**
 * The TUI's Markdown drawing: the engine renders the same lines the CLI uses,
 * and this turns their ANSI styles into OpenTUI chunks. It owns no layout and
 * decides no colours beyond the palette it is given.
 */

import {
  RGBA,
  TextAttributes,
  type TextChunk,
} from "@opentui/core";
import { renderMarkdownLines } from "@operad-io/engine";
import { wrapGlyphs, type WrapGlyph } from "./wrap.ts";

/** The colours Markdown needs; the view's palette has them. */
export interface MarkdownPalette {
  readonly accent: string;
  readonly run: string;
  readonly error: string;
  readonly add: string;
  readonly remove: string;
  readonly weak: string;
  readonly text: string;
}

/** One drawn line: its chunks, its plain text and whether it is fenced code. */
export interface TuiMarkdownLine {
  readonly text: string;
  readonly code: boolean;
  readonly chunks: readonly TextChunk[];
}

interface Style {
  colour: string | undefined;
  attributes: number;
}

function chunk(text: string, style: Style): TextChunk {
  return {
    __isChunk: true,
    text,
    ...(style.colour === undefined ? {} : { fg: RGBA.fromHex(style.colour) }),
    ...(style.attributes === 0 ? {} : { attributes: style.attributes }),
  };
}

function colourFor(code: number, palette: MarkdownPalette): string | undefined {
  switch (code) {
    case 31:
      return palette.remove;
    case 32:
      return palette.add;
    case 36:
      return palette.accent;
    default:
      return undefined;
  }
}

/** Reads the ANSI the engine's renderer emits into styled display characters. */
function glyphsFor(
  text: string,
  code: boolean,
  palette: MarkdownPalette,
): WrapGlyph<Style>[] {
  const glyphs: WrapGlyph<Style>[] = [];
  const style: Style = { colour: undefined, attributes: 0 };
  const pattern = /\x1b\[([0-9;]*)m/g;
  let at = 0;
  const plain = (value: string): void => {
    const colour =
      code && style.colour === undefined ? palette.weak : style.colour;
    for (const char of value) {
      glyphs.push({
        char,
        value: { colour, attributes: style.attributes },
      });
    }
  };
  for (const match of text.matchAll(pattern)) {
    plain(text.slice(at, match.index));
    at = (match.index ?? 0) + match[0].length;
    const codes = (match[1] ?? "").split(";");
    for (const part of codes) {
      const value = Number(part);
      if (!Number.isFinite(value)) continue;
      if (value === 0) {
        style.colour = undefined;
        style.attributes = 0;
      } else if (value === 1) style.attributes |= TextAttributes.BOLD;
      else if (value === 2) style.attributes |= TextAttributes.DIM;
      else if (value === 3) style.attributes |= TextAttributes.ITALIC;
      else if (value === 4) style.attributes |= TextAttributes.UNDERLINE;
      else if (value === 9) style.attributes |= TextAttributes.STRIKETHROUGH;
      else {
        const colour = colourFor(value, palette);
        if (colour !== undefined) style.colour = colour;
      }
    }
  }
  plain(text.slice(at));
  return glyphs;
}

function sameStyle(left: Style, right: Style): boolean {
  return (
    left.colour === right.colour && left.attributes === right.attributes
  );
}

/** Groups one wrapped row's glyphs back into runs of the same style. */
function chunksOf(glyphs: readonly WrapGlyph<Style>[]): TextChunk[] {
  const chunks: TextChunk[] = [];
  let text = "";
  let style: Style | undefined;
  const flush = (): void => {
    if (text.length > 0) {
      chunks.push(chunk(text, style ?? { colour: undefined, attributes: 0 }));
      text = "";
    }
  };
  for (const glyph of glyphs) {
    if (style !== undefined && !sameStyle(style, glyph.value)) flush();
    style = glyph.value;
    text += glyph.char;
  }
  flush();
  if (chunks.length === 0) {
    chunks.push(chunk("", style ?? { colour: undefined, attributes: 0 }));
  }
  return chunks;
}

/**
 * Every row the object pane draws for one section, styled for the theme and
 * wrapped to `width` when the pane knows it. The reducer counts these same
 * wrapped rows, so its scroll and the drawn content cannot drift apart.
 */
export function markdownLines(
  markdown: string,
  palette: MarkdownPalette,
  width?: number | undefined,
): readonly TuiMarkdownLine[] {
  const rows: TuiMarkdownLine[] = [];
  for (const line of renderMarkdownLines(markdown, { colour: true })) {
    const glyphs = glyphsFor(line.text, line.code, palette);
    const wrapped =
      width === undefined ? [glyphs] : wrapGlyphs(glyphs, width);
    for (const row of wrapped) {
      rows.push({
        text: row.map((glyph) => glyph.char).join(""),
        code: line.code,
        chunks: chunksOf(row),
      });
    }
  }
  return rows;
}
