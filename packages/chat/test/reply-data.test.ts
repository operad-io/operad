import { describe, expect, test } from "bun:test";
import { replyData, type ReplyBlock, type ReplyToolItem } from "../src/index.ts";

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

function block(index: number, textLength: number): ReplyBlock {
  const tool: ReplyToolItem = {
    kind: "tool",
    callId: `c${index}`,
    name: "Bash",
    input: "y".repeat(textLength),
    failed: false,
    output: { text: "o".repeat(textLength), lines: 1 },
  };
  return {
    runId: `run-${index}`,
    input: [{ id: `q${index}`, text: "q".repeat(textLength), at: index }],
    process: [
      {
        categories: ["run"],
        items: [{ kind: "thinking", text: "t".repeat(textLength) }, { kind: "text", text: "x".repeat(textLength) }, tool],
      },
    ],
    answer: { id: `a${index}`, text: "a".repeat(textLength), at: index },
  };
}

function shown(data: Readonly<Record<string, unknown>>): readonly ReplyBlock[] {
  return data.replies as readonly ReplyBlock[];
}

describe("replyData over its budget", () => {
  test("a shortened tool input carries cut, the newest tool input stays whole", () => {
    const replies = Array.from({ length: 6 }, (_, index) => block(index, 2_000));
    const data = replyData(replies, 20_000);
    const out = shown(data);
    const inputOf = (reply: ReplyBlock | undefined): ReplyToolItem | undefined =>
      reply?.process[0]?.items.find((item): item is ReplyToolItem => item.kind === "tool");
    expect(inputOf(out[0])?.cut).toBe(true);
    expect(inputOf(out[0])?.input?.length ?? 0).toBeLessThan(2_000);
    expect(inputOf(out.at(-1))?.cut).toBeUndefined();
    expect(inputOf(out.at(-1))?.input).toBe("y".repeat(2_000));
  });

  test("every budget is met, from a few cuts to dropping the oldest replies", () => {
    const replies = Array.from({ length: 12 }, (_, index) => block(index, 1_500));
    const base = { queuedCount: 0 };
    let dropped = false;
    for (const max of [60_000, 30_000, 12_000, 6_000, 3_000, 1_500, 700]) {
      const data = replyData(replies, max, base);
      expect(bytes(data)).toBeLessThanOrEqual(max);
      expect(data.queuedCount).toBe(0);
      if (shown(data).length < replies.length) dropped = true;
    }
    expect(dropped).toBe(true);
  });

  test("the incremental total equals the real size: the result is the first fit, within one reply of the budget", () => {
    const replies = Array.from({ length: 10 }, (_, index) => block(index, 1_000));
    const wholeSize = bytes({ replies });
    const max = Math.floor(wholeSize * 0.6);
    const data = replyData(replies, max);
    const size = bytes(data);
    expect(size).toBeLessThanOrEqual(max);
    // One more cut step would not be needed: the result is the first fit, so
    // it is not far below the budget (one reply's step at most).
    expect(max - size).toBeLessThan(bytes(block(0, 1_000)));
  });

  test("the running total is exact: the real size is a fit, and one byte less changes the result", () => {
    const replies = Array.from({ length: 10 }, (_, index) => block(index, 1_000));
    const base = { queuedCount: 0 };
    const first = replyData(replies, Math.floor(bytes({ ...base, replies }) * 0.6), base);
    const exact = bytes(first);
    expect(replyData(replies, exact, base)).toEqual(first);
    const tighter = replyData(replies, exact - 1, base);
    expect(tighter).not.toEqual(first);
    expect(bytes(tighter)).toBeLessThanOrEqual(exact - 1);
  });

  test("a cut reply marks its thinking, text, tool input and input message, and the newest stays whole", () => {
    const replies = Array.from({ length: 6 }, (_, index) => block(index, 2_000));
    const out = shown(replyData(replies, 20_000));
    const oldest = out[0];
    const items = oldest?.process[0]?.items ?? [];
    const thinking = items.find((item) => item.kind === "thinking");
    const text = items.find((item) => item.kind === "text");
    const tool = items.find((item): item is ReplyToolItem => item.kind === "tool");
    for (const part of [thinking, text, tool]) expect(part?.cut).toBe(true);
    expect(thinking?.kind === "thinking" ? thinking.text.length : 2_000).toBeLessThan(2_000);
    expect(text?.kind === "text" ? text.text.length : 2_000).toBeLessThan(2_000);
    expect(oldest?.input[0]?.cut).toBe(true);
    expect(oldest?.input[0]?.text.length ?? 2_000).toBeLessThan(2_000);
    const newest = out.at(-1);
    expect(newest?.input[0]?.cut).toBeUndefined();
    expect(newest?.input[0]?.text).toBe("q".repeat(2_000));
    for (const item of newest?.process[0]?.items ?? []) expect(item.cut).toBeUndefined();
  });

  test("the work is linear: 200 replies over budget measure a bounded number of bytes", () => {
    const replies = Array.from({ length: 200 }, (_, index) => block(index, 1_200));
    const wholeSize = bytes({ replies });
    let calls = 0;
    let total = 0;
    const data = replyData(replies, Math.floor(wholeSize / 5), {}, (value) => {
      calls += 1;
      const n = bytes(value);
      total += n;
      return n;
    });
    expect(bytes(data)).toBeLessThanOrEqual(Math.floor(wholeSize / 5));
    expect(shown(data).length).toBeGreaterThan(0);
    // The whole page once, every reply once, and at most four steps of one
    // reply's size per reply: a handful of page passes, never one per step.
    expect(total).toBeLessThanOrEqual(wholeSize * 4);
    expect(calls).toBeLessThanOrEqual(2 + 200 + 4 * 200);
  });
});
