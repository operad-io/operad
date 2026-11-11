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
import { existsSync } from "node:fs";

export const DEFAULT_STOP_TIMEOUT_SECS = 30;
const COMMAND_ASKS = 20;
const COMMAND_ASK_WAIT_MS = 50;

export interface ServeStopOptions {
  readonly home: string;
  readonly timeoutSecs: number;
  readonly write: (text: string) => void;
  /** Test hooks. */
  readonly isAlive?: ((pid: number) => boolean) | undefined;
  readonly commandOf?: ((pid: number) => string | undefined) | undefined;
  readonly signal?: ((pid: number) => void) | undefined;
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
  const path = serveLockPath(options.home);
  const isAlive = options.isAlive ?? pidAlive;
  const pid = readLockPid(path);
  if (pid === undefined || !isAlive(pid)) {
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
    if (!isAlive(pid) || !existsSync(path)) {
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
