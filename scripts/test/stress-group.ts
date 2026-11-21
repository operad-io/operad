// Runs scripts/stress.sh in a process group of its own and kills the group
// when the test ends, however it ends: normally, by a failure, by a timeout
// that reaches the finally block, or by SIGINT / SIGTERM to the runner.
// SIGKILL of the runner cannot be caught, and the group is not the runner's, so
// the signal does not reach it; stress.sh stops on its own when its parent is
// gone, and its helpers stop when stress.sh is gone.
import { killProcessGroup } from "@operad-io/engine/platform";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

export const root = join(import.meta.dir, "..", "..");
export const script = join(root, "scripts", "stress.sh");

const groups = new Set<number>();
const EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

// Handlers exist only while a group runs: the runner is shared with other
// tests, and a permanent SIGINT handler would change how they end.
function onSignal(signal: keyof typeof EXIT_CODES): void {
  killAll();
  process.exit(EXIT_CODES[signal]);
}
const handlers = (Object.keys(EXIT_CODES) as (keyof typeof EXIT_CODES)[]).map(
  (signal) => [signal, () => onSignal(signal)] as const,
);

function arm(): void {
  process.on("exit", killAll);
  for (const [signal, handler] of handlers) process.on(signal, handler);
}

function disarm(): void {
  process.off("exit", killAll);
  for (const [signal, handler] of handlers) process.off(signal, handler);
}

/** Kills every group still running; a test calls it in afterEach, which runs after a timeout too. */
export function killAll(): void {
  for (const pgid of groups) killProcessGroup(pgid, "SIGKILL");
  groups.clear();
  disarm();
}

export interface StressChild {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
}

export interface Stress {
  readonly child: StressChild;
  readonly pid: number;
  /** Kills the whole group and forgets it. */
  readonly kill: () => void;
}

/** The status a shell would report: 128 plus the signal number. */
function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal === null) return 1;
  return 128 + (osConstants.signals[signal] ?? 0);
}

/** Starts stress.sh as the leader of a new process group. */
export function spawnStress(args: string[], env: Record<string, string> = {}): Stress {
  const child = spawn("bash", [script, ...args], {
    cwd: root,
    // Each run gets a lock of its own unless the test names one: a developer's stress run must not stall the tests.
    env: { ...process.env, STRESS_LOCK: join(mkdtempSync(join(tmpdir(), "stress-lock-")), "lock"), ...env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (pid === undefined || stdout === null || stderr === null) {
    child.kill("SIGKILL");
    throw new Error("stress.sh did not start with a pid and two pipes");
  }
  const exited = new Promise<number>((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (code, signal) => resolve(exitCodeOf(code, signal)));
  });
  if (groups.size === 0) arm();
  groups.add(pid);
  return {
    child: {
      stdout: Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(stderr) as ReadableStream<Uint8Array>,
      exited,
    },
    pid,
    kill: () => {
      killProcessGroup(pid, "SIGKILL");
      groups.delete(pid);
      if (groups.size === 0) disarm();
    },
  };
}

/** Runs stress.sh to its end and returns its output; the group is killed afterwards. */
export async function runStress(args: string[], env: Record<string, string> = {}) {
  const run = spawnStress(args, env);
  try {
    const [out, err, code] = await Promise.all([
      new Response(run.child.stdout).text(),
      new Response(run.child.stderr).text(),
      run.child.exited,
    ]);
    return { out, err, code };
  } finally {
    run.kill();
  }
}
