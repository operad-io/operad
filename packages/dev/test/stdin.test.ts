import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { readStdinWithin } from "../src/stdin.ts";

describe("a standard-input read with a deadline", () => {
  test("a read that finishes first stops the deadline's wait", async () => {
    let signal: AbortSignal | undefined;
    const read = await readStdinWithin(undefined, {
      stream: Readable.from(["brief\n"]),
      timeoutMs: 1_000,
      clock: () => 0,
      wait: (_ms, stop) => {
        signal = stop;
        return new Promise<void>((resolve) => {
          stop.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });
    expect(read).toEqual({ text: "brief\n", timedOut: false });
    expect(signal?.aborted).toBe(true);
  });
});
