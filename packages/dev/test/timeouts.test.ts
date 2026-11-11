import { describe, expect, test } from "bun:test";
import { MAX_REVIEW_WAIT_SECS, MAX_REVIEW_WAITS, reviewWaitMs } from "../src/timeouts.ts";

describe("review waits", () => {
  test("double from retrySecs and stop at the cap", () => {
    const minutes = [1, 2, 3, 4, 5, 6, 7, 40].map((n) => reviewWaitMs(120, n) / 60_000);
    expect(minutes).toEqual([2, 4, 8, 16, 30, 30, 30, 30]);
  });

  test("a first wait longer than the cap stays as it is", () => {
    expect(reviewWaitMs(3 * 3600, 1)).toBe(3 * 3600 * 1000);
    expect(reviewWaitMs(3 * 3600, 3)).toBe(3 * 3600 * 1000);
  });

  test("the give-up point is about the time it was (about 90 minutes at the default)", () => {
    let total = 0;
    for (let n = 1; n <= MAX_REVIEW_WAITS; n += 1) total += reviewWaitMs(120, n);
    expect(total).toBe(90 * 60_000);
    expect(MAX_REVIEW_WAIT_SECS).toBe(1800);
  });
});
