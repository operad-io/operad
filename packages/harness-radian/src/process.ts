/**
 * Runs one harness command in a process group of its own, streams its output
 * line by line, and stops only that group. The harness plugin decides the
 * command and reads the closing Result record; this module never runs in the
 * kernel.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";

/** How long a group gets to end after SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 500;

/**
 * How long the pipes get to close after the group was stopped. A process that
 * left the group keeps its inherited descriptors open, and the step must not
 * wait for it: reading stops after this.
 */
export const DRAIN_GRACE_MS = 1000;

/** The timers a harness run reads. A test injects its own. */
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

/**
 * The sentinel is the process-group leader of one harness run. Its first
 * action ignores SIGTERM; only then does it announce `ready` on the control
 * pipe and start the harness in the same group. When the harness exits the
 * sentinel reports the status and stays alive, so the numeric group id cannot
 * be reused until the stop's last SIGKILL ends the sentinel together with any
 * child that ignored the TERM.
 *
 * The control pipe is the sentinel's stderr. The harness keeps its own stderr
 * on fd 3, so diagnostics never mix with the JSONL on stdout or the control
 * lines. A reader that does not know a line ignores it.
 */
const SENTINEL = [
  "trap ':' TERM",
  "printf 'ready\\n' >&2",
  '"$@" 2>&3',
  "status=$?",
  "printf 'end %s\\n' \"$status\" >&2",
  "while :; do sleep 1; done",
].join("\n");

/** The last `count` lines of text, with no trailing blank line. */
export function lastLines(text: string, count: number): readonly string[] {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-count);
}

/** The tool activity a harness journal line reports, when it reports one. */
export function toolActivity(line: string): "started" | "settled" | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const event = typeof record.event === "string" ? record.event : record.type;
  if (event === "ToolExecutionStarted") return "started";
  if (event === "ToolExecutionSettled") return "settled";
  return undefined;
}

/** How much of the harness's own stderr the fact keeps. */
const STDERR_LIMIT = 64 * 1024;

/**
 * The longest single output line the run holds. A harness that never writes a
 * newline must not be able to grow the buffer until the stall or wall limit
 * fires: past this a line is a malformed stream and the group is stopped.
 */
export const MAX_LINE_CHARS = 8 * 1024 * 1024;

/** Finds an executable on PATH, or returns undefined. */
export async function findCommand(command: string): Promise<string | undefined> {
  if (command.includes("/")) {
    return (await executable(command)) ? command : undefined;
  }
  const path = process.env.PATH ?? "";
  for (const directory of path.split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, command);
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface AgentRunOptions {
  /** The command name or path, resolved on PATH when it names no directory. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The prompt written to stdin; the command reads it with `-p -`. */
  readonly stdin?: string | undefined;
  readonly wallMs: number;
  readonly stallMs: number;
  readonly signal: AbortSignal;
  readonly clock?: Clock | undefined;
  /**
   * Receives each complete stdout line, in order. Reading waits for the answer:
   * a handler that is still busy writes before the next line is taken.
   */
  readonly onLine: (line: string) => void | Promise<void>;
  /** Sends a signal to one process group; a test replaces it to watch signals. */
  readonly killGroup?:
    | ((pgid: number, signal: NodeJS.Signals | 0) => boolean)
    | undefined;
}

export interface AgentRunOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly cancelled: boolean;
  readonly wall: boolean;
  readonly stall: boolean;
  readonly lineTooLong: boolean;
  readonly missing: boolean;
  readonly spawnError: string | undefined;
  readonly stderrTail: readonly string[];
}

interface Exit {
  readonly code: number | null;
  readonly signal: string | null;
}

/** The signal names by number, for the status a shell reports for a signal. */
const SIGNALS_BY_NUMBER = new Map<number, string>(
  Object.entries(osConstants.signals).map(([name, number]) => [number, name]),
);

function exitFromStatus(status: number | null): Exit {
  if (status === null) return { code: null, signal: null };
  if (status > 128) {
    const signal = SIGNALS_BY_NUMBER.get(status - 128);
    if (signal !== undefined) return { code: null, signal };
  }
  return { code: status, signal: null };
}

function endStatus(line: string | null): number | undefined {
  if (line === null) return undefined;
  const match = /^end (\d+)$/.exec(line);
  return match === null ? undefined : Number(match[1]);
}

/**
 * Splits a stream into complete lines, holding the unterminated tail up to
 * `MAX_LINE_CHARS`. Each line is handed over before the next is read: a busy
 * handler holds the stream, so the pipe cannot fill memory. The tail is dropped
 * and `onOverflow` is called when a line grows past the limit, so no input can
 * exhaust memory.
 */
class Lines {
  private buffer = "";
  private readonly onLine: (line: string) => void | Promise<void>;
  private readonly onOverflow: () => void;

