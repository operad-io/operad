/**
 * Runs one shell line in a process group of its own, captures its output and
 * stops the group it started. A command never runs in the kernel: this helper
 * belongs to the base `shell` plugin.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import { Readable } from "node:stream";
import { messageOf, type PluginLogger } from "@operad-io/engine";

/** How long a group gets to end after SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 500;

/**
 * The sentinel is the process-group leader of one line. Its first action
 * ignores SIGTERM; only then does it announce `ready` on the control pipe and
 * start the line, in the same group. A stop that arrives earlier waits for
 * `ready` before it signals, so a signal never reaches the sentinel before its
 * trap is in place. When the line exits the sentinel reports the status and
 * stays alive, so the numeric group id cannot be reused until the stop's last
 * SIGKILL ends the sentinel together with any child that ignored the TERM.
 *
 * The control pipe is the sentinel's stderr; the line gets stderr redirected to
 * its stdout, so the two channels never mix. The line cannot write to the
 * control channel, and a reader that does not know a line ignores it.
 */
const SENTINEL = [
  "trap ':' TERM",
  "printf 'ready\\n' >&2",
  'sh -c "$1" 2>&1',
  "status=$?",
  "printf 'end %s\\n' \"$status\" >&2",
  "while :; do sleep 1; done",
].join("\n");

/** The signal names by number, for the status a shell reports for a signal. */
const SIGNALS_BY_NUMBER = new Map<number, string>(
  Object.entries(osConstants.signals).map(([name, number]) => [number, name]),
);

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

/** The first line the sentinel writes: it is ready, or the shell is gone. */
type Startup =
  | { readonly kind: "ready" }
  | { readonly kind: "closed" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "exit"; readonly exit: Exit };

/** How the line's own shell ended. */
type Ended =
  | { readonly kind: "end"; readonly exit: Exit }
  | { readonly kind: "exit"; readonly exit: Exit }
  | { readonly kind: "closed" };

/**
 * The status a shell reports for a line that a signal ended: 128 plus the
 * signal number. A line that exits with such a code on purpose reads the same.
 */
function exitFromStatus(status: number | null): Exit {
  if (status === null) return { code: null, signal: null };
  if (status > 128) {
    const signal = SIGNALS_BY_NUMBER.get(status - 128);
    if (signal !== undefined) return { code: null, signal };
  }
  return { code: status, signal: null };
}

/** The exit status in a sentinel `end <status>` line, if that is what it is. */
function endStatus(line: string | null): number | undefined {
  if (line === null) return undefined;
  const match = /^end (\d+)$/.exec(line);
  if (match === null) return undefined;
  return Number(match[1]);
}

/**
 * Reads the sentinel's control lines in order. Lines that arrive before a
 * reader asks are queued; a closed pipe answers `null` to every later read.
 * Anything that is not a control line (a shell message from the sentinel) is
 * ignored.
 */
class ControlReader {
  private buffer = "";
  private readonly lines: string[] = [];
  private readonly waiters: Array<(line: string | null) => void> = [];
  private closed = false;
  private readonly stream: Readable;

  constructor(stream: Readable) {
    this.stream = stream;
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => this.receive(chunk));
    stream.on("end", () => this.finish());
    stream.on("close", () => this.finish());
    stream.on("error", () => this.finish());
  }

  next(): Promise<string | null> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  destroy(): void {
    this.closed = true;
    this.stream.destroy();
  }

  private receive(text: string): void {
    if (this.closed) return;
    this.buffer += text;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line === "ready" || endStatus(line) !== undefined) this.deliver(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private deliver(line: string): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter(line);
    else this.lines.push(line);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }
}

