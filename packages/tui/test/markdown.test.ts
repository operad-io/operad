import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { ViewObject, ViewRow } from "@operad-io/engine";
import { initialState, reduce, type TuiState } from "../src/state.ts";
import { TUI_PALETTE, createTuiView } from "../src/view/index.ts";
import { markdownLines } from "../src/markdown.ts";

const MARKDOWN = [
  "| name | value |",
  "| ---- | ----- |",
  "| alpha | 1 |",
  "| long | 2 |",
  "",
  "```diff",
  "--- a/x",
  "+++ b/x",
  "@@ -1 +1 @@",
  "-old",
  "+hello",
  "```",
  "",
  "```mermaid",
  "graph TD",
  "  A-->B",
  "```",
].join("\n");

function row(id: string): ViewRow {
  return {
    id,
    title: `Title ${id}`,
    state: "new",
    waiting: false,
    running: false,
  };
}

function object(): ViewObject {
  return {
    id: "one",
    type: "item",
    link: "operad://objects/item%3Aone",
    row: row("one"),
    sections: [{ id: "info", title: "Info" }],
    actions: [],
  };
}

function state(): TuiState {
  let next = reduce(initialState({ width: 120, height: 30 }), {
    type: "types",
    types: [{ type: "item", title: "Item" }],
  });
  next = reduce(next, {
    type: "page",
    tabId: "type:item",
    replace: true,
    page: { rows: [row("one")] },
  });
  next = reduce(next, { type: "key", key: "3" });
  next = reduce(next, { type: "key", key: "enter" });
  next = reduce(next, { type: "object", object: object(), version: 1 });
  return reduce(next, {
    type: "section",
    objectId: "one",
    sectionId: "info",
    content: { markdown: MARKDOWN },
  });
}

const ints = (colour: string): string => RGBA.fromHex(colour).toInts().join(",");

describe("the TUI Markdown", () => {
  test("a diff is coloured, a table is aligned and a mermaid block keeps its label", async () => {
    const setup = await createTestRenderer({ width: 120, height: 30 });
    try {
      const view = createTuiView(setup.renderer);
      view.render(state());
      await setup.renderOnce();

      const frame = setup.captureCharFrame();
      expect(frame).toContain("| name  | value |");
      expect(frame).toContain("|-------|-------|");
      expect(frame).toContain("| alpha | 1     |");
      expect(frame).toContain("| long  | 2     |");
      expect(frame).toContain("mermaid");
      expect(frame).toContain("graph TD");
      expect(frame).toContain("A-->B");
      expect(frame).toContain("+hello");
      expect(frame).toContain("-old");

      const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
      const added = spans.filter((span) => span.text.includes("+hello"));
      const removed = spans.filter((span) => span.text.includes("-old"));
      expect(added.some((span) => span.fg.toInts().join(",") === ints(TUI_PALETTE.dark.add))).toBe(true);
      expect(removed.some((span) => span.fg.toInts().join(",") === ints(TUI_PALETTE.dark.remove))).toBe(true);
      view.destroy();
    } finally {
      await setup.dispose();
    }
  });

  test("the engine's lines keep fenced code marked for a monospace client", () => {
    const lines = markdownLines(MARKDOWN, TUI_PALETTE.dark);
    const diff = lines.find((line) => line.text.includes("+hello"));
    const mermaid = lines.find((line) => line.text.includes("mermaid"));
    expect(diff?.code).toBe(true);
    expect(mermaid?.code).toBe(true);
    expect(lines.find((line) => line.text.includes("| alpha"))?.code).toBe(false);
  });

  test("a four-backtick diff colours + and - lines and keeps indentation", () => {
    const lines = markdownLines(
      "````diff\n docs/manual.md | 2 +-\n docs/other.md | 1 +\n@@ -1 +1 @@\n-old\n+```\n+new\n````",
      TUI_PALETTE.dark,
    );
    const colourOf = (needle: string): string | undefined => {
      const found = lines.find((line) => line.text.includes(needle));
      const fg = found?.chunks.find((chunk) => chunk.fg !== undefined)?.fg;
      return fg?.toInts().join(",");
    };
    const ints = (hex: string): string => RGBA.fromHex(hex).toInts().join(",");
    expect(colourOf("+new")).toBe(ints(TUI_PALETTE.dark.add));
    expect(colourOf("+```")).toBe(ints(TUI_PALETTE.dark.add));
    expect(colourOf("-old")).toBe(ints(TUI_PALETTE.dark.remove));
    expect(colourOf("@@")).toBe(ints(TUI_PALETTE.dark.accent));
    const texts = lines.map((line) => line.text);
    expect(texts).toContain("   docs/manual.md | 2 +-");
    expect(texts).toContain("   docs/other.md | 1 +");
  });
});
