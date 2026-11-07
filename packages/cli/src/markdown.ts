/**
 * The CLI's terminal Markdown renderer now lives in the engine, so the TUI
 * draws the same lines. This module keeps the CLI's import path and names.
 */

export {
  renderMarkdown,
  renderMarkdownLines,
  type MarkdownLine,
  type RenderOptions,
} from "@operad-io/engine";
