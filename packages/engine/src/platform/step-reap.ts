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

export interface ReapOptions {
  /** Which marked processes to stop. */
  readonly select: (found: MarkedProcess) => boolean;
  /** Where the line about what was stopped goes. */
  readonly write?: ((text: string) => Promise<unknown>) | undefined;
  /** What the first line says the processes were left behind by. */
  readonly what: string;
  readonly clock?: Clock | undefined;
  readonly list?: ProcessLister | undefined;
  readonly graceMs?: number | undefined;
}

/** `pid 12: command`, the command cut to `COMMAND_WIDTH` characters. */
export function describeProcess(found: MarkedProcess): string {
  const command = found.command.replace(/\s+/g, " ");
  const cut =
    command.length > COMMAND_WIDTH ? `${command.slice(0, COMMAND_WIDTH - 1)}…` : command;
  return `${found.pid}: ${cut}`;
}

/**
 * Stops the marked processes `select` picks: TERM, a bounded wait, then KILL
 * for those that are still marked. The listing is taken again before the KILL,
 * so a pid that was reused meanwhile is not signaled. Writes how many and which
 * commands, one line each. Returns what it found first.
 */
export async function reapMarked(options: ReapOptions): Promise<readonly MarkedProcess[]> {
  const list = options.list ?? listMarkedProcesses;
  const clock = options.clock ?? systemClock;
  const found = (await list()).filter(options.select);
  if (found.length === 0) return [];
  if (options.write !== undefined) {
    const noun = found.length === 1 ? "process" : "processes";
    const lines = [
      `${options.what}: stopping ${found.length} ${noun} it left running`,
      ...found.map((one) => `  ${describeProcess(one)}`),
    ];
    try {
      await options.write(lines.join("\n"));
    } catch {
      // A log that cannot be written must not keep the processes alive.
    }
  }
  for (const one of found) signalProcess(one.pid, "SIGTERM");
  // Wait for them to end, up to the grace; a sweep of the list says when.
  const grace = options.graceMs ?? KILL_GRACE_MS;
  let waited = 0;
  let left = found;
  while (waited < grace) {
    const step = Math.min(50, grace - waited);
    await clock.sleep(step);
    waited += step;
    left = (await list()).filter(
      (one) => options.select(one) && found.some((first) => first.pid === one.pid),
    );
    if (left.length === 0) return found;
  }
  for (const one of left) signalProcess(one.pid, "SIGKILL");
  return found;
}

/** The step markers that are running in this process, by marker value and home. */
const running = new Map<string, number>();

/**
 * Notes that a step began; the returned function notes that it ended and says
 * whether it was the last one with this marker. Two steps of one run and name
 * at once share a marker, so only the last to end may sweep.
 */
export function enterStep(marker: StepMarker): () => boolean {
  const key = `${homeToken(marker.home)}/${markerValue(marker)}`;
  running.set(key, (running.get(key) ?? 0) + 1);
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
  options: { readonly clock?: Clock | undefined; readonly list?: ProcessLister | undefined } = {},
): Promise<readonly MarkedProcess[]> {
  const value = markerValue(marker);
  const home = homeToken(marker.home);
  return reapMarked({
    select: (one) => one.marker === value && one.home === home,
    what: `step ${marker.step}`,
    write: logger === undefined ? undefined : (text) => logger.write(text),
    clock: options.clock,
    list: options.list,
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
}): Promise<readonly MarkedProcess[]> {
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
  });
  if (found.length > 0) {
    options.log(`${lines.join("\n")} (runs that are no longer active)`);
  }
  return found;
}
