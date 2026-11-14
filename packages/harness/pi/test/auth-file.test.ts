/**
 * The auth file's shape is kept and its values are dropped, so a credential
 * never becomes a string or object operad holds.
 */

import { describe, expect, test } from "bun:test";
import { redactJsonValues } from "../src/auth-file.ts";

function chunksOf(text: string, size: number): readonly Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += size) {
    chunks.push(bytes.subarray(at, at + size));
  }
  return chunks;
}

describe("reading an auth file's shape", () => {
  test("keeps keys and structure, and never keeps a value string", () => {
    const secret = 'sk-live-"secret",{}';
    const text = JSON.stringify({ anthropic: { apiKey: secret }, openai: "another-secret" });
    for (const size of [1, 2, 3, 7, text.length]) {
      const redacted = redactJsonValues(chunksOf(text, size));
      expect(redacted).toBeDefined();
      expect(redacted).not.toContain("sk-live");
      expect(redacted).not.toContain("another-secret");
      expect(JSON.parse(redacted ?? "")).toEqual({
        anthropic: { apiKey: "" },
        openai: "",
      });
    }
  });

  test("is undefined for text that is not JSON", () => {
    for (const text of [
      "not json",
      '{"a":"\\q"}',
      '{"a":1,}',
      '{"a":',
      '{"a":01}',
      '{"a":"line\nbreak"}',
      '{"a":[] "b":1}',
    ]) {
      expect(redactJsonValues(chunksOf(text, 1))).toBeUndefined();
    }
  });
});
