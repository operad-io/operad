import { describe, expect, test } from "bun:test";
import { MAX_LINE_CHARS, MAX_SKIPPED_LINE_CHARS, runAgent, skippedLineRecord } from "../src/index.ts";

/** A child that prints `script`'s output on stdout and exits. */
function run(script: string) {
  const lines: string[] = [];
  const skipped: number[] = [];
  const outcome = runAgent({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    wallMs: 60_000,
    stallMs: 60_000,
    signal: new AbortController().signal,
    onLine: (line) => {
      lines.push(line);
    },
    onSkipped: (chars) => {
      skipped.push(chars);
    },
  });
  return { outcome, lines, skipped };
}

describe("an over-long output line", () => {
  test("is dropped, reported with its length, and the lines around it are read", async () => {
    const big = MAX_LINE_CHARS + 1000;
    const { outcome, lines, skipped } = run(
      `process.stdout.write('{"a":1}\\n'); let left = ${big}; while (left > 0) { const n = Math.min(left, 1048576); process.stdout.write('A'.repeat(n)); left -= n; await new Promise((r) => setTimeout(r, 5)); } process.stdout.write('\\n{"b":2}\\n')`,
    );
    const result = await outcome;
    expect(result.lineTooLong).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(skipped).toEqual([big]);
  });

  test("that ends the stream without a newline is dropped too", async () => {
    const big = MAX_LINE_CHARS + 5;
    const { outcome, lines, skipped } = run(`process.stdout.write('ok\\n' + 'B'.repeat(${big}))`);
    const result = await outcome;
    expect(result.lineTooLong).toBe(false);
    expect(lines).toEqual(["ok"]);
    expect(skipped).toEqual([big]);
  });

  test("a line of exactly the limit is kept", async () => {
    const { outcome, lines, skipped } = run(`process.stdout.write('C'.repeat(${MAX_LINE_CHARS}) + '\\n')`);
    await outcome;
    expect(lines.map((line) => line.length)).toEqual([MAX_LINE_CHARS]);
    expect(skipped).toEqual([]);
  });

  test("that never ends stops the run as a line too long", async () => {
    const { outcome } = run(
      `const chunk = Buffer.alloc(1024 * 1024, 120); for (;;) { if (!process.stdout.write(chunk)) await new Promise((r) => process.stdout.once("drain", r)); }`,
    );
    const result = await outcome;
    expect(result.lineTooLong).toBe(true);
    expect(MAX_SKIPPED_LINE_CHARS).toBeGreaterThan(MAX_LINE_CHARS);
  });

  test("the log line for a dropped line says its length", () => {
    expect(JSON.parse(skippedLineRecord(9_000_000))).toMatchObject({ type: "line_skipped", chars: 9_000_000 });
  });
});
