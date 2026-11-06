import { existsSync, watch, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Clock } from "../src/process.ts";

const roots: string[] = [];

/** A scratch directory under `.radian/`, removed by `cleanupTempRoots`. */
export async function tempRoot(): Promise<string> {
  const base = join(process.cwd(), ".radian", "tmp");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "harness-radian-test-"));
  roots.push(root);
  return root;
}

export async function cleanupTempRoots(): Promise<void> {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
}

/** Resolves when the file exists, without asking repeatedly: watches the directory. */
export function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(path), () => {
      if (!existsSync(path)) return;
      watcher.close();
      resolve();
    });
    watcher.on("error", (error) => {
      watcher.close();
      reject(error);
    });
    if (existsSync(path)) {
      watcher.close();
      resolve();
    }
  });
}

export interface ManualClock extends Clock {
  /** Fires every timeout whose requested delay is at most `maxMs`. */
  fireUpTo(maxMs?: number): number;
  /** How many grace waits were requested. */
  readonly sleeps: number;
  /** How many timers were cancelled, which shows a stall timer was reset. */
  readonly clears: number;
}

interface Timer {
  readonly handler: () => void;
  readonly ms: number;
}

/**
 * A clock a test drives: timeouts run only when the test fires them, and a
 * grace wait returns at once. No test waits for real time.
 */
export function manualClock(): ManualClock {
  const timers = new Set<Timer>();
  let sleeps = 0;
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
      sleeps += 1;
      return Promise.resolve();
    },
    fireUpTo(maxMs = Number.POSITIVE_INFINITY) {
      const due = [...timers].filter((timer) => timer.ms <= maxMs);
      for (const timer of due) timers.delete(timer);
      for (const timer of due) timer.handler();
      return due.length;
    },
    get sleeps() {
      return sleeps;
    },
    get clears() {
      return clears;
    },
  };
}

/** The fake radian, written as an executable on PATH for one test. */
export const FAKE_RADIAN = String.raw`#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const mode = process.env.FAKE_RADIAN_MODE ?? "done";
const recordPath = process.env.FAKE_RADIAN_RECORD;
const marker = process.env.FAKE_RADIAN_MARKER;
const calls = process.env.FAKE_RADIAN_CALLS;

function after(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

let prompt = after("-p") ?? "";
if (prompt === "-") prompt = await Bun.stdin.text();

if (calls) appendFileSync(calls, String(process.pid) + "\n");
if (recordPath) {
  writeFileSync(
    recordPath,
    JSON.stringify({
      argv,
      cwd: process.cwd(),
      workspace: after("--workspace"),
      prompt,
      promptBytes: Buffer.byteLength(prompt, "utf8"),
    }),
  );
}

function result(extra = {}) {
  return {
    type: "Result",
    session_id: "fake-session",
    outcome: "completed",
    exit_code: 0,
    stop_reason: "completed",
    turns: 1,
    usage: { input: 11, output: 7 },
    cost: { micros: 1234, incomplete: false, estimated: false },
    run_turns: 1,
    run_usage: { input: 11, output: 7 },
    run_cost: null,
    text: "fake final message",
    ...extra,
  };
}

function line(value) {
  console.log(JSON.stringify(value));
}

if (mode === "done") {
  line({ type: "journal", event: "TurnStarted" });
  line(result());
  process.exit(0);
}

if (mode === "no-cost") {
  line(result({ cost: null }));
  process.exit(0);
}

if (mode === "exit1") {
  line(result({ outcome: "failed", exit_code: 1, stop_reason: "failed" }));
  process.exit(1);
}

if (mode === "no-result") {
  line({ type: "journal", event: "TurnStarted" });
  process.exit(0);
}

if (mode === "stall") {
  line({ type: "journal", event: "TurnStarted" });
  if (marker) writeFileSync(marker, String(process.pid));
  await new Promise(() => {});
}

if (mode === "wall") {
  if (marker) writeFileSync(marker, String(process.pid));
  await new Promise(() => {});
}

if (mode === "cancel") {
  const child = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
  if (marker) writeFileSync(marker, JSON.stringify({ pid: process.pid, child: child.pid }));
  await child.exited;
  await new Promise(() => {});
}
`;

/** Writes the fake radian and returns its directory. */
export async function fakeRadian(root: string): Promise<string> {
  const directory = join(root, "bin");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "radian");
  await writeFile(path, FAKE_RADIAN);
  await chmod(path, 0o755);
  return directory;
}

/** Writes a one-line command, for the environment of a child process. */
export function writeText(path: string, text: string): void {
  writeFileSync(path, text);
}
