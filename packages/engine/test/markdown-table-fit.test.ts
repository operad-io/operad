import { describe, expect, test } from "bun:test";
import { renderMarkdownLines } from "../src/markdown.ts";

function fit(markdown: string, width?: number): string[] {
  return renderMarkdownLines(markdown, width === undefined ? {} : { width }).map(
    (line) => line.text,
  );
}

const TITLE = "A very long task title that goes on and on and on and on";
const TABLE = [
  "| id | title | state | cost | time |",
  "| -- | ----- | ----- | ---- | ---- |",
  `| T-0001 | ${TITLE} | in_review | $12.50 | 3m |`,
  "| T-0002 | Short | done | $3.00 | 12m |",
].join("\n");

describe("table fit", () => {
  test("no width keeps today's output", () => {
    const lines = fit(TABLE);
    expect(lines[0]).toContain("|");
    expect(lines[1]).toContain("|--");
  });

  test("a table narrower than the width keeps its content, without pipes", () => {
    const lines = fit("| a | b |\n| -- | -- |\n| one | two |", 40);
    expect(lines).toEqual(["a    b", "─".repeat(8), "one  two"]);
  });

  test("a wide table fits: the title is cut with …, short columns are whole", () => {
    const lines = fit(TABLE, 50);
    expect(lines).toHaveLength(4);
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(50);
    expect(lines[2]).toContain("…");
    expect(lines[2]).toContain("T-0001");
    expect(lines[2]).toContain("in_review");
    expect(lines[2]).toContain("$12.50");
    expect(lines.join("\n")).not.toContain("|");
    expect(lines[1]).toMatch(/^─+$/);
  });

  test("numbers, durations and money are right-aligned", () => {
    const lines = fit(TABLE, 50);
    const end = (line: string | undefined, text: string): number =>
      (line?.indexOf(text) ?? -1) + text.length;
    expect(end(lines[2], "$12.50")).toBe(end(lines[3], "$3.00"));
    expect(end(lines[2], "3m")).toBe(end(lines[3], "12m"));
  });

  test("squeezed hard, text columns give way and number columns keep their width", () => {
    const lines = fit(TABLE, 30);
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(30);
    expect(lines[2]).toContain("$12.50");
    expect(lines[3]).toContain("12m");
    expect(lines[2]).toContain("…");
  });

  test("the header is bold and weak with colour", () => {
    const lines = renderMarkdownLines(TABLE, { width: 50, colour: true });
    expect(lines[0]?.text).toContain("\x1b[1m\x1b[90m");
  });

  test("wide characters are measured in columns, so a CJK title fits", () => {
    const table = [
      "| id | title | cost |",
      "| -- | ----- | ---- |",
      "| T-1 | 这是一个很长的中文任务标题需要显示 | $1.00 |",
      "| T-2 | 😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀 | $2.00 |",
    ].join("\n");
    const lines = fit(table, 40);
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40);
    expect(lines[2]).toContain("…");
    expect(lines[3]).toContain("…");
    expect(lines[2]).toContain("$1.00");
  });
});
