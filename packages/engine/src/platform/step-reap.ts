/**
 * What a step leaves behind. Every process a step starts carries an
 * environment marker naming the run and the step; children inherit it whatever
 * process group or session they move to. When the step ends, the sweep here
 * finds the live processes of the same user that still carry the marker and
 * stops them the way a group stop does: TERM, a bounded wait, KILL. The same
 * sweep runs at serve start for markers of runs that are no longer active.
 *
 * A process that removes the variable from its own environment is not found.
 * Nothing here runs in the kernel's own process.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import type { PluginLogger } from "../plugin/types.ts";
import { KILL_GRACE_MS, systemClock, type Clock } from "./process-group.ts";

/** The variable that names the run and the step: `<run id>:<step>`. */
export const MARKER_ENV = "OPERAD_RUN";

/** The variable that names the operad home, so two homes never meet. */
export const MARKER_HOME_ENV = "OPERAD_RUN_HOME";

/** The longest a command is shown in a log line. */
export const COMMAND_WIDTH = 120;

/** Who a step is: the run it belongs to, its name, and the home it runs in. */
export interface StepMarker {
  readonly runId: string;
  readonly step: string;
  readonly home: string;
}

const current = new AsyncLocalStorage<StepMarker>();

/** Runs `body` so every process it starts through the platform is marked. */
export function withStepMarker<T>(marker: StepMarker, body: () => T): T {
  return current.run(marker, body);
}

/** The marker of the step that is running now, if any. */
export function currentStepMarker(): StepMarker | undefined {
  return current.getStore();
}

function token(text: string): string {
  return text.replace(/\s+/g, "_");
}

/** A short stable name for a home path; it never contains a space. */
export function homeToken(home: string): string {
  return createHash("sha256").update(home).digest("hex").slice(0, 16);
}

/** The value of `OPERAD_RUN` for a step. */
export function markerValue(marker: StepMarker): string {
  return `${token(marker.runId)}:${token(marker.step)}`;
}

/** The environment a process of this step gets; empty outside a step. */
export function markerEnv(
  marker: StepMarker | undefined = currentStepMarker(),
): Record<string, string> {
  if (marker === undefined) return {};
  return {
    [MARKER_ENV]: markerValue(marker),
    [MARKER_HOME_ENV]: homeToken(marker.home),
  };
}

/** A live process that carries a marker. */
export interface MarkedProcess {
  readonly pid: number;
  /** The `OPERAD_RUN` value. */
  readonly marker: string;
  /** The `OPERAD_RUN_HOME` value. */
  readonly home: string;
  readonly command: string;
}

/** Lists the user's live processes that carry a marker. */
export type ProcessLister = () => Promise<readonly MarkedProcess[]>;

const MARKER_PATTERN = new RegExp(`(?:^|\\s)${MARKER_ENV}=(\\S+)`);
const HOME_PATTERN = new RegExp(`(?:^|\\s)${MARKER_HOME_ENV}=(\\S+)`);

function run(command: string, args: readonly string[]): Promise<{ pid: number | undefined; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      [...args],
      { maxBuffer: 512 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => resolve({ pid: child.pid, out: error === null ? stdout : "" }),
    );
  });
}

/** macOS and the BSDs: `ps -E` shows the environment of the user's own processes. */
async function listWithPs(): Promise<readonly MarkedProcess[]> {
  const uid = String(process.getuid?.() ?? "");
  const who = uid === "" ? ["-x"] : ["-U", uid];
  const withEnv = await run("ps", [...who, "-ww", "-E", "-o", "pid=,command="]);
  const found = new Map<number, { marker: string; home: string }>();
  for (const line of withEnv.out.split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (match === null) continue;
    const marker = MARKER_PATTERN.exec(match[2] ?? "");
    if (marker === null) continue;
    const home = HOME_PATTERN.exec(match[2] ?? "");
    found.set(Number(match[1]), { marker: marker[1] ?? "", home: home?.[1] ?? "" });
  }
  if (found.size === 0) return [];
  const plain = await run("ps", [...who, "-ww", "-o", "pid=,command="]);
  const commands = new Map<number, string>();
  for (const line of plain.out.split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (match !== null) commands.set(Number(match[1]), match[2] ?? "");
  }
  const own = new Set([process.pid, withEnv.pid, plain.pid]);
  const processes: MarkedProcess[] = [];
  for (const [pid, value] of found) {
    if (own.has(pid)) continue;
    const command = commands.get(pid);
    // Gone between the two listings, or the listing's own helper.
    if (command === undefined) continue;
    processes.push({ pid, ...value, command });
  }
  return processes;
}

