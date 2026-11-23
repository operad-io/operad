import { describe, expect, test } from "bun:test";
import type { StoredObject, ViewContext } from "@operad-io/engine";
import { botViews, followUpMarkdown } from "../src/index.ts";

describe("the bot page's text", () => {
  test("a value a person or the agent wrote is shown as text or code, not as Markdown", async () => {
    const object = {
      type: "bot",
      id: "default",
      version: 1,
      data: {
        cwd: "/tmp/a*b_c",
        harness: "cl*aude",
        speaker: "No_va",
        skills: ["/skills/my*skill"],
        mcpServers: ["no*tes"],
        problem: "bad *thing*",
      },
    } as unknown as StoredObject;
    const content = await botViews.load({ store: { list: () => ({ objects: [] }) } } as unknown as ViewContext, object, "bot", {});
    const text = content.markdown;
    expect(text).toContain("Working directory: `/tmp/a*b_c`");
    expect(text).toContain("Default agent: cl\\*aude");
    expect(text).toContain("Speaker: No\\_va");
    expect(text).toContain("my\\*skill");
    expect(text).toContain("MCP servers: no\\*tes");
    expect(text).toContain("Cannot be used: bad \\*thing\\*");
  });

  test("a follow-up's text is escaped", () => {
    const lines = followUpMarkdown([
      { id: "f1", at: Date.parse("2026-01-01T00:00:00Z"), chat: "C-1", setAt: 0, text: "check *this* _now_" },
    ]);
    expect(lines[1]).toContain("check \\*this\\* \\_now\\_");
  });
});