  constructor(
    onLine: (line: string) => void | Promise<void>,
    onOverflow: () => void,
  ) {
    this.onLine = onLine;
    this.onOverflow = onOverflow;
  }

  async push(text: string): Promise<void> {
    if (text.length === 0) return;
    this.buffer += text;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      await this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > MAX_LINE_CHARS) {
      this.buffer = "";
      this.onOverflow();
    }
  }

  async end(): Promise<void> {
    if (this.buffer.length === 0) return;
    const rest = this.buffer;
    this.buffer = "";
    await this.onLine(rest);
  }
}

/** Collects a bounded tail of one stream. */
class Tail {
  private text = "";
  private readonly onText: ((text: string) => void) | undefined;

  constructor(onText: ((text: string) => void) | undefined) {
    this.onText = onText;
  }

  push(text: string): void {
    if (text.length === 0) return;
    this.text = (this.text + text).slice(-STDERR_LIMIT);
    this.onText?.(text);
  }

  lines(count: number): readonly string[] {
    return lastLines(this.text, count);
  }
}

type Startup =
  | { readonly kind: "ready" }
  | { readonly kind: "closed" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "exit"; readonly exit: Exit };

type Ended =
  | { readonly kind: "end"; readonly exit: Exit }
  | { readonly kind: "exit"; readonly exit: Exit }
  | { readonly kind: "closed" };

/**
 * Reads the sentinel's control lines in order. Lines that arrive before a
 * reader asks are queued; a closed pipe answers `null` to every later read.
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

function consume(
  stream: Readable,
  lines: Lines,
  tail: Tail | undefined,
): Promise<void> {
  return (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        const text = decoder.decode(chunk as Uint8Array, { stream: true });
        if (tail === undefined) await lines.push(text);
        else tail.push(text);
      }
      const rest = decoder.decode();
      if (tail === undefined) await lines.push(rest);
      else tail.push(rest);
    } catch {
      // A process that failed to start has no output; its streams may error.
    }
  })();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one harness command. Cancellation, the wall time and a stalled output
 * stream signal the group with SIGTERM and, after the grace period, SIGKILL.
 * The group is always stopped after the command exits too, so a child it
 * forked cannot outlive it. Only processes this call started are signaled.
 */
