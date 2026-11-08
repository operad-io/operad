/**
 * The TUI's Markdown drawing: the engine renders the lines, `layout.ts` cleans
 * and wraps them, and this turns a laid-out row into OpenTUI chunks in the
 * theme's colours. It owns no layout and decides no colours beyond the palette
 * it is given.
 */

import type { TextChunk } from "@opentui/core";
import { toRgba, type TuiPalette } from "./theme.ts";
import {
  layoutMarkdown,
  type LayoutLine,
  type LayoutRole,
} from "./layout.ts";

/** The colours Markdown needs; the view's palette has them. */
export type MarkdownPalette = Pick<TuiPalette, "accent" | "run" | "error" | "add" | "remove" | "weak" | "text" | "code">;

/** One drawn line: its chunks, its plain text and whether it is fenced code. */
export interface TuiMarkdownLine {
  readonly text: string;
  readonly code: boolean;
  readonly chunks: readonly TextChunk[];
}

function colourFor(
  role: LayoutRole,
  palette: MarkdownPalette,
): string {
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
      return palette.text;
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
      fg: toRgba(colour),
      ...(line.code ? { bg: toRgba(palette.code) } : {}),
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
