import { readFileSync, writeFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { waitForChange } from "@operad-io/engine/platform";

const roots: string[] = [];
let current: string[] = [];

/** A scratch directory under `.radian/`, removed by `cleanupTempRoots`. */
export async function tempRoot(): Promise<string> {
  const base = join(process.cwd(), ".radian", "tmp");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "radian-test-"));
  roots.push(root);
  current.push(root);
  return root;
}

/** Every scratch directory this test file created, including cleaned ones. */
export function tempRoots(): readonly string[] {
  return [...roots];
}

interface LiveProcess {
  readonly pid: number;
  readonly pgid: number;
  readonly command: string;
}

function liveProcesses(): readonly LiveProcess[] {
  const result = Bun.spawnSync({
    cmd: ["ps", "-axo", "pid=,pgid=,command="],
    stdout: "pipe",
    stderr: "pipe",
  });
  const found: LiveProcess[] = [];
  for (const line of result.stdout.toString().split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    const command = match[3] ?? "";
    if (pid > 0 && command.length > 0) found.push({ pid, pgid, command });
  }
  return found;
}

/** Every live process whose command line names one of `paths`. */
export function processesUnder(paths: readonly string[]): readonly number[] {
  return liveProcesses()
    .filter(
      (process) =>
        process.pid !== globalThis.process.pid &&
        paths.some((path) => process.command.includes(path)),
    )
    .map((process) => process.pid);
}

function signalProcessGroup(process: LiveProcess): void {
  try {
    // Only the sentinel is its own group leader. A process in the test's own
    // group (a directly spawned child) must be signalled by pid, never by
    // `-pgid`: that group is the test runner.
    if (process.pid === process.pgid) globalThis.process.kill(-process.pgid, "SIGKILL");
    else globalThis.process.kill(process.pid, "SIGKILL");
  } catch {
    try {
      globalThis.process.kill(process.pid, "SIGKILL");
    } catch {
      // The process ended between the scan and the signal.
    }
  }
}

/** Resolves once no live process names one of `paths`, or after `limitMs`. */
async function waitForGone(
  paths: readonly string[],
  limitMs = 2000,
): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (processesUnder(paths).length > 0) {
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  }
}

/**
 * Stops every process the current test started under its scratch directory.
 * A test that fails before its own stop runs must not leave the sentinel and
 * its fake radian behind.
 */
export async function stopTestProcesses(): Promise<void> {
  const paths = current;
  current = [];
  if (paths.length === 0) return;
  const matches = liveProcesses().filter((process) =>
    paths.some((path) => process.command.includes(path)),
  );
  for (const process of matches) signalProcessGroup(process);
  await waitForGone(paths);
}

export async function cleanupTempRoots(): Promise<void> {
  await stopTestProcesses();
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

/**
 * Resolves with the JSON a fake worker wrote to `path`, once the file holds it.
 * The file exists, empty, between its creation and its write, so existence is
 * not enough: a read can see "" and `JSON.parse` rejects it. A watch can miss
 * an event, so a look every 100 ms backs it.
 */
export async function waitForJson(path: string): Promise<unknown> {
  for (;;) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // Not there yet, or not written in full.
    }
    await waitForChange(dirname(path), basename(path), 100);
  }
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
    session_id: process.env.FAKE_RADIAN_NEW_SESSION ? "fresh-session" : (after("--resume") ?? "fake-session"),
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

if (mode === "tool-detail") {
  line({ type: "journal", event: "ToolExecutionStarted", toolCallId: "t1", toolName: "Bash", input: { command: "token=supersecret make test" } });
  line({ type: "journal", event: "ToolExecutionSettled", toolCallId: "t1", toolName: "Bash", isError: true, error: "boom\nSECRET OUTPUT" });
  line(result());
  process.exit(0);
}

if (mode === "done") {
  line({ type: "journal", event: "TurnStarted" });
  line(result());
  process.exit(0);
}

if (mode === "incomplete" || mode === "estimated") {
  line(result({ cost: { micros: 900, incomplete: mode === "incomplete", estimated: mode === "estimated" } }));
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

if (mode === "model-error-unavailable" || mode === "model-error-usage-limit") {
  const usage = mode === "model-error-usage-limit";
  line(
    result({
      outcome: "failed",
      exit_code: 1,
      stop_reason: "failed",
      model_error: usage
        ? { kind: "usage_limit", status: null, retry_after_secs: 3600 }
        : { kind: "unavailable", status: 429, retry_after_secs: 30 },
    }),
  );
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
