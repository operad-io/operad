/**
 * Runs one shell line in a process group of its own, captures its output and
 * stops the group it started. A command never runs in the kernel: this helper
 * belongs to the base `shell` plugin.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { messageOf, type PluginLogger } from "@operad-io/engine";

/** How long a group gets to end after SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 500;

/**
 * A background member of the command's group that survives SIGTERM. While it
 * runs the group cannot end, so its numeric id cannot be reused, and every
 * `kill(-pgid)` signal reaches a group this command started. The stop always
 * ends with SIGKILL, which takes the sentinel too.
 */
const SENTINEL = 'trap ":" TERM; while :; do sleep 1; done';

/**
 * The shell that starts a line. It puts the sentinel in its own process group,
 * then replaces itself with the line's shell, so the group leader is the line
 * itself and its exit status is the line's. The sentinel writes nothing.
 */
const WRAPPER = 'sh -c "$1" >/dev/null 2>&1 & exec sh -c "$2"';

/**
 * How long the pipes get to close after the group was stopped. A process that
 * left the group keeps its inherited descriptors open, and the command must
 * not wait for it: reading stops after this.
 */
export const DRAIN_GRACE_MS = 1000;

/** The timers a line run reads. A test injects its own to control timeouts. */
export interface Clock {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  sleep(ms: number): Promise<void>;
}

/** The clock a real run uses. */
export const systemClock: Clock = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  sleep: (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)),
};

/** How much output the tail keeps; enough for the last lines of a long run. */
const TAIL_LIMIT = 64 * 1024;

/** How much complete output is buffered before it is written to the log. */
const FLUSH_AT = 16 * 1024;

export interface LineRunOptions {
  readonly line: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal: AbortSignal;
  readonly logger?: PluginLogger | undefined;
  readonly clock?: Clock | undefined;
  /** Sends a signal to one process group; a test replaces it to watch signals. */
  readonly killGroup?:
    | ((pgid: number, signal: NodeJS.Signals | 0) => boolean)
    | undefined;
}

export interface LineOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly spawnError: string | undefined;
  readonly log: string | undefined;
  readonly tail: readonly string[];
}

/** The last `count` lines of a chunk of output, with no trailing blank line. */
export function lastLines(text: string, count: number): readonly string[] {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-count);
}

/**
 * Writes output to the step's log as complete chunks, so a long command does
 * not need its whole output in memory. Only a bounded tail is kept for the
 * fact.
 */
class Output {
  private tail = "";
  private buffer = "";
  private wrote = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly logger: PluginLogger | undefined;

  constructor(logger: PluginLogger | undefined) {
    this.logger = logger;
  }

  push(text: string): void {
    if (text.length === 0) return;
    this.tail = (this.tail + text).slice(-TAIL_LIMIT);
    if (this.logger === undefined) return;

    this.buffer += text;
    const newline = this.buffer.lastIndexOf("\n");
    if (newline >= 0 && newline >= FLUSH_AT) {
      const complete = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.enqueue(complete);
    } else if (this.buffer.length >= FLUSH_AT * 4) {
      const complete = this.buffer;
      this.buffer = "";
      this.enqueue(complete);
    }
  }

  async end(): Promise<void> {
    if (this.logger !== undefined) {
      if (this.buffer.length > 0) {
        const complete = this.buffer;
        this.buffer = "";
        this.enqueue(complete);
      } else if (!this.wrote) {
        this.enqueue("");
      }
    }
    await this.chain;
  }

  tailLines(count: number): readonly string[] {
    return lastLines(this.tail, count);
  }

  private enqueue(text: string): void {
    const logger = this.logger;
    if (logger === undefined) return;
    if (text.length === 0 && this.wrote) return;
    this.wrote = true;
    this.chain = this.chain
      .then(() => logger.write(text))
      .then(() => undefined);
  }
}

function consume(stream: Readable, output: Output): Promise<void> {
  return (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        output.push(decoder.decode(chunk as Uint8Array, { stream: true }));
      }
      output.push(decoder.decode());
    } catch {
      // A process that failed to start has no output; its streams may error.
    }
  })();
}

interface Exit {
  readonly code: number | null;
  readonly signal: string | null;
}

type First = { readonly kind: "exit"; readonly value: Exit } | {
  readonly kind: "error";
  readonly message: string;
};