/** Linux: `/proc/<pid>/environ` of the user's own processes. */
async function listWithProc(): Promise<readonly MarkedProcess[]> {
  const processes: MarkedProcess[] = [];
  let names: string[];
  try {
    names = await readdir("/proc");
  } catch {
    return [];
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    let environ: string;
    try {
      environ = await readFile(`/proc/${name}/environ`, "utf8");
    } catch {
      continue; // another user's process, or one that just ended
    }
    let marker: string | undefined;
    let home = "";
    for (const entry of environ.split("\0")) {
      if (entry.startsWith(`${MARKER_ENV}=`)) marker = entry.slice(MARKER_ENV.length + 1);
      else if (entry.startsWith(`${MARKER_HOME_ENV}=`)) home = entry.slice(MARKER_HOME_ENV.length + 1);
    }
    if (marker === undefined) continue;
    let command = "";
    try {
      command = (await readFile(`/proc/${name}/cmdline`, "utf8")).split("\0").join(" ").trim();
    } catch {
      continue;
    }
    processes.push({ pid, marker, home, command });
  }
  return processes;
}

/** The lister for this system. */
export const listMarkedProcesses: ProcessLister = () =>
  existsSync("/proc/self/environ") ? listWithProc() : listWithPs();

/** Sends one signal to one process. False when it could not. */
function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** One live process of the user, from the process table. */
export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** When it started; with the pid it names one process for good. */
  readonly start: string;
  readonly command: string;
}

/** Reads the user's process table. */
export type ProcessTable = () => Promise<readonly ProcessRow[]>;

const ROW_PATTERN =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\S+\s+\S+\s+[\d:]+\s+\d{4})\s+(.*)$/;

/** The table of this user's processes, by `ps`; it works the same on macOS and Linux. */
export const readProcessTable: ProcessTable = async () => {
  const uid = String(process.getuid?.() ?? "");
  const who = uid === "" ? ["-x"] : ["-U", uid];
  const listing = await run("ps", [...who, "-ww", "-o", "pid=,ppid=,pgid=,lstart=,command="]);
  const rows: ProcessRow[] = [];
  for (const line of listing.out.split("\n")) {
    const match = ROW_PATTERN.exec(line);
    if (match === null) continue;
    if (Number(match[1]) === listing.pid) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      start: (match[4] ?? "").replace(/\s+/g, " "),
      command: match[5] ?? "",
    });
  }
  return rows;
};

function identity(row: ProcessRow): string {
  return `${row.pid}@${row.start}`;
}

/** The pids of this process and of everything above it: never swept. */
function protectedPids(rows: readonly ProcessRow[]): Set<number> {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const kept = new Set<number>([process.pid, process.ppid]);
  let at = byPid.get(process.pid)?.ppid;
  while (at !== undefined && at > 1 && !kept.has(at)) {
    kept.add(at);
    at = byPid.get(at)?.ppid;
  }
  return kept;
}

/**
 * Follows the processes a step started, by the process table instead of the
 * environment. macOS withholds the environment of Apple's own binaries
 * (`/bin/sh`, `/bin/bash`, `/bin/zsh`), so a shell loop a command left in the
 * background carries the marker without showing it. The table still names it
 * while its parent lives, and the group it belongs to afterwards: a process
 * that was seen below the step's root stays on the list when its parent ends
 * and it moves to init, and so does every later member of its process group.
 */
export class StepTracker {
  private readonly roots = new Set<number>();
  private readonly seen = new Map<string, ProcessRow>();
  private readonly groups = new Set<number>();
  private timer: unknown;
  private stopped = false;
  private polling: Promise<void> = Promise.resolve();

  /** A process the step started itself: the sentinel that leads its group. */
  addRoot(pid: number): void {
    this.roots.add(pid);
  }

  has(row: ProcessRow): boolean {
    return this.seen.has(identity(row)) || (row.pgid > 1 && this.groups.has(row.pgid));
  }

