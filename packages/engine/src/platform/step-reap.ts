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
import { createProcessWatch, type ProcessWatch } from "./process-watch.ts";
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

const MARKER_PATTERN = new RegExp(`(?:^|\\s)${MARKER_ENV}=(\\S+)`, "g");
const HOME_PATTERN = new RegExp(`(?:^|\\s)${MARKER_HOME_ENV}=(\\S+)`, "g");

/**
 * The last value of a variable in a `ps -E` command column. The environment
 * follows the arguments, so the last match is the real one: an argument that
 * spells `OPERAD_RUN=` cannot override it.
 */
function lastValue(pattern: RegExp, text: string): string | undefined {
  let value: string | undefined;
  for (const match of text.matchAll(pattern)) value = match[1];
  return value;
}

/** The marker and home a `ps -E` command column carries, or undefined without a marker. */
export function parseEnvColumn(
  text: string,
): { readonly marker: string; readonly home: string } | undefined {
  const marker = lastValue(MARKER_PATTERN, text);
  if (marker === undefined) return undefined;
  return { marker, home: lastValue(HOME_PATTERN, text) ?? "" };
}

function run(command: string, args: readonly string[]): Promise<{ pid: number | undefined; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      [...args],
      {
        maxBuffer: 512 * 1024 * 1024,
        encoding: "utf8",
        env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      },
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
    const carried = parseEnvColumn(match[2] ?? "");
    if (carried === undefined) continue;
    found.set(Number(match[1]), carried);
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
  /** When it started, in whole seconds; with the pid it names one process. */
  readonly startSec: number;
  readonly command: string;
}

/** Reads the user's process table. */
export type ProcessTable = () => Promise<readonly ProcessRow[]>;

const ROW_PATTERN =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\S+\s+\S+\s+[\d:]+\s+\d{4})\s+(.*)$/;

/** Seconds since the epoch of a `ps` start time (`Mon  9 Nov 00:26:59 2026` or `Mon Nov  9 00:26:59 2026`). */
export function parseStart(text: string): number {
  const [, first = "", second = "", time = "", year = ""] = text.trim().split(/\s+/);
  const numeric = /^\d+$/.test(first);
  const day = numeric ? first : second;
  const month = numeric ? second : first;
  const [hours = 0, minutes = 0, seconds = 0] = time.split(":").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // `ps` is asked for UTC (see `run`), so the time is read as UTC, whatever zone this process has.
  return Math.floor(Date.UTC(Number(year), months.indexOf(month), Number(day), hours, minutes, seconds) / 1000);
}

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
      startSec: parseStart(match[4] ?? ""),
      command: match[5] ?? "",
    });
  }
  return rows;
};