/**
 * Runs one line in a process group of its own. Cancellation and the timeout
 * signal the group with SIGTERM and, after the grace period, SIGKILL. The group
 * is always stopped after the line exits too, so a child it forked cannot
 * outlive it. A sentinel keeps the group alive until that SIGKILL, so its
 * numeric id can never be reused by an unrelated group in between: the plugin
 * only ever signals processes it started. A process that leaves the group on
 * purpose cannot be signaled without risking an unrelated process, so the line
 * stops reading its output instead.
 */
export async function runLine(options: LineRunOptions): Promise<LineOutcome> {
  if (options.signal.aborted) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: true,
      spawnError: undefined,
      log: options.logger?.path,
      tail: [],
    };
  }

  const clock = options.clock ?? systemClock;
  const output = new Output(options.logger);
  let child: ChildProcess;
  try {
    child = spawn("sh", ["-c", WRAPPER, "operad-shell", SENTINEL, options.line], {
      cwd: options.cwd,
      ...(options.env === undefined
        ? {}
        : { env: { ...process.env, ...options.env } }),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const spawnError = messageOf(error);
    await output.end();
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      spawnError,
      log: options.logger?.path,
      tail: output.tailLines(20),
    };
  }

  const failed = new Promise<string>((resolve) => {
    child.once("error", (error) => resolve(messageOf(error)));
  });
  const exited = new Promise<Exit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const stdout = child.stdout;
  const stderr = child.stderr;
  const drained: Promise<void>[] = [];
  if (stdout !== null) drained.push(consume(stdout, output));
  if (stderr !== null) drained.push(consume(stderr, output));

  let stopping: Promise<void> | undefined;
  const killGroup =
    options.killGroup ??
    ((pgid: number, signal: NodeJS.Signals | 0): boolean => {
      try {
        process.kill(-pgid, signal);
        return true;
      } catch {
        return false;
      }
    });
  const signalGroup = (signal: NodeJS.Signals): boolean => {
    const pid = child.pid;
    return pid === undefined ? false : killGroup(pid, signal);
  };
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      if (!signalGroup("SIGTERM")) return;
      await clock.sleep(KILL_GRACE_MS);
      // The sentinel ignores SIGTERM, so the group still exists and its id is
      // still this command's: no unrelated group can have taken it. SIGKILL
      // ends the sentinel and any child that ignored SIGTERM.
      signalGroup("SIGKILL");
    })();
    return stopping;
  };

  let finished = false;
  let timedOut = false;
  let cancelled = false;
  let timer: unknown;
  if (options.timeoutMs !== undefined) {
    timer = clock.setTimeout(() => {
      if (finished) return;
      timedOut = true;
      void stop();
    }, options.timeoutMs);
  }
  const onAbort = (): void => {
    if (finished) return;
    cancelled = true;
    void stop();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });

  const first = await Promise.race<First>([
    exited.then((value) => ({ kind: "exit", value })),
    failed.then((message) => ({ kind: "error", message })),
  ]);
  finished = true;

  if (timer !== undefined) clock.clearTimeout(timer);
  options.signal.removeEventListener("abort", onAbort);

  // Stop the group the line left behind: the sentinel and any forked child.
  await stop();
  // The leader is the line itself; after the stop it has exited.
  await Promise.race([exited, failed]);

  // The pipes normally close with the group. A process that left the group
  // keeps them open, so give them a bounded time and then stop reading: the
  // command must end even when such a process runs on.
  const drainedOutput = Promise.all(drained).then(() => undefined);
  let drainTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  const drainLimit = new Promise<void>((resolve) => {
    drainTimer = globalThis.setTimeout(resolve, DRAIN_GRACE_MS);
  });
  await Promise.race([drainedOutput, drainLimit]);
  if (drainTimer !== undefined) globalThis.clearTimeout(drainTimer);
  if (stdout !== null) stdout.destroy();
  if (stderr !== null) stderr.destroy();
  await drainedOutput;
  await output.end();

  return {
    exitCode: first.kind === "exit" ? first.value.code : null,
    signal: first.kind === "exit" ? first.value.signal : null,
    timedOut,
    cancelled,
    spawnError: first.kind === "error" ? first.message : undefined,
    log: options.logger?.path,
    tail: output.tailLines(20),
  };
}
