/**
 * `operad serve stop`: stops the `serve` that holds this home's `serve.lock`.
 *
 * The lock names a PID, and a PID can be reused after `serve` died without
 * releasing it. So before it signals, the command asks the OS for that
 * process's command line (`ps -p <pid> -o command=`, the same on macOS and
 * Linux) and signals only a process whose command line has `serve` as a word.
 * It sends SIGTERM, the stop `serve` already handles, and never SIGKILL.
 */

import { StateError, pidAlive, readLockPid, serveLockPath } from "@operad-io/engine";
import { stopAllKeptWorkers, writeJsonAtomicSync } from "@operad-io/engine/platform";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_STOP_TIMEOUT_SECS = 30;
const COMMAND_ASKS = 20;
const COMMAND_ASK_WAIT_MS = 50;

function supervisorPath(home: string): string {
  return join(home, "serve-supervisor.json");
}

/**
 * A serve that runs under a supervisor names it in the home: the supervisor
 * outlives each serve it starts and starts the next one after a reload, so
 * `serve stop` must reach it, not only the serve that holds the lock.
 */
export function recordSupervisor(home: string, pid: number = process.ppid): void {
  writeJsonAtomicSync(supervisorPath(home), { pid });
}

function readSupervisor(home: string): number | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(supervisorPath(home), "utf8"));
    const pid =
      typeof raw === "object" && raw !== null ? (raw as { pid?: unknown }).pid : undefined;
    return typeof pid === "number" ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** The parent of a process, or undefined when `ps` cannot say. */
export function parentOf(pid: number): number | undefined {
  const result = Bun.spawnSync({
    cmd: ["ps", "-p", String(pid), "-o", "ppid="],
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return undefined;
  const value = Number(result.stdout.toString().trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export interface ServeStopOptions {
  readonly home: string;
  readonly timeoutSecs: number;
  readonly write: (text: string) => void;
  /** Test hooks. */
  readonly isAlive?: ((pid: number) => boolean) | undefined;
  readonly commandOf?: ((pid: number) => string | undefined) | undefined;
  readonly signal?: ((pid: number) => void) | undefined;
  readonly parentOf?: ((pid: number) => number | undefined) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly clock?: (() => number) | undefined;
}

/** The command line of a process, or undefined when `ps` cannot say. */
export function processCommand(pid: number): string | undefined {
  const result = Bun.spawnSync({
    cmd: ["ps", "-p", String(pid), "-o", "command="],
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return undefined;
  const text = result.stdout.toString().trim();
  return text.length > 0 ? text : undefined;
}

/** True when the command line has `serve` as a word of its own. */
export function isServeCommand(command: string): boolean {
  return /(^|\s)serve(\s|$)/.test(command);
}

/** Parses `--timeout <secs>`: a whole number of at least 1. */
export function parseStopTimeout(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new RangeError(
      `serve stop --timeout needs a whole number of seconds, at least 1, got "${value}"`,
    );
  }
  return Number(value);
}

export async function serveStop(options: ServeStopOptions): Promise<void> {
  // Kept workers are not children of serve: end them here too, even when no
  // serve is left to do it.
  await stopAllKeptWorkers({ home: options.home });
  const path = serveLockPath(options.home);
  const isAlive = options.isAlive ?? pidAlive;
  const lockPid = readLockPid(path);
  const holder = lockPid !== undefined && isAlive(lockPid) ? lockPid : undefined;
  // The supervisor of the serve, when there is one that is really its parent.
  // Between two serves of a reload nothing holds the lock, and the supervisor
  // is the only process that will start the next one.
  let supervisor = readSupervisor(options.home);
  if (supervisor !== undefined && !isAlive(supervisor)) supervisor = undefined;
  // A record whose pid was reused by another process names no supervisor.
  if (supervisor !== undefined) {
    const supervisorCommand = (options.commandOf ?? processCommand)(supervisor);
    if (supervisorCommand !== undefined && !isServeCommand(supervisorCommand)) {
      rmSync(supervisorPath(options.home), { force: true });
      supervisor = undefined;
    }
  }
  if (supervisor !== undefined && holder !== undefined && holder !== supervisor) {
    const parent = (options.parentOf ?? parentOf)(holder);
    if (parent !== undefined && parent !== supervisor) supervisor = undefined;
  }
  const pid = supervisor ?? holder;
  if (pid === undefined) {
    options.write(`no operad serve runs for ${options.home}\n`);
    return;
  }

  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const commandOf = options.commandOf ?? processCommand;
  // `ps` under load can answer nothing for a live process (exit 0 with empty
  // output, seen in T-0108), so "cannot say" is asked again a few times while
  // the process lives. A command line that is not a serve is final.
  let command = commandOf(pid);
  for (let ask = 1; command === undefined && ask < COMMAND_ASKS && isAlive(pid); ask += 1) {
    await sleep(COMMAND_ASK_WAIT_MS);
    command = commandOf(pid);
  }
  if (command === undefined && !isAlive(pid)) {
    options.write(`no operad serve runs for ${options.home}\n`);
    return;
  }
  if (command === undefined) {
    throw new StateError(
      `process ${pid} holds ${path} but ps could not say what it is; nothing was signalled`,
    );
  }
  if (!isServeCommand(command)) {
    throw new StateError(
      `process ${pid} holds ${path} but is not an operad serve; nothing was signalled`,
    );
  }

  (options.signal ?? ((target) => process.kill(target, "SIGTERM")))(pid);
  options.write(`stopping operad serve (pid ${pid})\n`);

  const clock = options.clock ?? (() => Date.now());
  const deadline = clock() + options.timeoutSecs * 1_000;
  for (;;) {
    // The supervisor is gone, and so is every serve it started: the lock
    // names no live process, or the file is gone.
    const current = readLockPid(path);
    const served = current !== undefined && isAlive(current) && existsSync(path);
    const supervised = supervisor !== undefined && isAlive(supervisor);
    if (supervisor === undefined ? !isAlive(pid) || !existsSync(path) : !supervised && !served) {
      if (supervisor !== undefined) rmSync(supervisorPath(options.home), { force: true });
      options.write("stopped\n");
      return;
    }
    if (clock() >= deadline) break;
    await sleep(50);
  }
  throw new StateError(
    `operad serve (pid ${pid}) did not stop within ${options.timeoutSecs} seconds; to force it: kill -9 ${pid}`,
  );
}
