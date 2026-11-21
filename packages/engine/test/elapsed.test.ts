import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatElapsed } from "../src/index.ts";

interface Sample {
  readonly ms: number;
  readonly text: string;
}

const samples = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "elapsed.json"), "utf8"),
) as readonly Sample[];

describe("formatElapsed", () => {
  test("matches the shared sample table", () => {
    for (const sample of samples) {
      expect(formatElapsed(sample.ms)).toBe(sample.text);
    }
  });

  test("a negative or unreadable time is under one second", () => {
    expect(formatElapsed(-1)).toBe("<1s");
    expect(formatElapsed(Number.NaN)).toBe("<1s");
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe("<1s");
  });
});
