import { describe, expect, test } from "bun:test";
import { RGBA, TextAttributes } from "@opentui/core";
import { layoutMarkdown } from "../src/layout.ts";
import { createTestRenderer } from "@opentui/core/testing";
import type { ViewObject, ViewRow } from "@operad-io/engine";
import { initialState, reduce, type TuiState } from "../src/state.ts";
import { TUI_PALETTE, createTuiView, drawState } from "../src/view/index.ts";
import { treeRows } from "./support.ts";

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

function state(markdown = MARKDOWN, width = 120, height = 30): TuiState {
  let next = reduce(initialState({ width, height }), {
    type: "types",
    types: [{ type: "item", title: "Item" }],
  });
  next = reduce(next, treeRows("plugin:item", [row("one")]));
  next = reduce(next, { type: "key", key: "3" });
  next = reduce(next, { type: "key", key: "enter" });
  next = reduce(next, { type: "object", object: object(), version: 1 });
  return reduce(next, {
    type: "section",
    objectId: "one",
    sectionId: "info",
    content: { markdown },
  });
}

const ints = (colour: string): string => RGBA.fromHex(colour).toInts().join(",");

describe("the TUI Markdown", () => {
  test("a diff is coloured, a table is aligned and a fence's language is not drawn", async () => {
    const setup = await createTestRenderer({ width: 120, height: 30 });
    try {
      const view = createTuiView(setup.renderer);
      view.render(state());
      await setup.renderOnce();

      const frame = setup.captureCharFrame();
      expect(frame).toContain("name   value");
      expect(frame).not.toContain("| name");
      expect(frame).toContain("────────────");
      expect(frame).toContain("alpha      1");
      expect(frame).toContain("long       2");
      expect(frame).not.toContain("mermaid");
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

  test("the screen keeps fenced code marked for a monospace client", () => {
    const chunks = drawState(state()).right.chunks;
    const drawn = chunks.map((chunk) => chunk.text).join("");
    const coded = (needle: string): boolean =>
      chunks.find((chunk) => chunk.text.includes(needle))?.bg !== undefined;
    expect(coded("+hello")).toBe(true);
    expect(coded("A-->B")).toBe(true);
    expect(drawn).not.toContain("mermaid");
    expect(chunks.find((chunk) => chunk.text.includes("alpha"))?.bg).toBeUndefined();
  });

  test("a four-backtick diff colours + and - lines and keeps indentation", () => {
    const chunks = drawState(
      state(
        "````diff\n--- a/f\n+++ b/f\n docs/manual.md | 2 +-\n docs/other.md | 1 +\n@@ -1 +1 @@\n-old\n+```\n+new\n````",
      ),
    ).right.chunks;
    const colourOf = (needle: string): string | undefined =>
      chunks.find((chunk) => chunk.text.includes(needle))?.fg?.toInts().join(",");
    expect(colourOf("+new")).toBe(ints(TUI_PALETTE.dark.add));
    expect(colourOf("+```")).toBe(ints(TUI_PALETTE.dark.add));
    expect(colourOf("-old")).toBe(ints(TUI_PALETTE.dark.remove));
    expect(colourOf("+++ b/f")).toBe(ints(TUI_PALETTE.dark.add));
    expect(colourOf("--- a/f")).toBe(ints(TUI_PALETTE.dark.remove));
    expect(colourOf("@@")).toBe(ints(TUI_PALETTE.dark.accent));
    const drawn = chunks.map((chunk) => chunk.text).join("");
    expect(drawn).toContain("  docs/manual.md | 2 +-");
    expect(drawn).toContain("  docs/other.md | 1 +");
  });
});

describe("tables fit the pane", () => {
  const tasks = [
    "| id | title | state | cost |",
    "| -- | ----- | ----- | ---- |",
    ...Array.from(
      { length: 13 },
      (_, i) =>
        `| T-${String(i + 1).padStart(4, "0")} | A long task title number ${i + 1} that describes a good deal of work to do | in_review | $${i + 1}.00 |`,
    ),
  ].join("\n");

  test("13 tasks at 100 columns take 15 rows none wider than the pane, and a resize re-lays them", () => {
    const wide = layoutMarkdown(tasks, 100);
    expect(wide).toHaveLength(15);
    for (const line of wide) {
      expect(Bun.stringWidth(line.text)).toBeLessThanOrEqual(100);
    }
    const header = wide[0];
    expect(header?.runs[0]?.style.role).toBe("weak");
    expect((header?.runs[0]?.style.attributes ?? 0) & TextAttributes.BOLD).not.toBe(0);
    const narrow = layoutMarkdown(tasks, 60);
    expect(narrow).toHaveLength(15);
    for (const line of narrow) {
      expect(Bun.stringWidth(line.text)).toBeLessThanOrEqual(60);
    }
    expect(narrow[5]?.text).not.toBe(wide[5]?.text);
    const drawn = drawState(state(tasks, 141, 40)).right.chunks.map((chunk) => chunk.text).join("");
    expect(drawn).toContain("A long task title number 13");
  });
});

describe("the TUI inline code", () => {
  test("a command with backticks in a longer fence is drawn as one code span without its fences", () => {
    const rows = layoutMarkdown("tool Bash 3s `` echo `date` ``", 80);
    expect(rows[0]?.text).toBe("tool Bash 3s echo `date`");
  });
});