  /** Adds what the table shows below the roots, and below what is already followed. */
  observe(rows: readonly ProcessRow[]): void {
    const own = rows.find((row) => row.pid === process.pid)?.pgid;
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of rows) {
        if (this.seen.has(identity(row))) continue;
        const parent = rows.find((one) => one.pid === row.ppid);
        const below =
          this.roots.has(row.pid) ||
          (parent !== undefined && this.seen.has(identity(parent))) ||
          (row.pgid > 1 && row.pgid !== own && this.groups.has(row.pgid));
        if (!below || row.pid === process.pid) continue;
        this.seen.set(identity(row), row);
        if (row.pgid > 1 && row.pgid !== own) this.groups.add(row.pgid);
        grew = true;
      }
    }
  }

  /** Looks at the table once; calls queue, so two looks never overlap. */
  poll(table: ProcessTable = readProcessTable): Promise<void> {
    this.polling = this.polling.then(async () => {
      this.observe(await table());
    });
    return this.polling;
  }

  start(clock: Clock = systemClock, table: ProcessTable = readProcessTable): void {
    const again = (): void => {
      if (this.stopped) return;
      this.timer = clock.setTimeout(() => {
        void this.poll(table).then(again, again);
      }, TRACK_MS);
      // A step that never ends must not keep its process alive by being looked at.
      if (typeof this.timer === "object" && this.timer !== null && "unref" in this.timer) {
        (this.timer as { unref(): void }).unref();
      }
    };
    void this.poll(table);
    again();
  }

  stop(clock: Clock = systemClock): void {
    this.stopped = true;
    if (this.timer !== undefined) clock.clearTimeout(this.timer);
  }
}

/** How often a running step's processes are looked at. */
export const TRACK_MS = 200;

const trackers = new Map<string, StepTracker>();

function keyOf(marker: StepMarker): string {
  return `${homeToken(marker.home)}/${markerValue(marker)}`;
}

/**
 * Tells the platform that the running step started a process of its own (the
 * sentinel of a command or of a harness), so its descendants are followed.
 */
export function trackRoot(pid: number | undefined): void {
  const marker = currentStepMarker();
  if (marker === undefined || pid === undefined) return;
  const tracker = trackers.get(keyOf(marker));
  if (tracker === undefined) return;
  tracker.addRoot(pid);
  void tracker.poll();
}

/** Looks at the table now for every running step. For a test that must not wait for the timer. */
export async function pollTrackedSteps(table: ProcessTable = readProcessTable): Promise<void> {
  await Promise.all([...trackers.values()].map((tracker) => tracker.poll(table)));
}

export interface ReapOptions {
  /** Which marked processes to stop. */
  readonly select: (found: MarkedProcess) => boolean;
  /** Processes the step's own tracker followed. */
  readonly tracker?: StepTracker | undefined;
  /** Where the line about what was stopped goes. */
  readonly write?: ((text: string) => Promise<unknown>) | undefined;
  /** What the first line says the processes were left behind by. */
  readonly what: string;
  readonly clock?: Clock | undefined;
  readonly list?: ProcessLister | undefined;
  readonly table?: ProcessTable | undefined;
  readonly graceMs?: number | undefined;
}

/** The part of a stopped process the logs show. */
export interface Reaped {
  readonly pid: number;
  readonly command: string;
}

/** `pid: command`, the command cut to `COMMAND_WIDTH` characters. */
export function describeProcess(found: Reaped): string {
  const command = found.command.replace(/\s+/g, " ");
  const cut =
    command.length > COMMAND_WIDTH ? `${command.slice(0, COMMAND_WIDTH - 1)}…` : command;
  return `${found.pid}: ${cut}`;
}

/** The most rounds of looking and stopping; a parent that starts more is stopped first. */
const ROUNDS = 3;

/**
 * What to stop now: the marked processes `select` picks, the processes the
 * tracker followed that still live, and the parents of the marked ones. A
 * marked process that is a child of a shell whose own environment the system
 * withholds is the shell's work: the shell goes first, or it starts the next
 * one. This process and everything above it are never picked.
 */
async function collect(options: ReapOptions): Promise<readonly ProcessRow[]> {
  const rows = await (options.table ?? readProcessTable)();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const never = protectedPids(rows);
  const picked = new Map<string, ProcessRow>();
  const add = (row: ProcessRow | undefined): row is ProcessRow => {
    if (row === undefined || never.has(row.pid) || row.pid <= 1) return false;
    picked.set(identity(row), row);
    return true;
  };
  for (const one of (await (options.list ?? listMarkedProcesses)()).filter(options.select)) {
    let row = byPid.get(one.pid);
    if (!add(row)) continue;
    // Climb to the parents: the first one that is not ours to stop ends it.
    while (row !== undefined && row.ppid > 1) {
      row = byPid.get(row.ppid);
      if (row === undefined || picked.has(identity(row)) || !add(row)) break;
    }
  }
  if (options.tracker !== undefined) {
    for (const row of rows) if (options.tracker.has(row)) add(row);
  }
  return [...picked.values()];
}

