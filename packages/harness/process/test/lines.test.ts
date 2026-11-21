import { describe, expect, test } from "bun:test";
import {
  Increments,
  maskSecrets,
  splitSecretPrefix,
  STREAM_GROUP_MS,
  type IncrementKind,
  type IncrementLine,
} from "../src/index.ts";

describe("lines", () => {
  test("splitSecretPrefix holds back an escaped secret split across grouped increments", () => {
    const secret = 'a"b';
    const escaped = 'a\\"b';
    const first = splitSecretPrefix(`AAAAa\\"`, [secret]);
    expect(first).toEqual({ emit: "AAAA", held: 'a\\"' });

    const second = splitSecretPrefix(`${first.held}bBBBB`, [secret]);
    const joined = maskSecrets(first.emit, [secret]) + maskSecrets(second.emit, [secret]);
    expect(joined).toBe("AAAA***BBBB");
    expect(joined).not.toContain(escaped);
  });

  test("Increments groups its first text and thinking when firstImmediately is false", () => {
    for (const kind of ["text", "thinking"] as const satisfies readonly IncrementKind[]) {
      let now = 0;
      const lines: IncrementLine[] = [];
      const increments = new Increments({ line: (line) => lines.push(line) }, () => now, [], {
        firstImmediately: false,
      });
      const delta = kind === "text" ? "text_delta" : "thinking_delta";

      increments[kind]("ab");
      expect(lines).toEqual([]);

      now = STREAM_GROUP_MS;
      increments[kind]("cd");
      expect(lines).toEqual([{ type: delta, text: "ab" }]);

      increments.flush(kind, true);
      expect(lines).toEqual([
        { type: delta, text: "ab" },
        { type: delta, text: "cd" },
      ]);
    }
  });
});
