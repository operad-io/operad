import { describe, expect, test } from "bun:test";
import type { PluginLogger } from "@operad-io/engine";
import { FLUSH_CHARS, FLUSH_MS, JsonlLog } from "../src/jsonl-log.ts";
import { manualClock, type ManualClock } from "./support.ts";

interface BlockingLogger {
  readonly logger: PluginLogger;
  readonly writes: string[];
  release(): void;
}

/** A logger whose writes stay pending until the test releases one. */
function blockingLogger(): BlockingLogger {
  const writes: string[] = [];
  let release: () => void = () => {};
  return {
    writes,
    logger: {
      path: "/log",
      write(text) {
        writes.push(text);
        return new Promise<string>((resolve) => {
          release = () => resolve("/log");
        });
      },
    },
    release: () => release(),
  };
}

describe("jsonl log", () => {
  test("a full buffer returns the write the caller must wait for", async () => {
    const gate = blockingLogger();
    const log = new JsonlLog(gate.logger);

    expect(log.push("small line")).toBeUndefined();
    const pending = log.push("x".repeat(FLUSH_CHARS));
    expect(pending).toBeInstanceOf(Promise);

    let written = false;
    const waiter = pending?.then(() => {
      written = true;
    });
    await Promise.resolve();
    expect(gate.writes).toHaveLength(1);
    expect(gate.writes[0]).toContain("small line\n");
    expect(written).toBe(false);

    gate.release();
    await waiter;
    expect(written).toBe(true);
  });

  test("end writes the tail and waits for it", async () => {
    const gate = blockingLogger();
    const log = new JsonlLog(gate.logger);
    expect(log.push("last line")).toBeUndefined();

    let ended = false;
    const ending = log.end().then(() => {
      ended = true;
    });
    await Promise.resolve();
    expect(gate.writes).toHaveLength(1);
    expect(gate.writes[0]).toBe("last line\n");
    expect(ended).toBe(false);

    gate.release();
    await ending;
    expect(ended).toBe(true);
  });

  test("lines reach the log in order", async () => {
    const writes: string[] = [];
    const log = new JsonlLog({
      path: "/log",
      async write(text) {
        writes.push(text);
        return "/log";
      },
    });

    for (let index = 0; index < 100; index += 1) await log.push(`line ${index}`);
    await log.end();

    const expected = Array.from({ length: 100 }, (_, index) => `line ${index}\n`).join("");
    expect(writes.join("")).toBe(expected);
  });
});

describe("jsonl log flush timing", () => {
  function recording(clock: ManualClock): { readonly log: JsonlLog; readonly writes: string[] } {
    const writes: string[] = [];
    const log = new JsonlLog({ path: "/log", async write(text) { writes.push(text); return "/log"; } }, clock);
    return { log, writes };
  }

  test("a line is written when its 250 ms are up, without more lines", async () => {
    const clock = manualClock();
    const { log, writes } = recording(clock);
    log.push("first");
    // The timer asks for FLUSH_MS and no more.
    expect(clock.fireUpTo(FLUSH_MS - 1)).toBe(0);
    expect(writes).toEqual([]);
    expect(clock.fireUpTo(FLUSH_MS)).toBe(1);
    await log.end();
    expect(writes).toEqual(["first\n"]);
  });

  test("a timer that fires writes the buffer by itself, before end", async () => {
    const clock = manualClock();
    const { log, writes } = recording(clock);
    log.push("a");
    log.push("b");
    // One timer for the buffer: the second line does not start another.
    expect(clock.fireUpTo(FLUSH_MS)).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toEqual(["a\nb\n"]);
    log.push("c");
    expect(clock.fireUpTo(FLUSH_MS)).toBe(1);
    await log.end();
    expect(writes).toEqual(["a\nb\n", "c\n"]);
  });

  test("a full buffer and end cancel the timer", async () => {
    const clock = manualClock();
    const { log, writes } = recording(clock);
    log.push("small");
    await log.push("x".repeat(FLUSH_CHARS));
    expect(clock.fireUpTo()).toBe(0);
    log.push("tail");
    await log.end();
    expect(clock.fireUpTo()).toBe(0);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toBe("tail\n");
  });
});
