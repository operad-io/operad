import { describe, expect, test } from "bun:test";
import { layoutMarkdown } from "../src/layout.ts";
import { BUILTIN_THEMES } from "../src/theme.ts";

const DIFF = [
  "```diff",
  " a.ts | 3 ++-",
  " b.ts | 10 ++++++----",
  " 2 files changed, 8 insertions(+), 5 deletions(-)",
  "",
  "diff --git a/a.ts b/a.ts",
  "new file mode 100644",
  "index 0000000..1111111",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,3 @@",
  " context",
  "-old",
  "+new",
  "```",
].join("\n");

function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

describe("a diff block", () => {
  const rows = layoutMarkdown(DIFF, 40);
  const roleOf = (prefix: string): (string | undefined)[] =>
    (rows.find((row) => row.text.trimStart().startsWith(prefix))?.runs ?? []).map((run) => run.style.role);

  test("has no line for the fence's language", () => {
    expect(rows.some((row) => row.text.trim() === "diff")).toBe(false);
    expect(rows).toHaveLength(14);
  });

  test("gives header, hunk, add, remove and context their roles", () => {
    expect(roleOf("diff --git")).toEqual(["accent"]);
    expect(rows.find((row) => row.text.includes("diff --git"))?.runs[0]?.style.attributes).toBeGreaterThan(0);
    expect(roleOf("new file mode")).toEqual(["accent"]);
    expect(roleOf("index")).toEqual(["accent"]);
    expect(roleOf("@@")).toEqual(["accent"]);
    expect(roleOf("+new")).toEqual(["add"]);
    expect(roleOf("-old")).toEqual(["remove"]);
    expect(roleOf("context")).toEqual([undefined]);
    expect(roleOf("2 files")).toEqual([undefined]);
  });

  test("colours the + and - runs of a --stat line", () => {
    const row = rows.find((r) => r.text.includes("b.ts"));
    const runs = row?.runs.map((run) => [run.style.role, run.text.trim()]);
    expect(runs?.slice(0, 3)).toEqual([
      [undefined, "b.ts | 10"],
      ["add", "++++++"],
      ["remove", "----"],
    ]);
  });

  test("is one rectangle: every row has the pane's width and one column of left padding", () => {
    for (const row of rows) expect(Bun.stringWidth(row.text)).toBe(40);
    expect(rows[0]?.text.startsWith("  a.ts")).toBe(true);
  });
});

describe("theme contrast", () => {
  for (const name of ["light", "dark"] as const) {
    const palette = BUILTIN_THEMES[name];
    test(`${name}: text and weak read on the background and the code background`, () => {
      for (const token of ["text", "weak"] as const) {
        expect(contrast(palette[token], palette.background)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(palette[token], palette.code)).toBeGreaterThanOrEqual(4.5);
      }
    });
    test(`${name}: add, remove and accent read on the code background`, () => {
      for (const token of ["add", "remove", "accent"] as const) {
        expect(contrast(palette[token], palette.code)).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
  test("terminal keeps ANSI colours", () => {
    const palette = BUILTIN_THEMES.terminal;
    for (const token of ["weak", "accent", "add", "remove"] as const) {
      expect(palette[token]).toMatch(/^ansi:\d+$/);
    }
  });
});

describe("a wrapped code row", () => {
  test("keeps the block's left padding and its width on every row", () => {
    const rows = layoutMarkdown("```diff\n+abcdefghijklmnop\n```", 8);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.text.startsWith(" ")).toBe(true);
      expect(Bun.stringWidth(row.text)).toBe(8);
    }
    expect(rows.map((row) => row.text.trim()).join("")).toBe("+abcdefghijklmnop");
  });
});
