import { existsSync, watch, writeFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
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
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      // A test that timed out can leave a directory it locked; unlock and retry.
      await unlock(root);
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function unlock(path: string): Promise<void> {
  try {
    await chmod(path, 0o700);
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) await unlock(join(path, entry.name));
    }
  } catch {
    // The path may already be gone, or not be a directory.
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

/** Resolves when `predicate` holds, without waiting out a fixed sleep. */
export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for a condition");
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, stepMs));
  }
}

export interface ManualClock extends Clock {
  /** Fires every timeout whose requested delay is at most `maxMs`. */
  fireUpTo(maxMs?: number): number;
  /** Resolves once `predicate` holds; every timer change rechecks it. */
  when(predicate: () => boolean): Promise<void>;
  /** How many grace waits were requested. */
  readonly sleeps: number;
  /** How many timers were cancelled, which shows a stall timer was reset. */
  readonly clears: number;
}

interface Timer {
  readonly handler: () => void;
  readonly ms: number;
}

interface Waiter {
  readonly predicate: () => boolean;
  readonly resolve: () => void;
}

/**
 * A clock a test drives: timeouts run only when the test fires them, and a
 * grace wait returns at once. No test waits for real time: a test that needs
 * to know a timer exists asks `when` and is woken by a timer change.
 */
export function manualClock(): ManualClock {
  const timers = new Set<Timer>();
  const waiters: Waiter[] = [];
  let sleeps = 0;
  let clears = 0;

  const notify = (): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter === undefined || !waiter.predicate()) continue;
      waiters.splice(index, 1);
      waiter.resolve();
    }
  };

  return {
    setTimeout(handler, ms) {
      const timer = { handler, ms };
      timers.add(timer);
      notify();
      return timer;
    },
    clearTimeout(handle) {
      clears += 1;
      timers.delete(handle as Timer);
      notify();
    },
    sleep() {
      sleeps += 1;
      return Promise.resolve();
    },
    fireUpTo(maxMs = Number.POSITIVE_INFINITY) {
      const due = [...timers].filter((timer) => timer.ms <= maxMs);
      for (const timer of due) timers.delete(timer);
      for (const timer of due) timer.handler();
      notify();
      return due.length;
    },
    when(predicate) {
      if (predicate()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push({ predicate, resolve });
      });
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
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

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

if (mode === "tool-silent") {
  line({ type: "journal", event: "ToolExecutionStarted" });
  if (marker) writeFileSync(marker, String(process.pid));
  const release = process.env.FAKE_RADIAN_RELEASE;
  if (release) {
    while (!existsSync(release)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  line({ type: "journal", event: "ToolExecutionSettled" });
  line(result());
  process.exit(0);
}

if (mode === "tool-wall") {
  line({ type: "journal", event: "ToolExecutionStarted" });
  if (marker) writeFileSync(marker, String(process.pid));
  await new Promise(() => {});
}

if (mode === "lines") {
  const records = [];
  for (let index = 0; index < 4; index += 1) {
    records.push(JSON.stringify({ type: "journal", event: "Line", index }));
  }
  records.push(JSON.stringify(result()));
  await new Promise((resolve) => process.stdout.write(records.join("\n") + "\n", resolve));
  process.exit(0);
}

if (mode === "flood") {
  const chunk = Buffer.alloc(256 * 1024, 120);
  for (;;) {
    if (!process.stdout.write(chunk)) {
      await new Promise((resolve) => process.stdout.once("drain", resolve));
    }
  }
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

/** Writes the fake radian under another name, for a settings override. */
export async function fakeRadianNamed(
  root: string,
  name: string,
): Promise<string> {
  const directory = await fakeRadian(root);
  const path = join(directory, name);
  await writeFile(path, FAKE_RADIAN);
  await chmod(path, 0o755);
  return directory;
}

/** Writes a one-line command, for the environment of a child process. */
export function writeText(path: string, text: string): void {
  writeFileSync(path, text);
}
