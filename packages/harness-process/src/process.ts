/**
 * Runs one harness command in a process group of its own, streams its output
 * line by line, and stops only that group. The harness plugin decides the
 * command and reads the closing Result record; this module never runs in the
 * kernel.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, open, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";
import {
  ControlReader,
  DRAIN_GRACE_MS,
  createGroupStop,
  endStatus,
  exitFromStatus,
  killProcessGroup,
  lastLines,
  systemClock,
  type Clock,
  type Ended,
  type Exit,
  type Startup,
} from "@operad-io/engine/platform";

export { DRAIN_GRACE_MS, KILL_GRACE_MS, lastLines, systemClock, type Clock } from "@operad-io/engine/platform";

/**
 * The sentinel is the process-group leader of one harness run. Its first
 * action ignores SIGTERM; only then does it announce `ready` on the control
 * pipe and start the harness in the same group. When the harness exits the
 * sentinel reports the status and stays alive, so the numeric group id cannot
 * be reused until the stop's last SIGKILL ends the sentinel together with any
 * child that ignored the TERM.
 *
 * The control pipe is the sentinel's stderr. The harness keeps its own stderr
 * in a file the caller names (the first argument), so diagnostics never mix
 * with the JSONL on stdout or the control lines. A reader that does not know a
 * line ignores it.
 *
 * The sentinel watches the process that started it (`$2`), from a helper that
 * runs beside the harness: if the host is killed before it can stop the group,
 * the helper kills the whole group, harness included, instead of leaving both
 * running for a host that is gone. The check cannot wait for the harness to
 * end, because the harness may be the thing that never does.
 *
 * The file replaces a fourth pipe. Bun closes an extra pipe (stdio index 3 and
 * up) of a child process twice, once when its stream ends and once when the
 * child object is collected; by then a SQLite database may own the number, and
 * macOS kills the process (EXC_GUARD). See test/descriptor-owner.test.ts.
 */
const SENTINEL = [
  "trap ':' TERM",
  'parent=$2',
  // The helper's output goes nowhere, so it never holds the control pipe open.
  '( while kill -0 "$parent" 2>/dev/null; do sleep 1; done; kill -KILL -- "-$$" ) >/dev/null 2>&1 &',
  "printf 'ready\\n' >&2",
  'err=$1',
  "shift 2",
  '"$@" 2>"$err"',
  "status=$?",
  "printf 'end %s\\n' \"$status\" >&2",
  'while kill -0 "$parent" 2>/dev/null; do sleep 1 2>/dev/null; done',
].join("\n");

/**
 * What one output line says about a tool call. Each harness names its own
 * events; the caller supplies the classifier.
 */
export type ToolEvent = "tool-start" | "tool-end";

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
  /**
   * Keeps stdin open after the prompt, which then ends with a newline, so
   * `onLine` can answer with `reply`. The child's end of the pipe closes when
   * it exits.
   */
  readonly interactive?: boolean | undefined;
  readonly wallMs: number;
  readonly stallMs: number;
  readonly signal: AbortSignal;
  readonly clock?: Clock | undefined;
  /**
   * Receives each complete stdout line, in order. Reading waits for the answer:
   * a handler that is still busy writes before the next line is taken.
   */
  readonly onLine: (
    line: string,
    reply: (text: string) => void,
  ) => void | Promise<void>;
  /**
   * Classifies one complete stdout line. A line that starts a tool call pauses
   * the stall timer until a line that ends it arrives; the wall limit still
   * runs. Without a classifier no line counts as a tool call.
   */
  readonly toolEvent?: ((line: string) => ToolEvent | undefined) | undefined;
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

function consume(
  stream: Readable,
  lines: Lines,
): Promise<void> {
  return (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        const text = decoder.decode(chunk as Uint8Array, { stream: true });
        await lines.push(text);
      }
      const rest = decoder.decode();
      await lines.push(rest);
    } catch {
      // A process that failed to start has no output; its streams may error.
    }
  })();
}