/**
 * Stops what a step left running: TERM, a bounded wait, then KILL for what
 * lives on, named by pid and start time so a pid that was reused meanwhile is
 * not signaled. A shell loop can start something new, so it looks again up to
 * `ROUNDS` times. Writes how many and which commands, one line each. Returns
 * what it found.
 */
export async function reapMarked(options: ReapOptions): Promise<readonly Reaped[]> {
  const clock = options.clock ?? systemClock;
  const grace = options.graceMs ?? KILL_GRACE_MS;
  const all: ProcessRow[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const found = await collect(options);
    if (found.length === 0) break;
    all.push(...found);
    for (const one of found) signalProcess(one.pid, "SIGTERM");
    const names = new Set(found.map(identity));
    let waited = 0;
    let left = found;
    while (waited < grace && left.length > 0) {
      const step = Math.min(50, grace - waited);
      await clock.sleep(step);
      waited += step;
      left = (await (options.table ?? readProcessTable)()).filter((row) => names.has(identity(row)));
    }
    for (const one of left) signalProcess(one.pid, "SIGKILL");
  }
  if (all.length > 0 && options.write !== undefined) {
    const noun = all.length === 1 ? "process" : "processes";
    const lines = [
      `${options.what}: stopping ${all.length} ${noun} it left running`,
      ...all.map((one) => `  ${describeProcess(one)}`),
    ];
    try {
      await options.write(lines.join("\n"));
    } catch {
      // A log that cannot be written must not keep the processes alive.
    }
  }
  return all;
}

/** The step markers that are running in this process, by marker value and home. */
const running = new Map<string, number>();

/**
 * Notes that a step began; the returned function notes that it ended and says
 * whether it was the last one with this marker. Two steps of one run and name
 * at once share a marker, so only the last to end may sweep.
 */
export function enterStep(marker: StepMarker): () => boolean {
  const key = keyOf(marker);
  running.set(key, (running.get(key) ?? 0) + 1);
  if (!trackers.has(key)) {
    const tracker = new StepTracker();
    trackers.set(key, tracker);
    tracker.start();
  }
  return () => {
    const count = (running.get(key) ?? 1) - 1;
    if (count <= 0) {
      running.delete(key);
      return true;
    }
    running.set(key, count);
    return false;
  };
}

/** Stops what a step left running, and says so in the step's log. */
export async function reapStep(
  marker: StepMarker,
  logger: PluginLogger | undefined,
  options: {
    readonly clock?: Clock | undefined;
    readonly list?: ProcessLister | undefined;
    readonly table?: ProcessTable | undefined;
  } = {},
): Promise<readonly Reaped[]> {
  const value = markerValue(marker);
  const home = homeToken(marker.home);
  const key = keyOf(marker);
  const tracker = trackers.get(key);
  tracker?.stop(options.clock);
  trackers.delete(key);
  if (tracker !== undefined) await tracker.poll(options.table);
  return reapMarked({
    select: (one) => one.marker === value && one.home === home,
    tracker,
    what: `step ${marker.step}`,
    write: logger === undefined ? undefined : (text) => logger.write(text),
    clock: options.clock,
    list: options.list,
    table: options.table,
  });
}

/**
 * At serve start: stops the processes of this home whose run is not active,
 * which a serve that died left behind. Says so once, as one message.
 */
export async function reapStale(options: {
  readonly home: string;
  readonly activeRunIds: readonly string[];
  readonly log: (message: string) => void;
  readonly clock?: Clock | undefined;
  readonly list?: ProcessLister | undefined;
  readonly table?: ProcessTable | undefined;
}): Promise<readonly Reaped[]> {
  const home = homeToken(options.home);
  const active = options.activeRunIds.map((id) => `${token(id)}:`);
  const lines: string[] = [];
  const found = await reapMarked({
    select: (one) => one.home === home && !active.some((prefix) => one.marker.startsWith(prefix)),
    what: "serve start",
    write: (text) => {
      lines.push(text);
      return Promise.resolve();
    },
    clock: options.clock,
    list: options.list,
    table: options.table,
  });
  if (found.length > 0) {
    options.log(`${lines.join("\n")} (runs that are no longer active)`);
  }
  return found;
}
