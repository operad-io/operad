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
    const data = replyData(replies, 30_000);
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
    const out = shown(replyData(replies, 30_000));
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
    // The whole page once, every reply once, and at most five steps of one
    // reply's size per reply: a handful of page passes, never one per step.
    expect(total).toBeLessThanOrEqual(wholeSize * 5);
    expect(calls).toBeLessThanOrEqual(2 + 200 + 5 * 200);
  });

  test("older replies keep a non-empty answer preview while their thinking and tool input are emptied first", () => {
    const answer = "First line of the answer.\nSecond line goes on a while. ".repeat(40);
    const replies = Array.from({ length: 6 }, (_, index) => ({ ...block(index, 2_000), answer: { id: `a${index}`, text: answer, at: index } }));
    const max = 7_000;
    const out = shown(replyData(replies, max));
    expect(bytes({ replies: out })).toBeLessThanOrEqual(max);
    expect(out.length).toBe(6);
    for (const reply of out.slice(0, -1)) {
      const text = reply.answer?.text ?? "";
      expect(text.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(200);
      expect(text.endsWith("…")).toBe(true);
      expect(reply.answer?.cut).toBe(true);
      const items = reply.process[0]?.items ?? [];
      for (const item of items) {
        if (item.kind === "tool") expect(item.input).toBe("");
        else expect(item.text).toBe("");
      }
      expect((reply.input[0]?.text.length ?? 0)).toBeGreaterThan(0);
    }
    const newest = out.at(-1);
    expect(newest?.answer?.text).toBe(answer);
    expect(newest?.answer?.cut).toBeUndefined();
  });

  test("the preview cuts at a line end when one is near and never inside a code point", () => {
    const line = "a".repeat(150);
    const reply = { ...block(0, 10), answer: { id: "a", text: `${line}\n${"b".repeat(400)}`, at: 0 } };
    const filler = Array.from({ length: 3 }, (_, index) => block(index + 1, 3_000));
    const out = shown(replyData([reply, ...filler], 8_000));
    expect(out[0]?.answer?.text).toBe(`${line}…`);
    const emoji = { ...block(0, 10), answer: { id: "a", text: "😀".repeat(200), at: 0 } };
    const out2 = shown(replyData([emoji, ...filler], 8_000));
    const text = out2[0]?.answer?.text ?? "";
    expect(text).toBe(`${"😀".repeat(text.length === 0 ? 0 : (text.length - 1) / 2)}…`);
    expect(text.length).toBeGreaterThan(1);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(200);
    // A pair that starts exactly where the cap falls is dropped whole, not split.
    const split = { ...block(0, 10), answer: { id: "a", text: `${"a".repeat(194)}😀${"b".repeat(300)}`, at: 0 } };
    const out3 = shown(replyData([split, ...filler], 8_000));
    expect(out3[0]?.answer?.text).toBe(`${"a".repeat(194)}…`);
  });

  test("the preview floor is broken only when nothing else is left", () => {
    const answer = "w".repeat(2_000);
    const replies = Array.from({ length: 5 }, (_, index) => ({ ...block(index, 300), answer: { id: `a${index}`, text: answer, at: index } }));
    const floored = (reply: ReplyBlock): ReplyBlock => ({
      ...reply,
      input: [{ id: reply.input[0]?.id ?? "", text: `${"q".repeat(197)}…`, at: reply.input[0]?.at ?? 0, cut: true }],
      process: [
        {
          categories: ["run"],
          items: [
            { kind: "thinking", text: "", cut: true },
            { kind: "text", text: "", cut: true },
            { kind: "tool", callId: reply.process[0]?.items[2]?.kind === "tool" ? (reply.process[0].items[2].callId) : "", name: "Bash", input: "", failed: false, output: { text: "", lines: 1, truncated: true }, cut: true },
          ],
        },
      ],
      answer: { id: reply.answer?.id ?? "", text: `${"w".repeat(197)}…`, at: reply.answer?.at ?? 0, cut: true },
    });
    const floorSize = bytes({ replies: replies.map(floored) });
    // With every answer at the preview the page fits exactly.
    const atFloor = shown(replyData(replies, floorSize));
    for (const reply of atFloor) expect(Buffer.byteLength(reply.answer?.text ?? "", "utf8")).toBe(200);
    // One byte less breaks the floor for the oldest reply alone.
    const under = shown(replyData(replies, floorSize - 1));
    expect(Buffer.byteLength(under[0]?.answer?.text ?? "", "utf8")).toBeLessThan(200);
    for (const reply of under.slice(1)) expect(Buffer.byteLength(reply.answer?.text ?? "", "utf8")).toBe(200);
    // Far below it, an answer goes under the preview.
    const below = shown(replyData(replies, 1_500));
    expect(below.some((reply) => Buffer.byteLength(reply.answer?.text ?? "", "utf8") < 200)).toBe(true);
  });
});
