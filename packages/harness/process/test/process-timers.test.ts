import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { keptWorkerDirectory, readKeptWorkers, writeKeptWorker } from "@operad-io/engine/platform";
import {
  messageLine,
  trimKept,
  watchRun,
  type KeptRunOptions,
  type StopKind,
  type ToolEvent,
} from "../src/index.ts";
import { cleanupTempRoots, manualClock, tempRoot } from "./support.ts";

function stops(): { readonly seen: StopKind[]; readonly stop: (kind: StopKind) => void } {
  const seen: StopKind[] = [];
  return { seen, stop: (kind) => seen.push(kind) };
}

function toolEvent(line: string): ToolEvent | undefined {
  return line.includes("start") ? "tool-start" : line.includes("end") ? "tool-end" : undefined;
}

describe("watchRun", () => {
  test("the wall timer stops the run once", () => {
    const clock = manualClock();
    const observed = stops();
    const watch = watchRun({
      clock,
      wallMs: 1_000,
      stallMs: 0,
      signal: new AbortController().signal,
      beginStop: observed.stop,
      reply: () => true,
    });
    watch.start();
    clock.fireUpTo(1_000);
    clock.fireUpTo(1_000);
    expect(observed.seen).toEqual(["wall"]);
    watch.end();
  });

  test("an open tool call holds the stall timer until its end line", () => {
    const clock = manualClock();
    const observed = stops();
    const watch = watchRun({
      clock,
      wallMs: 0,
      stallMs: 500,
      signal: new AbortController().signal,
      toolEvent,
      beginStop: observed.stop,
      reply: () => true,
    });
    watch.start();
    watch.line("tool start");
    clock.fireUpTo(500);
    expect(observed.seen).toEqual([]);
    watch.line("tool end");
    clock.fireUpTo(500);
    expect(observed.seen).toEqual(["stall"]);
    watch.end();
  });

  test("the abort signal stops a kept run; end drops the listener", () => {
    const clock = manualClock();
    const observed = stops();
    const controller = new AbortController();
    const watch = watchRun({
      clock,
      wallMs: 0,
      stallMs: 0,
      signal: controller.signal,
      beginStop: observed.stop,
      reply: () => true,
    });
    watch.start();
    controller.abort();
    expect(observed.seen).toEqual(["cancel"]);
    watch.end();
    controller.abort();
    expect(observed.seen).toEqual(["cancel"]);
  });

  test("the inbox writes a message line, begins the run and stops listening at the end", () => {
    const clock = manualClock();
    const observed = stops();
    const replies: string[] = [];
    let handler: ((text: string) => boolean | void) | undefined;
    let begun: number | undefined;
    let stopped = 0;
    const inbox = {
      listen(next: (text: string) => boolean | void) {
        handler = next;
        return () => {
          stopped += 1;
          handler = undefined;
        };
      },
      begin(limitMs: number) {
        begun = limitMs;
      },
    };
    const watch = watchRun({
      clock,
      wallMs: 2_000,
      stallMs: 0,
      signal: new AbortController().signal,
      beginStop: observed.stop,
      inbox,
      reply: (text) => {
        replies.push(text);
        return true;
      },
    });
    watch.listenInbox();
    expect(begun).toBe(2_000);
    expect(handler?.("hello")).toBe(true);
    expect(replies).toEqual([messageLine("hello")]);
    const listening = handler;
    watch.end();
    expect(stopped).toBe(1);
    expect(listening?.("again")).toBe(false);
  });
});

function record(home: string, name: string, token: string, lastUsedAt: number): void {
  const dir = keptWorkerDirectory(home, name);
  writeKeptWorker({
    pid: 2,
    token,
    scope: "chat:C-1",
    key: "key",
    socket: join(dir, `${token}.sock`),
    meta: join(dir, `${token}.json`),
    session: null,
    startedAt: lastUsedAt,
    lastUsedAt,
  });
}

function tokensOf(home: string, name: string): readonly string[] {
  return [...readKeptWorkers(home, name)].sort((left, right) => left.lastUsedAt - right.lastUsedAt).map((entry) => entry.token);
}

describe("trimKept", () => {
  const roots: string[] = [];

  afterAll(async () => {
    await cleanupTempRoots();
    roots.length = 0;
  });

  async function seeded(): Promise<{ readonly home: string; readonly keep: KeptRunOptions }> {
    const home = await tempRoot();
    roots.push(home);
    for (const index of [1, 2, 3]) record(home, "pi", `t${index}`, index);
    return { home, keep: { home, name: "pi", scope: "chat:C-1", key: "key", max: 3 } };
  }

  test("after a reply the cap trims only above it", async () => {
    const { home, keep } = await seeded();
    await trimKept(keep, manualClock(), (count, max) => count > max);
    expect(tokensOf(home, "pi")).toEqual(["t1", "t2", "t3"]);
  });

  test("before a worker starts the cap trims at it, oldest first", async () => {
    const { home, keep } = await seeded();
    await trimKept(keep, manualClock(), (count, max) => count >= max);
    expect(tokensOf(home, "pi")).toEqual(["t2", "t3"]);
  });
});
