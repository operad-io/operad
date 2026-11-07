import { describe, expect, test } from "bun:test";
import type { PluginLogger } from "@operad-io/engine";
import { FLUSH_CHARS, JsonlLog } from "../src/jsonl-log.ts";

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
