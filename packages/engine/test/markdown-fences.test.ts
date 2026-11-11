import { describe, expect, test } from "bun:test";
import { renderMarkdownLines } from "../src/markdown.ts";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";

function code(markdown: string): string[] {
  return renderMarkdownLines(markdown)
    .filter((line) => line.code)
    .map((line) => line.text);
}

describe("markdown fences", () => {
  test("a four-backtick fence reads its language and colours a diff", () => {
    const lines = renderMarkdownLines("````diff\n-old\n+new\n````", { colour: true });
    expect(lines.some((l) => l.text.includes(RED) && l.text.includes("-old"))).toBe(true);
    expect(lines.some((l) => l.text.includes(GREEN) && l.text.includes("+new"))).toBe(true);
    expect(code("````diff\n-old\n````")[0]).toBe("  diff");
  });

  test("a tilde fence has a language", () => {
    expect(code("~~~diff\n+a\n~~~")).toEqual(["  diff", "  +a"]);
    expect(code("~~~~ts\nx\n~~~~")).toEqual(["  ts", "  x"]);
  });

  test("a ``` line inside a ```` fence is content", () => {
    expect(code("````diff\n+```\n```\n+x\n````\nafter")).toEqual([
      "  diff",
      "  +```",
      "  ```",
      "  +x",
    ]);
  });

  test("closing needs the same character and a length at least the opening's", () => {
    expect(code("````\na\n```\n~~~~\nb\n`````\nc")).toEqual([
      "  a",
      "  ```",
      "  ~~~~",
      "  b",
    ]);
    expect(code("~~~\na\n```\nb\n~~~~\nc")).toEqual(["  a", "  ```", "  b"]);
  });

  test("a closing fence may not carry text", () => {
    expect(code("```\na\n``` x\nb\n```")).toEqual(["  a", "  ``` x", "  b"]);
  });

  test("only the first word of the info string is the language", () => {
    expect(code("```diff title=x\n+a\n```")[0]).toBe("  diff");
  });

  test("an unclosed fence runs to the end", () => {
    expect(code("````diff\n+a\n```\nb")).toEqual(["  diff", "  +a", "  ```", "  b"]);
  });

  test("leading spaces of code lines are kept", () => {
    expect(code("```\n a\n    b\n```")).toEqual(["   a", "      b"]);
  });

  test("a fence indented four spaces is not a fence", () => {
    expect(code("    ```\nx")).toEqual([]);
  });

  test("inline code written with a longer backtick fence is one span", () => {
    const plain = renderMarkdownLines("tool Bash 3s `` echo `date` ``").map((line) => line.text);
    expect(plain).toEqual(["tool Bash 3s echo `date`"]);
    const coloured = renderMarkdownLines("a `` x`y `` b", { colour: true })[0]?.text ?? "";
    expect(coloured).toContain(`${"\x1b[36m"}x\`y`);
    expect(coloured).not.toContain("``");
    expect(renderMarkdownLines("use `one` and `two`").map((line) => line.text)).toEqual(["use one and two"]);
  });
});
