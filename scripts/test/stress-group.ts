// Runs scripts/stress.sh in a process group of its own and kills the group
// when the test ends, however it ends: normally, by a failure, by a timeout
// that reaches the finally block, or by SIGINT / SIGTERM to the runner.
// SIGKILL of the runner cannot be caught; stress.sh's helpers still stop on
// their own because each checks that the script is alive.
import { killProcessGroup } from "@operad-io/engine/platform";
import { join } from "node:path";

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

export interface Stress {
  readonly child: ReturnType<typeof Bun.spawn>;
  readonly pid: number;
  /** Kills the whole group and forgets it. */
  readonly kill: () => void;
}

/** Starts stress.sh as the leader of a new process group. */
export function spawnStress(args: string[], env: Record<string, string> = {}): Stress {
  const child = Bun.spawn(["bash", script, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  if (groups.size === 0) arm();
  groups.add(child.pid);
  return {
    child,
    pid: child.pid,
    kill: () => {
      killProcessGroup(child.pid, "SIGKILL");
      groups.delete(child.pid);
      if (groups.size === 0) disarm();
    },
  };
}

/** Runs stress.sh to its end and returns its output; the group is killed afterwards. */
export async function runStress(args: string[], env: Record<string, string> = {}) {
  const run = spawnStress(args, env);
  try {
    const [out, code] = await Promise.all([new Response(run.child.stdout).text(), run.child.exited]);
    return { out, code };
  } finally {
    run.kill();
  }
}