export async function runAgent(
  options: AgentRunOptions,
): Promise<AgentRunOutcome> {
  const empty = (overrides: Partial<AgentRunOutcome>): AgentRunOutcome => ({
    exitCode: null,
    signal: null,
    cancelled: false,
    wall: false,
    stall: false,
    lineTooLong: false,
    missing: false,
    spawnError: undefined,
    stderrTail: [],
    ...overrides,
  });

  if (options.signal.aborted) {
    return empty({ cancelled: true });
  }

  const executablePath = await findCommand(options.command);
  if (executablePath === undefined) {
    return empty({ missing: true });
  }

  const clock = options.clock ?? systemClock;
  let resetStallForLine: () => void = () => {};
  let onLineOverflow: () => void = () => {};
  let toolCalls = 0;
  let onToolActivity: (activity: "started" | "settled") => void = () => {};
  const stdoutLines = new Lines(
    (line) => {
      const activity = toolActivity(line);
      if (activity !== undefined) onToolActivity(activity);
      resetStallForLine();
      return options.onLine(line);
    },
    () => onLineOverflow(),
  );
  const stderrTail = new Tail(undefined);

  let child: ChildProcess;
  try {
    child = spawn(
      "sh",
      [
        "-c",
        SENTINEL,
        "operad-harness",
        executablePath,
        ...options.args,
      ],
      {
        cwd: options.cwd,
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      },
    );
  } catch (error) {
    return empty({ spawnError: messageOf(error) });
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
  // A failed spawn emits `error` and never `exit`. Anything that waits for the
  // process to be gone must settle on either, or the step would hang forever.
  const settled = Promise.race<Exit>([
    exited,
    failed.then((): Exit => ({ code: null, signal: null })),
  ]);

  const stdout = child.stdout;
  const stderr = child.stderr;
  const extra = child.stdio[3] as Readable | null | undefined;
  const drained: Promise<void>[] = [];
  if (stdout !== null) {
    drained.push(consume(stdout, stdoutLines, undefined));
  }
  if (extra !== null && extra !== undefined) {
    drained.push(consume(extra, stdoutLines, stderrTail));
  }
  const control = stderr === null ? undefined : new ControlReader(stderr);
  const nextControl = (): Promise<string | null> =>
    control === undefined ? Promise.resolve(null) : control.next();

  // The prompt travels on stdin; the harness reads it with `-p -`.
  const stdin = child.stdin;
  if (stdin !== null) {
    stdin.on("error", () => undefined);
    if (options.stdin === undefined) stdin.end();
    else stdin.end(options.stdin);
  }

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
      const pid = child.pid;
      if (pid === undefined) return;
      let ready = true;
      if (!readySeen) {
        const outcome = await Promise.race<"ready" | "grace">([
          readyGate.then(() => "ready"),
          clock.sleep(KILL_GRACE_MS).then(() => "grace"),
        ]);
        ready = outcome === "ready";
      }
      if (sentinelExited) return;
      if (!ready) {
        killGroup(pid, "SIGKILL");
        return;
      }
      if (!killGroup(pid, "SIGTERM")) return;
      await clock.sleep(KILL_GRACE_MS);
      if (sentinelExited) return;
      killGroup(pid, "SIGKILL");
    })();
    return stopping;
  };

  let finished = false;
  let stoppingFor: "cancel" | "wall" | "stall" | "line" | undefined;
  const beginStop = (kind: "cancel" | "wall" | "stall" | "line"): void => {
    if (finished || stoppingFor !== undefined) return;
    stoppingFor = kind;
    void stop();
  };
  onLineOverflow = () => beginStop("line");

  let wallTimer: unknown;
  if (options.wallMs > 0) {
    wallTimer = clock.setTimeout(() => {
      if (!finished) beginStop("wall");
    }, options.wallMs);
  }

  let stallTimer: unknown;
  const resetStall = (): void => {
    if (options.stallMs <= 0) return;
    if (stallTimer !== undefined) {
      clock.clearTimeout(stallTimer);
      stallTimer = undefined;
    }
    // A tool call may run as long as it needs: only the wall limit watches it.
    if (toolCalls > 0) return;
    stallTimer = clock.setTimeout(() => {
      if (!finished) beginStop("stall");
    }, options.stallMs);
  };
  onToolActivity = (activity) => {
    if (activity === "started") toolCalls += 1;
    else toolCalls = Math.max(0, toolCalls - 1);
    resetStall();
  };
  resetStall();
  resetStallForLine = resetStall;

  const onAbort = (): void => beginStop("cancel");
  options.signal.addEventListener("abort", onAbort, { once: true });

  const clearTimers = (): void => {
    if (wallTimer !== undefined) clock.clearTimeout(wallTimer);
    if (stallTimer !== undefined) clock.clearTimeout(stallTimer);
  };

  const startup = await Promise.race<Startup>([
    nextControl().then(
      (line): Startup =>
        line === "ready" ? { kind: "ready" } : { kind: "closed" },
    ),
    failed.then((message): Startup => ({ kind: "error", message })),
    exited.then((exit): Startup => ({ kind: "exit", exit })),
  ]);

  const finish = async (): Promise<{
    readonly tail: readonly string[];
    readonly exit: Exit;
  }> => {
    const drainedOutput = Promise.all(drained).then(() => undefined);
    let drainTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const drainLimit = new Promise<void>((resolve) => {
      drainTimer = globalThis.setTimeout(resolve, DRAIN_GRACE_MS);
    });
    await Promise.race([drainedOutput, drainLimit]);
    if (drainTimer !== undefined) globalThis.clearTimeout(drainTimer);
    if (stdout !== null) stdout.destroy();
    if (extra !== null && extra !== undefined) extra.destroy();
    control?.destroy();
    await drainedOutput;
    await stdoutLines.end();
    return { tail: stderrTail.lines(20), exit: await settled };
  };

  if (startup.kind !== "ready") {
    finished = true;
    clearTimers();
    options.signal.removeEventListener("abort", onAbort);
    await stop();
    await Promise.race([exited, failed]);
    const { tail, exit } = await finish();
    const spawnError =
      stoppingFor !== undefined
        ? undefined
        : startup.kind === "error"
          ? startup.message
          : startup.kind === "closed"
            ? "the harness shell stopped before the command started"
            : undefined;
    return {
      exitCode: exit.code,
      signal: exit.signal,
      cancelled: stoppingFor === "cancel",
      wall: stoppingFor === "wall",
      stall: stoppingFor === "stall",
      lineTooLong: stoppingFor === "line",
      missing: false,
      spawnError,
      stderrTail: tail,
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
  clearTimers();
  options.signal.removeEventListener("abort", onAbort);

  let exit: Exit;
  if (ended.kind === "closed") exit = await exited;
  else exit = ended.exit;

  // Stop the group the command left behind: the sentinel and any forked child.
  await stop();
  await Promise.race([exited, failed]);
  const { tail } = await finish();

  return {
    exitCode: exit.code,
    signal: exit.signal,
    cancelled: stoppingFor === "cancel",
    wall: stoppingFor === "wall",
    stall: stoppingFor === "stall",
    lineTooLong: stoppingFor === "line",
    missing: false,
    spawnError: undefined,
    stderrTail: tail,
  };
}