/** The last `STDERR_LIMIT` bytes of a file; empty when it cannot be read. */
async function readTail(path: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch {
    return "";
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, STDERR_LIMIT);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    return new TextDecoder().decode(buffer.subarray(0, bytesRead));
  } catch {
    return "";
  } finally {
    await handle.close();
  }
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
  const reply = (text: string): void => {
    const pipe = child.stdin;
    if (options.interactive !== true || pipe === null || pipe.destroyed) return;
    pipe.write(`${text}\n`);
  };
  let toolCalls = 0;
  let onToolActivity: (activity: ToolEvent) => void = () => {};
  const stdoutLines = new Lines(
    (line) => {
      const activity = options.toolEvent?.(line);
      if (activity !== undefined) onToolActivity(activity);
      resetStallForLine();
      return options.onLine(line, reply);
    },
    () => onLineOverflow(),
  );
  const stderrTail = new Tail(undefined);

  let errorDirectory: string;
  try {
    errorDirectory = await mkdtemp(join(tmpdir(), "operad-harness-"));
  } catch (error) {
    return empty({ spawnError: messageOf(error) });
  }
  const errorPath = join(errorDirectory, "stderr");

  let child: ChildProcess;
  try {
    child = spawn(
      "sh",
      [
        "-c",
        SENTINEL,
        "operad-harness",
        errorPath,
        String(process.pid),
        executablePath,
        ...options.args,
      ],
      {
        cwd: options.cwd,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch (error) {
    await rm(errorDirectory, { recursive: true, force: true });
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
  const drained: Promise<void>[] = [];
  if (stdout !== null) {
    drained.push(consume(stdout, stdoutLines));
  }
  const control = stderr === null ? undefined : new ControlReader(stderr);
  const nextControl = (): Promise<string | null> =>
    control === undefined ? Promise.resolve(null) : control.next();

  // The prompt travels on stdin; the harness reads it with `-p -`.
  const stdin = child.stdin;
  if (stdin !== null) {
    stdin.on("error", () => undefined);
    if (options.interactive === true) {
      stdin.write(`${options.stdin ?? ""}\n`);
    } else if (options.stdin === undefined) stdin.end();
    else stdin.end(options.stdin);
  }

  // Opens once the sentinel announced that its TERM trap is installed.
  let openGate = (): void => {};
  const readyGate = new Promise<void>((resolve) => {
    openGate = resolve;
  });

  let readySeen = false;
  const stop = createGroupStop({
    clock,
    killGroup: options.killGroup ?? killProcessGroup,
    pid: () => child.pid,
    sentinelExited: () => sentinelExited,
    readySeen: () => readySeen,
    ready: readyGate,
  });

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
    if (activity === "tool-start") toolCalls += 1;
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
    let drainTimer: unknown;
    const drainLimit = new Promise<void>((resolve) => {
      drainTimer = clock.setTimeout(resolve, DRAIN_GRACE_MS);
    });
    await Promise.race([drainedOutput, drainLimit]);
    if (drainTimer !== undefined) clock.clearTimeout(drainTimer);
    if (stdout !== null) stdout.destroy();
    control?.destroy();
    await drainedOutput;
    await stdoutLines.end();
    const exit = await settled;
    stderrTail.push(await readTail(errorPath));
    await rm(errorDirectory, { recursive: true, force: true });
    return { tail: stderrTail.lines(20), exit };
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

  // Stop the group the command left behind: the sentinel and any forked
  // child. A command that reported its own status has already ended, so there
  // is nothing left to give SIGTERM time for; waiting the grace made every
  // finished run pay 500 ms. A cancellation or limit still takes the TERM path.
  if (ended.kind === "end" && stoppingFor === undefined) {
    const pid = child.pid;
    if (pid !== undefined) (options.killGroup ?? killProcessGroup)(pid, "SIGKILL");
  } else {
    await stop();
  }
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
