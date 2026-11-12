/**
 * The stall rule belongs to the process helper, but the event names belong to
 * the harness. A classifier turns pi's `tool_execution_start` /
 * `tool_execution_end` into the two states the helper knows, exactly as
 * radian's `ToolExecutionStarted` / `ToolExecutionSettled` do.
 */

import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent, type Clock } from "../../src/index.ts";

function piToolEvent(line: string): "tool-start" | "tool-end" | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "tool_execution_start") return "tool-start";
  if (record.type === "tool_execution_end") return "tool-end";
  return undefined;
}

interface ManualClock extends Clock {
  /** Fires every timeout whose requested delay is at most `maxMs`. */
  fireUpTo(maxMs?: number): number;
  /** How many timers were cancelled, which shows a stall timer was reset. */
  readonly clears: number;
}

interface Timer {
  readonly handler: () => void;
  readonly ms: number;
}

/** A clock a test drives; no test waits for real time. */
function manualClock(): ManualClock {
  const timers = new Set<Timer>();
  let clears = 0;
  return {
    setTimeout(handler, ms) {
      const timer = { handler, ms };
      timers.add(timer);
      return timer;
    },
    clearTimeout(handle) {
      clears += 1;
      timers.delete(handle as Timer);
    },
    sleep() {
      return Promise.resolve();
    },
    fireUpTo(maxMs = Number.POSITIVE_INFINITY) {
      const due = [...timers].filter((timer) => timer.ms <= maxMs);
      for (const timer of due) timers.delete(timer);
      for (const timer of due) timer.handler();
      return due.length;
    },
    get clears() {
      return clears;
    },
  };
}

test("a pi tool call pauses the stall timer until its end line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "operad-harness-process-"));
  const release = join(directory, "release");
  const script = join(directory, "pi-child.ts");
  await writeFile(
    script,
    [
      "import { existsSync } from \"node:fs\";",
      'const line = (value) => console.log(JSON.stringify(value));',
      'line({ type: "tool_execution_start", toolCallId: "t1" });',
      `const release = ${JSON.stringify(release)};`,
      "while (!existsSync(release)) {",
      "  await new Promise((resolve) => setTimeout(resolve, 5));",
      "}",
      'line({ type: "tool_execution_end", toolCallId: "t1" });',
      "process.exit(0);",
    ].join("\n"),
  );

  try {
    const clock = manualClock();
    let started: () => void = () => {};
    const startedLine = new Promise<void>((resolve) => {
      started = resolve;
    });

    const running = runAgent({
      command: process.execPath,
      args: [script],
      cwd: directory,
      wallMs: 0,
      stallMs: 1_000,
      signal: new AbortController().signal,
      clock,
      toolEvent: piToolEvent,
      onLine(line) {
        if (piToolEvent(line) === "tool-start") started();
      },
    });

    await startedLine;
    // The tool is open: far past the stall limit no timer fires.
    expect(clock.fireUpTo(60_000)).toBe(0);

    await writeFile(release, "go");
    const outcome = await running;
    expect(outcome.exitCode).toBe(0);
    expect(outcome.signal).toBeNull();
    expect(outcome.stall).toBe(false);
    expect(outcome.cancelled).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
