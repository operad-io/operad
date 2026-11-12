import { describe, expect, test } from "bun:test";
import { capToolOutput, emptyFold, foldLines, TOOL_OUTPUT_CAP_BYTES, type FoldState } from "../src/index.ts";

const start = (id: string, name = "Bash", input?: string, at = 100): unknown => ({
  type: "tool_execution_start",
  toolCallId: id,
  toolName: name,
  at,
  ...(input === undefined ? {} : { input }),
});
const end = (id: string, extra: Record<string, unknown> = {}): unknown => ({
  type: "tool_execution_end",
  toolCallId: id,
  toolName: "Bash",
  isError: false,
  durationMs: 5,
  ...extra,
});

function oneByOne(lines: readonly unknown[]): FoldState {
  let state = emptyFold;
  for (const line of lines) state = foldLines([line], state);
  return state;
}

describe("foldLines", () => {
  test("a tool call with an end is an entry with its facts", () => {
    const state = foldLines([start("t1", "Bash", "make test", 50), { type: "tool_output", toolCallId: "t1", text: "ok" }, end("t1")]);
    expect(state.entries).toEqual([
      {
        kind: "tool",
        callId: "t1",
        toolName: "Bash",
        input: "make test",
        result: "done",
        at: 50,
        durationMs: 5,
        output: "ok",
        outputTruncated: false,
        error: null,
      },
    ]);
    expect(state.calls).toEqual([]);
  });

  test("a call with no end is unfinished, not an entry", () => {
    const state = foldLines([start("t1", "Bash", "sleep 9")]);
    expect(state.entries).toEqual([]);
    expect(state.calls.map((c) => [c.callId, c.toolName, c.input, c.at])).toEqual([["t1", "Bash", "sleep 9", 100]]);
  });

  test("a failed call keeps the first line of its error", () => {
    const state = foldLines([start("t1"), end("t1", { isError: true, error: "boom\nmore" })]);
    expect(state.entries[0]).toMatchObject({ result: "failed", error: "boom" });
  });

  test("a blocked call is blocked, with the reason as its error", () => {
    const state = foldLines([
      start("t1", "Write"),
      { type: "blocked", toolName: "Write", reason: "path is not allowed\nrule x" },
      end("t1", { isError: true }),
    ]);
    expect(state.entries[0]).toMatchObject({ result: "blocked", error: "path is not allowed" });
  });

  test("a blocked line that comes before its call's start still marks that call", () => {
    const state = foldLines([{ type: "blocked", toolName: "Write", reason: "no" }, start("t1", "Write"), end("t1", { isError: true })]);
    expect(state.entries[0]).toMatchObject({ result: "blocked" });
  });

  test("a call the access profile denied is denied", () => {
    const state = foldLines([start("t1", "Read", "Read denied by the access profile (rule: /x)"), end("t1", { isError: true })]);
    expect(state.entries[0]).toMatchObject({ result: "denied", error: null });
  });

  test("text, then a tool, then text", () => {
    const lines = [
      { type: "text_delta", text: "Let me " },
      { type: "text_delta", text: "look." },
      start("t1"),
      end("t1"),
      { type: "text_delta", text: "Done" },
      { type: "text_end", text: "Done." },
      { type: "text_delta", text: "tail" },
    ];
    const state = foldLines(lines);
    expect(state.entries.map((e) => (e.kind === "tool" ? "tool" : `${e.kind}:${e.text}`))).toEqual([
      "text:Let me look.",
      "tool",
      "text:Done.",
    ]);
    expect(state.text).toBe("tail");
  });

  test("increments add up to the finished text, and a finished message wins over the increments", () => {
    const increments = [
      { type: "text_delta", text: "a" },
      { type: "text_delta", text: "b" },
      { type: "thinking_delta", text: "x" },
      { type: "thinking_delta", text: "y" },
    ];
    const open = foldLines(increments);
    expect(open.text).toBe("ab");
    expect(open.thinking).toBe("xy");
    const done = foldLines([...increments, { type: "thinking_end", text: "xy" }, { type: "text_end", text: "ab" }]);
    expect(done.entries).toEqual([
      { kind: "thinking", text: "xy" },
      { kind: "text", text: "ab" },
    ]);
    expect(done.text).toBe("");
    expect(done.thinking).toBe("");
  });

  test("today's message_end text is an entry only when no text came before it", () => {
    const only = foldLines([{ type: "message_end", role: "assistant", text: "head" }]);
    expect(only.entries).toEqual([{ kind: "text", text: "head" }]);
    const both = foldLines([{ type: "text_end", text: "full text" }, { type: "message_end", role: "assistant", text: "full" }]);
    expect(both.entries).toEqual([{ kind: "text", text: "full text" }]);
  });

  test("a truncated output says so", () => {
    const state = foldLines([start("t1"), { type: "tool_output", toolCallId: "t1", text: "abc", truncated: true }, end("t1")]);
    expect(state.entries[0]).toMatchObject({ output: "abc", outputTruncated: true });
  });

  test("lines that are not log lines are skipped", () => {
    expect(foldLines(["x", null, 3, { type: "result" }, { type: "tool_execution_end" }]).entries).toEqual([]);
  });

  test("one by one gives the same state as all at once, at every cut", () => {
    const lines = [
      { type: "thinking_delta", text: "hm" },
      { type: "thinking_end", text: "hm" },
      { type: "text_delta", text: "I will " },
      { type: "text_delta", text: "run it" },
      start("t1", "Bash", "ls"),
      start("t2", "Write", "a.ts"),
      { type: "blocked", toolName: "Write", reason: "no" },
      end("t2", { isError: true, toolName: "Write" }),
      { type: "tool_output", toolCallId: "t1", text: "file" },
      end("t1"),
      { type: "message_end", role: "assistant", text: "I will run it" },
      { type: "text_delta", text: "more" },
      start("t3"),
    ];
    const all = foldLines(lines);
    expect(oneByOne(lines)).toEqual(all);
    for (let cut = 0; cut <= lines.length; cut += 1) {
      expect(foldLines(lines.slice(cut), foldLines(lines.slice(0, cut)))).toEqual(all);
    }
    expect(all.calls.map((c) => c.callId)).toEqual(["t3"]);
    expect(all.entries.filter((e) => e.kind === "text").map((e) => e.kind === "text" && e.text)).toEqual(["I will run it", "more"]);
  });
});

describe("capToolOutput", () => {
  test("keeps short text and cuts long text at the cap without splitting a character", () => {
    expect(capToolOutput("short")).toEqual({ text: "short", truncated: false });
    const cut = capToolOutput("é".repeat(TOOL_OUTPUT_CAP_BYTES));
    expect(cut.truncated).toBe(true);
    expect(new TextEncoder().encode(cut.text).length).toBeLessThanOrEqual(TOOL_OUTPUT_CAP_BYTES);
    expect(cut.text).not.toContain("�");
  });
});