/**
 * Runs one line in a process group of its own. Cancellation and the timeout
 * signal the group with SIGTERM and, after the grace period, SIGKILL. The group
 * is always stopped after the line exits too, so a child it forked cannot
 * outlive it. The sentinel leads the group until that SIGKILL, so its numeric
 * id can never be reused by an unrelated group in between: the plugin only ever
 * signals processes it started. A process that leaves the group on purpose
 * cannot be signaled without risking an unrelated process, so the line stops
 * reading its output instead.
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
    child = spawn("sh", ["-c", SENTINEL, "operad-shell", options.line], {
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

  let sentinelExited = false;
  const failed = new Promise<string>((resolve) => {
    child.once("error", (error) => resolve(messageOf(error)));
  });
  const exited = new Promise<Exit>((resolve) => {
    child.once("exit", (code, signal) => {
      sentinelExited = true;
      resolve({ code, signal });
    });
  });

  const stdout = child.stdout;
  const stderr = child.stderr;
  const drained: Promise<void>[] = [];
  if (stdout !== null) drained.push(consume(stdout, output));
  const control = stderr === null ? undefined : new ControlReader(stderr);
  const nextControl = (): Promise<string | null> =>
    control === undefined ? Promise.resolve(null) : control.next();

  // Opens once the sentinel announced that its TERM trap is installed.
  let openGate = (): void => {};
  const readyGate = new Promise<void>((resolve) => {
    openGate = resolve;
  });

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

  let readySeen = false;
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      if (sentinelExited) return;
      // A signal before `ready` could reach the sentinel before it ignores
      // TERM. Wait for the announcement, bounded by the same grace.
      let ready = true;
      if (!readySeen) {
        const outcome = await Promise.race<"ready" | "grace">([
          readyGate.then(() => "ready"),
          clock.sleep(KILL_GRACE_MS).then(() => "grace"),
        ]);
        ready = outcome === "ready";
      }
      if (sentinelExited) return;
      const pid = child.pid;
      if (pid === undefined) return;
      if (!ready) {
        // The sentinel never announced its trap. There is no safe delay: one
        // immediate SIGKILL while our leader is still alive is the only signal.
        killGroup(pid, "SIGKILL");
        return;
      }
      if (!killGroup(pid, "SIGTERM")) return;
      await clock.sleep(KILL_GRACE_MS);
      // The sentinel ignores SIGTERM, so its group id is still this command's
      // unless it exited, in which case nothing is signaled at all.
      if (sentinelExited) return;
      killGroup(pid, "SIGKILL");
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

  const startup = await Promise.race<Startup>([
    nextControl().then(
      (line): Startup =>
        line === "ready" ? { kind: "ready" } : { kind: "closed" },
    ),
    failed.then((message): Startup => ({ kind: "error", message })),
    exited.then((exit): Startup => ({ kind: "exit", exit })),
  ]);

  const finish = async (): Promise<readonly string[]> => {
    const drainedOutput = Promise.all(drained).then(() => undefined);
    let drainTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const drainLimit = new Promise<void>((resolve) => {
      drainTimer = globalThis.setTimeout(resolve, DRAIN_GRACE_MS);
    });
    await Promise.race([drainedOutput, drainLimit]);
    if (drainTimer !== undefined) globalThis.clearTimeout(drainTimer);
    if (stdout !== null) stdout.destroy();
    control?.destroy();
    await drainedOutput;
    await output.end();
    return output.tailLines(20);
  };

  if (startup.kind !== "ready") {
    finished = true;
    if (timer !== undefined) clock.clearTimeout(timer);
    options.signal.removeEventListener("abort", onAbort);
    await stop();
    await Promise.race([exited, failed]);
    const tail = await finish();
    const spawnError =
      cancelled || timedOut
        ? undefined
        : startup.kind === "error"
          ? startup.message
          : "the command shell stopped before the command started";
    return {
      exitCode: startup.kind === "exit" ? startup.exit.code : null,
      signal: startup.kind === "exit" ? startup.exit.signal : null,
      timedOut,
      cancelled,
      spawnError,
      log: options.logger?.path,
      tail,
    };
  }

  readySeen = true;
  openGate();

  const ended = await Promise.race<Ended>([
    nextControl().then((line): Ended => {
      const status = endStatus(line);
      return status === undefined
        ? { kind: "closed" }
        : { kind: "end", exit: exitFromStatus(status) };
    }),
    exited.then((exit): Ended => ({ kind: "exit", exit })),
  ]);

  finished = true;
  if (timer !== undefined) clock.clearTimeout(timer);
  options.signal.removeEventListener("abort", onAbort);

  let exit: Exit;
  if (ended.kind === "closed") exit = await exited;
  else exit = ended.exit;

  // Stop the group the line left behind: the sentinel and any forked child.
  await stop();
  await Promise.race([exited, failed]);
  const tail = await finish();

  return {
    exitCode: exit.code,
    signal: exit.signal,
    timedOut,
    cancelled,
    spawnError: undefined,
    log: options.logger?.path,
    tail,
  };
}
