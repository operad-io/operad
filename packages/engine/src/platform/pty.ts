/**
 * A command on a pseudo terminal, from Bun's own `terminal` spawn option; there
 * is no native module. POSIX only.
 *
 * Bun starts the child as the leader of a new session, so it also leads a
 * process group of its own, and the terminal is its controlling terminal. Its
 * three stdio entries are that terminal: there is no fourth entry.
 *
 * `runLine`'s sentinel cannot lead this group, since it reports on a pipe of
 * its own and everything here is the one terminal. The group id stays reserved
 * as long as the group has a member, so the group is signaled only while it has
 * one, and it is stopped as soon as the leader exits. A process that moved to
 * another group (a job of an interactive shell) is not part of that stop;
 * `hangUp` stops those too, also after the leader exited, by the marker each
 * process inherits in its environment.
 */

import { randomUUID } from "node:crypto";

import {
  createGroupStop,
  DRAIN_GRACE_MS,
  KILL_GRACE_MS,
  killProcessGroup,
  systemClock,
  type Clock,
  type Exit,
} from "./process-group.ts";
import { markedRows, mergeRows, processTree, PTY_MARKER_ENV, signalRows } from "./process-tree.ts";
import { markerEnv, readProcessTable, trackRoot, type ProcessTable } from "./step-reap.ts";

export interface PtyOptions {
  /** The program and its arguments; no shell reads them. */
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  /** Added over this process's environment. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly cols: number;
  readonly rows: number;
  /** Receives the output bytes as they come. */
  readonly onData: (bytes: Uint8Array) => void;
  readonly clock?: Clock | undefined;
  /** Replaces the process table in a test. */
  readonly table?: ProcessTable | undefined;
}

export interface Pty {
  /** The child's pid, which is also its process group id. */
  readonly pid: number;
  /**
   * Settles once the child exited, what was left of its group was stopped and
   * the output was delivered. A child that a signal ended has the code 128 plus
   * the signal number, and the signal's name.
   */
  readonly exited: Promise<Exit>;
  /** Writes input. Does nothing once the terminal is closed. */
  write(data: string | Uint8Array): void;
  /** Sets the size. Does nothing once the terminal is closed. */
  resize(cols: number, rows: number): void;
  /** Stops the whole process group: SIGTERM, then SIGKILL after the grace. */
  kill(): Promise<void>;
  /**
   * Closes the terminal on everything the child started, whatever group it
   * moved to: SIGHUP to each, the group stop of `kill`, and after one more
   * grace SIGKILL to what is left. It works after the child exited too. When it
   * rejects, because the processes could not be read, the group was still
   * stopped and the next call tries again.
   */
  hangUp(): Promise<void>;
  /** The value every process of this terminal inherits as `OPERAD_PTY`. */
  readonly marker: string;
  /** Whether a process this terminal started still runs. */
  alive(): Promise<boolean>;
}

/** The part of `Bun.Terminal` used here; the pinned Bun types predate it. */
interface TerminalDevice {
  readonly closed: boolean;
  write(data: string | Uint8Array): number;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface TerminalSpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly terminal: {
    readonly cols: number;
    readonly rows: number;
    readonly data: (terminal: TerminalDevice, bytes: Uint8Array) => void;
    /** The terminal reached its end: no more output comes. */
    readonly exit: () => void;
  };
}

interface TerminalProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly signalCode: string | null;
  readonly terminal?: TerminalDevice | undefined;
  kill(signal: NodeJS.Signals): void;
}

interface TerminalRuntime {
  spawn(argv: string[], options: TerminalSpawnOptions): TerminalProcess;
}

/**
 * Starts `argv` on a new pseudo terminal. Throws when the program or the
 * directory does not exist, or when this Bun has no pseudo terminal.
 */
export function spawnPty(options: PtyOptions): Pty {
  const clock = options.clock ?? systemClock;
  let endOutput = (): void => {};
  const outputEnded = new Promise<void>((resolve) => {
    endOutput = resolve;
  });

  const table = options.table ?? readProcessTable;
  const marker = randomUUID();
  const runtime = Bun as unknown as TerminalRuntime;
  const child = runtime.spawn([...options.argv], {
    cwd: options.cwd,
    env: { ...process.env, ...markerEnv(), ...options.env, [PTY_MARKER_ENV]: marker },
    terminal: {
      cols: options.cols,
      rows: options.rows,
      data: (_terminal, bytes) => options.onData(bytes),
      exit: () => endOutput(),
    },
  });
  const device = child.terminal;
  if (device === undefined) {
    // An older Bun ignores the option and starts the child without a terminal.
    child.kill("SIGKILL");
    throw new Error(`Bun ${Bun.version} has no pseudo terminal`);
  }
  trackRoot(child.pid);

  let leaderExited = false;
  const stop = createGroupStop({
    clock,
    killGroup: killProcessGroup,
    pid: () => child.pid,
    // "Gone" means nothing of the group is left to signal, not only the leader.
    sentinelExited: () => leaderExited && !killProcessGroup(child.pid, 0),
    // There is no sentinel whose TERM trap a signal would have to wait for.
    readySeen: () => true,
    ready: Promise.resolve(),
  });

  const exited = (async (): Promise<Exit> => {
    const code = await child.exited;
    leaderExited = true;
    await stop();
    // A process that left the group can hold the terminal open; do not wait on it.
    let drainTimer: unknown;
    const drainLimit = new Promise<void>((resolve) => {
      drainTimer = clock.setTimeout(resolve, DRAIN_GRACE_MS);
    });
    await Promise.race([outputEnded, drainLimit]);
    clock.clearTimeout(drainTimer);
    device.close();
    return { code, signal: child.signalCode };
  })();

  /** What the terminal started that still runs. */
  const running = async () => {
    // Read before any signal: a child whose parent ended cannot be found.
    const rows = await table();
    // A leader that was reaped may have given its pid to another process.
    const below = leaderExited ? [] : processTree(rows, child.pid);
    return mergeRows(below, await markedRows(rows, marker));
  };

  const hangUp = async (): Promise<void> => {
    let found: Awaited<ReturnType<typeof running>>;
    try {
      found = await running();
    } catch (error) {
      // The group needs no table.
      await stop();
      throw error;
    }
    signalRows(found, "SIGHUP");
    await stop();
    const survivors = async () => {
      const live = new Set((await table()).map((row) => `${row.pid}@${row.startSec}`));
      return found.filter((row) => live.has(`${row.pid}@${row.startSec}`));
    };
    if ((await survivors()).length === 0) return;
    await clock.sleep(KILL_GRACE_MS);
    signalRows(await survivors(), "SIGKILL");
  };

  let hangingUp: Promise<void> | undefined;

  return {
    pid: child.pid,
    exited,
    write: (data) => {
      if (!device.closed) device.write(data);
    },
    resize: (cols, rows) => {
      if (!device.closed) device.resize(cols, rows);
    },
    kill: stop,
    hangUp: () =>
      (hangingUp ??= hangUp().catch((error: unknown) => {
        hangingUp = undefined;
        throw error;
      })),
    marker,
    alive: async () => (await running()).length > 0,
  };
}
