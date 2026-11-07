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

/** Reads the ANSI the engine's renderer emits, one line at a time. */
function chunksFor(
  text: string,
  code: boolean,
  palette: MarkdownPalette,
): TextChunk[] {
  const chunks: TextChunk[] = [];
  const style: Style = { colour: undefined, attributes: 0 };
  const pattern = /\x1b\[([0-9;]*)m/g;
  let at = 0;
  const plain = (value: string): void => {
    if (value.length === 0) return;
    chunks.push(
      chunk(
        value,
        code && style.colour === undefined
          ? { colour: palette.weak, attributes: style.attributes }
          : style,
      ),
    );
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
  if (chunks.length === 0) chunks.push(chunk("", style));
  return chunks;
}

/** Every line the object pane draws for one section, styled for the theme. */
export function markdownLines(
  markdown: string,
  palette: MarkdownPalette,
): readonly TuiMarkdownLine[] {
  return renderMarkdownLines(markdown, { colour: true }).map((line) => ({
    text: line.text.replace(/\x1b\[[0-9;]*m/g, ""),
    code: line.code,
    chunks: chunksFor(line.text, line.code, palette),
  }));
}
