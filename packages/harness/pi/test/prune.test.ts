import { expect, test } from "bun:test";
import { lastAssistantAt, placeholderFor, pruneToolResults, type PruneSettings } from "../src/prune.ts";

const SETTINGS: PruneSettings = { ttlMs: 300_000, keepTurns: 2, minChars: 1_000 };
const T0 = 1_700_000_000_000;

function assistant(at: number): Record<string, unknown> {
  return { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: at };
}
function result(toolName: string, size: number, id = toolName): Record<string, unknown> {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName,
    isError: false,
    content: [{ type: "text", text: "x".repeat(size) }],
    timestamp: T0,
  };
}
function texts(messages: readonly unknown[]): string[] {
  return messages.map((m) => {
    const content = (m as { content: { text?: string }[] }).content;
    return content[0]?.text ?? "";
  });
}

// Four turns with a big result each, then a last one.
function chat(): Record<string, unknown>[] {
  return [
    { role: "user", content: "go", timestamp: T0 },
    assistant(T0),
    result("read", 2_000, "a"),
    assistant(T0),
    result("bash", 2_000, "b"),
    assistant(T0),
    result("grep", 2_000, "c"),
    assistant(T0),
    result("read", 2_000, "d"),
    assistant(T0),
  ];
}

test("before the cache lifetime ends nothing is pruned", () => {
  const messages = chat();
  const out = pruneToolResults(messages, SETTINGS, T0 + SETTINGS.ttlMs, T0);
  expect(out.pruned).toBe(0);
  expect(out.messages).toBe(messages);
});

test("after it, old results become a placeholder naming the tool and recent ones stay", () => {
  const messages = chat();
  const out = pruneToolResults(messages, SETTINGS, T0 + SETTINGS.ttlMs + 1, T0);
  expect(out.pruned).toBe(3);
  const shown = texts(out.messages);
  expect(shown[2]).toBe(placeholderFor("read"));
  expect(shown[4]).toBe(placeholderFor("bash"));
  expect(shown[6]).toBe(placeholderFor("grep"));
  // The result after the kept turns' boundary is whole.
  expect(shown[8]).toBe("x".repeat(2_000));
  // The id and the error flag stay, so the call still pairs with its result.
  expect(out.messages[2]).toMatchObject({ role: "toolResult", toolCallId: "a", toolName: "read", isError: false });
});

test("the transcript given is not changed", () => {
  const messages = chat();
  pruneToolResults(messages, SETTINGS, T0 + 10 * SETTINGS.ttlMs, T0);
  expect(texts(messages)[2]).toBe("x".repeat(2_000));
});

test("below the minimum savings nothing is pruned even after expiry", () => {
  const messages = chat();
  const late = T0 + 10 * SETTINGS.ttlMs;
  const out = pruneToolResults(messages, { ...SETTINGS, minChars: 10_000 }, late, T0);
  expect(out.pruned).toBe(0);
  expect(out.messages).toBe(messages);
  // At exactly what it frees, it prunes; one more and it does not.
  const freed = pruneToolResults(messages, SETTINGS, late, T0).freed;
  expect(pruneToolResults(messages, { ...SETTINGS, minChars: freed }, late, T0).pruned).toBe(3);
  expect(pruneToolResults(messages, { ...SETTINGS, minChars: freed + 1 }, late, T0).pruned).toBe(0);
});

test("a chat shorter than the kept turns is never pruned", () => {
  const short = [assistant(T0), result("read", 50_000)];
  expect(pruneToolResults(short, { ...SETTINGS, keepTurns: 3 }, T0 + 10 * SETTINGS.ttlMs, T0).pruned).toBe(0);
});

test("a result no longer than its placeholder is left alone and an image-only one counts nothing", () => {
  const messages = [
    assistant(T0),
    result("read", 3),
    {
      role: "toolResult",
      toolCallId: "i",
      toolName: "screenshot",
      isError: false,
      content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      timestamp: T0,
    },
    assistant(T0),
    assistant(T0),
  ];
  expect(pruneToolResults(messages, { ...SETTINGS, minChars: 0 }, T0 + 10 * SETTINGS.ttlMs, T0).pruned).toBe(0);
});

test("an unknown time of the last message counts as a live cache", () => {
  expect(pruneToolResults(chat(), SETTINGS, T0 + 10 * SETTINGS.ttlMs, undefined).pruned).toBe(0);
});

test("lastAssistantAt reads the last assistant message's time", () => {
  const messages = [assistant(5), result("read", 1), assistant(9), { role: "user", content: "hi", timestamp: 99 }];
  expect(lastAssistantAt(messages)).toBe(9);
  expect(lastAssistantAt([{ role: "user", content: "hi", timestamp: 99 }])).toBeUndefined();
});