function identity(row: { readonly pid: number; readonly startSec: number }): string {
  return `${row.pid}@${row.startSec}`;
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

/** A process that leads its own process group, seen while it lived. */
interface Leader {
  readonly startSec: number;
  /** When it was seen to be gone, in seconds; undefined while it lives. */
  goneSec: number | undefined;
}

/**
 * Follows the processes a step started, by the process table instead of the
 * environment. macOS withholds the environment of Apple's own binaries
 * (`/bin/sh`, `/bin/bash`, `/bin/zsh`), so a shell loop a command left in the
 * background carries the marker without showing it. It is seen while it has a
 * parent: a process seen below the step stays on the list when its parent ends
 * and it moves to init. A command's shell leads a process group of its own, and
 * what it left behind keeps that group id, so a later member of the group is
 * followed too, as long as it started while the leader lived: a process that
 * got the leader's pid after the leader was gone started later and is not
 * ours.
 *
 * On macOS a `ProcessWatch` feeds it within milliseconds of each fork, which
 * is what catches a shell that ends right after it started its loops.
 */
export class StepTracker {
  private readonly roots = new Set<number>();
  private readonly seen = new Map<string, ProcessRow>();
  private readonly leaders = new Map<number, Leader>();
  private timer: unknown;
  private stopped = false;
  private polling: Promise<void> = Promise.resolve();
  private readonly watcher: ProcessWatch | undefined;
  private readonly now: () => number;
  private readonly uid: number | undefined;

  constructor(options: { readonly watcher?: ProcessWatch | undefined; readonly now?: (() => number) | undefined } = {}) {
    this.watcher = options.watcher;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.uid = process.getuid?.();
  }

  /** A process the step started itself: the sentinel that leads its group. */
  addRoot(pid: number): void {
    this.roots.add(pid);
    this.follow(pid);
  }

  /** Whether a live process is one the step started. */
  has(row: ProcessRow): boolean {
    if (this.seen.has(identity(row))) return true;
    const leader = this.leaders.get(row.pgid);
    if (leader === undefined || row.pgid <= 1) return false;
    return (
      row.startSec >= leader.startSec &&
      (leader.goneSec === undefined || row.startSec <= leader.goneSec)
    );
  }

  private remember(row: { readonly pid: number; readonly pgid: number; readonly startSec: number; readonly command?: string }): boolean {
    const id = identity(row);
    if (this.seen.has(id)) return false;
    this.seen.set(id, { command: "", ppid: 0, ...row });
    if (row.pid === row.pgid && !this.leaders.has(row.pgid)) {
      this.leaders.set(row.pgid, { startSec: row.startSec, goneSec: undefined });
    }
    return true;
  }

  /** Looks at one process and below it, now, through the watch. */
  private follow(pid: number): void {
    const watcher = this.watcher;
    if (watcher === undefined) return;
    if (!watcher.watch(pid)) return;
    const own = watcher.info(pid);
    if (own !== undefined && own.uid === this.uid) this.remember(own);
    // Watched first, listed after: a fork before the watch shows in the list,
    // a fork after it shows as an event.
    for (const kid of watcher.children(pid)) {
      const info = watcher.info(kid);
      if (info === undefined || info.uid !== this.uid) continue;
      if (this.remember(info)) this.follow(kid);
    }
  }

  /** Reads what the watch has kept: follows the children of what forked. */
  tick(): void {
    const watcher = this.watcher;
    if (watcher === undefined) return;
    const { forked, exited } = watcher.drain();
    for (const pid of forked) this.follow(pid);
    for (const pid of exited) {
      const leader = this.leaders.get(pid);
      if (leader !== undefined && leader.goneSec === undefined) leader.goneSec = this.now();
    }
  }

  /** Adds what the table shows below the roots, and below what is already followed. */
  observe(rows: readonly ProcessRow[]): void {
    const present = new Set(rows.map(identity));
    for (const [pgid, leader] of this.leaders) {
      const alive = present.has(`${pgid}@${leader.startSec}`);
      if (!alive && leader.goneSec === undefined) leader.goneSec = this.now();
    }
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of rows) {
        if (this.seen.has(identity(row)) || row.pid === process.pid) continue;
        const parent = rows.find((one) => one.pid === row.ppid);
        const below =
          this.roots.has(row.pid) || (parent !== undefined && this.seen.has(identity(parent)));
        if (below && this.remember(row)) grew = true;
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
      unref(this.timer);
    };
    if (this.watcher !== undefined) {
      const quick = (): void => {
        if (this.stopped) return;
        this.tick();
        this.quick = clock.setTimeout(quick, WATCH_MS);
        unref(this.quick);
      };
      quick();
    }
    void this.poll(table);
    again();
  }

  private quick: unknown;

  stop(clock: Clock = systemClock): void {
    this.stopped = true;
    if (this.timer !== undefined) clock.clearTimeout(this.timer);
    if (this.quick !== undefined) clock.clearTimeout(this.quick);
  }

  /** Reads the watch a last time and lets it go. */
  finish(): void {
    this.tick();
    this.watcher?.close();
  }
}

/** A step that never ends must not keep its process alive by being looked at. */
function unref(timer: unknown): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref(): void }).unref();
  }
}

/** How often the watch is read: a few milliseconds, since reading it is cheap. */
export const WATCH_MS = 2;

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
 * The longest a sweep may take is this many rounds, each of which lists the
 * table (twice on macOS), signals TERM, polls for one grace and signals KILL.
 */
export const REAP_ROUNDS = ROUNDS;

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
    const tracker = new StepTracker({ watcher: createProcessWatch() });
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
  tracker?.finish();
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
