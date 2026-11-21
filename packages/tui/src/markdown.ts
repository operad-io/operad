/**
 * The TUI's Markdown drawing: the engine renders the lines, `layout.ts` cleans
 * and wraps them, and this turns a laid-out row into OpenTUI chunks in the
 * theme's colours. It owns no layout and decides no colours beyond the palette
 * it is given.
 */

import type { TextChunk } from "@opentui/core";
import { toRgba, type TuiPalette } from "./theme.ts";
import type { LayoutLine, LayoutRole } from "./layout.ts";

/** The colours Markdown needs; the view's palette has them. */
export type MarkdownPalette = Pick<TuiPalette, "accent" | "run" | "error" | "add" | "remove" | "weak" | "text" | "code">;

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

/** One laid-out row in the palette's colours; `weak` draws every run in the weak colour. */
export function chunksOfLine(
  line: LayoutLine,
  palette: MarkdownPalette,
  weak = false,
): TextChunk[] {
  return line.runs.map((run) => {
    const colour = weak ? palette.weak : colourFor(run.style.role, palette);
    return {
      __isChunk: true,
      text: run.text,
      fg: toRgba(colour),
      ...(line.code ? { bg: toRgba(palette.code) } : {}),
      ...(run.style.attributes === 0 ? {} : { attributes: run.style.attributes }),
    };
  });
}

