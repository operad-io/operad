/**
 * The TUI's Markdown drawing: the engine renders the lines, `layout.ts` cleans
 * and wraps them, and this turns a laid-out row into OpenTUI chunks in the
 * theme's colours. It owns no layout and decides no colours beyond the palette
 * it is given.
 */

import { RGBA, type TextChunk } from "@opentui/core";
import {
  layoutMarkdown,
  type LayoutLine,
  type LayoutRole,
} from "./layout.ts";

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

function colourFor(
  role: LayoutRole,
  palette: MarkdownPalette,
): string | undefined {
  switch (role) {
    case "add":
      return palette.add;
    case "remove":
      return palette.remove;
    case "accent":
      return palette.accent;
    case "weak":
      return palette.weak;
    default:
      return undefined;
  }
}

/** One laid-out row in the palette's colours. */
export function chunksOfLine(
  line: LayoutLine,
  palette: MarkdownPalette,
): TextChunk[] {
  return line.runs.map((run) => {
    const colour = colourFor(run.style.role, palette);
    return {
      __isChunk: true,
      text: run.text,
      ...(colour === undefined ? {} : { fg: RGBA.fromHex(colour) }),
      ...(run.style.attributes === 0 ? {} : { attributes: run.style.attributes }),
    };
  });
}

/** Styles laid-out rows for the theme. */
export function styleLines(
  lines: readonly LayoutLine[],
  palette: MarkdownPalette,
): readonly TuiMarkdownLine[] {
  return lines.map((line) => ({
    text: line.text,
    code: line.code,
    chunks: chunksOfLine(line, palette),
  }));
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
  return styleLines(layoutMarkdown(markdown, width), palette);
}
