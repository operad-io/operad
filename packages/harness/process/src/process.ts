/**
 * Runs one harness command in a process group of its own, streams its output
 * line by line, and stops only that group. The harness plugin decides the
 * command and reads the closing Result record; this module never runs in the
 * kernel.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, open, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { messageLine, type MessageInbox } from "./inbox.ts";
import {
  ControlReader,
  DRAIN_GRACE_MS,
  createGroupStop,
  endStatus,
  exitFromStatus,
  KILL_GRACE_MS,
  KEPT_FIRST_LINE_MS,
  KEPT_WORKER_MS,
  MAX_KEPT_WORKERS,
  killProcessGroup,
  lastLines,
  markerEnv,
  newKeptWorkerSlot,
  readKeptWorker,
  readKeptWorkers,
  readKeptWorkersInHome,
  stopKeptWorker,
  keptWorkerArgument,
  waitForChange,
  type KeptWorkerRecord,
  reportWorkerStarted,
  trackRoot,
  systemClock,
  type Clock,
  type Ended,
  type Exit,
  type Startup,
} from "@operad-io/engine/platform";
import { isRecord, messageOf } from "@operad-io/engine";

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
 * macOS kills the process (EXC_GUARD). See test/heavy/descriptor-owner.test.ts.
 */
const SENTINEL = [
  "trap ':' TERM",
  'parent=$2',
  // The helper's output goes nowhere, so it never holds the control pipe open.
  // The numeric group form is POSIX; dash does not accept `--` before it.
  '( while kill -0 "$parent" 2>/dev/null; do sleep 1; done; kill -KILL -$$ ) >/dev/null 2>&1 &',
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

/** What a caller gives when a reply's worker may stay for the next reply. */
export interface KeptRunOptions {
  readonly home: string;
  /** The harness name; its kept directory is under this home. */
  readonly name: string;
  /** The one conversation the worker answers, such as `chat:C-0022`. */
  readonly scope: string;
  /** What the worker was started with; a different key never reuses it. */
  readonly key: string;
  /** Test seam: the kept time; defaults to `KEPT_WORKER_MS`. */
  readonly timeoutMs?: number | undefined;
  /** Test seam: how long the first line may take; defaults to `KEPT_FIRST_LINE_MS`. */
  readonly firstLineMs?: number | undefined;
  /** Test seam: the most workers this home keeps; defaults to `MAX_KEPT_WORKERS`. */
  readonly max?: number | undefined;
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
  /**
   * Messages from the host, written to stdin as `message` lines while the
   * command runs. Needs `interactive`; without it nothing is written.
   */
  readonly inbox?: MessageInbox | undefined;
  /** Set by a chat reply: keep this worker after a done reply and reuse it next time. */
  readonly keep?: KeptRunOptions | undefined;
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
   * Called once the command has started and before any of its output is read:
   * a harness with no session handshake writes its ready line here.
   */
  readonly onStart?: (() => void) | undefined;
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

/** An outcome with nothing wrong, plus what the caller knows. */
function emptyOutcome(overrides: Partial<AgentRunOutcome>): AgentRunOutcome {
  return {
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
  };
}

/** Why one run is being stopped; `cancel` is the host's signal. */
export type StopKind = "cancel" | "wall" | "stall" | "line";

/** What one run watches: the wall time, a stalled stream, the host's signal and mid-run messages. */
export interface WatchedRun {
  /** Counts a tool call in a line and restarts the stall timer; call for every line. */
  line(line: string): void;
  /** Starts the wall and stall timers; before the run's program is spoken to. */
  start(): void;
  /** Takes the host's mid-run messages and tells it the run has begun. */
  listenInbox(): void;
  /** Stops the run for this reason, once. */
  interrupt(kind: StopKind): void;
  /** Clears the timers, the inbox listener and the abort listener. */
  end(): void;
  /** The reason the run is being stopped, while it is. */
  readonly stoppingFor: StopKind | undefined;
}

export interface WatchOptions {
  readonly clock: Clock;
  readonly wallMs: number;
  readonly stallMs: number;
  readonly signal: AbortSignal;
  readonly toolEvent?: ((line: string) => ToolEvent | undefined) | undefined;
  readonly finished: () => boolean;
  /** Begins stopping the program; the watcher has already recorded the reason. */
  readonly beginStop: (kind: StopKind) => void;
  readonly inbox?: MessageInbox | undefined;
  readonly reply: (text: string) => boolean | void;
}

/**
 * One run's wall timer, stall timer, abort listener and inbox listener. A line
 * restarts the stall only while no tool call is open: a tool may run as long as
 * it needs, and only the wall limit watches it.
 */
export function watchRun(options: WatchOptions): WatchedRun {
  const { clock } = options;
  let finished = false;
  let stoppingFor: StopKind | undefined;
  let toolCalls = 0;
  let wallTimer: unknown;
  let stallTimer: unknown;
  let stopListening: (() => void) | undefined;

  const interrupt = (kind: StopKind): void => {
    if (finished || stoppingFor !== undefined) return;
    stoppingFor = kind;
    options.beginStop(kind);
  };
  const resetStall = (): void => {
    if (options.stallMs <= 0) return;
    if (stallTimer !== undefined) {
      clock.clearTimeout(stallTimer);
      stallTimer = undefined;
    }
    if (toolCalls > 0) return;
    stallTimer = clock.setTimeout(() => {
      if (!finished) interrupt("stall");
    }, options.stallMs);
  };
  const onAbort = (): void => interrupt("cancel");
  options.signal.addEventListener("abort", onAbort, { once: true });

  return {
    get stoppingFor() {
      return stoppingFor;
    },
    line(line: string): void {
      const activity = options.toolEvent?.(line);
      if (activity === "tool-start") toolCalls += 1;
      else if (activity === "tool-end") toolCalls = Math.max(0, toolCalls - 1);
      resetStall();
    },
    start(): void {
      if (options.wallMs > 0) {
        wallTimer = clock.setTimeout(() => {
          if (!finished) interrupt("wall");
        }, options.wallMs);
      }
      resetStall();
    },
    listenInbox(): void {
      stopListening =
        options.inbox === undefined
          ? undefined
          : options.inbox.listen((text) => {
              if (finished) return false;
              return options.reply(messageLine(text)) ?? true;
            });
      if (options.wallMs > 0) options.inbox?.begin?.(options.wallMs);
    },
    interrupt,
    end(): void {
      finished = true;
      if (wallTimer !== undefined) clock.clearTimeout(wallTimer);
      if (stallTimer !== undefined) clock.clearTimeout(stallTimer);
      stopListening?.();
      options.signal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Ends the workers this home keeps beyond the cap, the one idle longest first.
 * `over` decides whether the count is too high: a reply that just finished
 * trims above the cap, and a reply about to start a worker trims at it.
 */
export async function trimKept(
  keep: KeptRunOptions,
  clock: Clock,
  over: (count: number, max: number) => boolean,
): Promise<void> {
  const max = keep.max ?? MAX_KEPT_WORKERS;
  const kept = [...readKeptWorkersInHome(keep.home)].sort(
    (left, right) => left.lastUsedAt - right.lastUsedAt,
  );
  while (over(kept.length, max) && kept.length > 0) {
    const idle = kept.find((record) => record.busy !== true) ?? kept[0];
    if (idle === undefined) break;
    await stopKeptWorker(idle, { clock });
    kept.splice(kept.indexOf(idle), 1);
  }
}

/** The outcome fields a stop reason sets. */
function stoppedOutcome(stoppingFor: StopKind | undefined): Partial<AgentRunOutcome> {
  return {
    ...(stoppingFor === "cancel" ? { cancelled: true } : {}),
    ...(stoppingFor === "wall" ? { wall: true } : {}),
    ...(stoppingFor === "stall" ? { stall: true } : {}),
    ...(stoppingFor === "line" ? { lineTooLong: true } : {}),
  };
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

/**
 * Runs one harness command. Cancellation, the wall time and a stalled output
 * stream signal the group with SIGTERM and, after the grace period, SIGKILL.
 * The group is always stopped after the command exits too, so a child it
 * forked cannot outlive it. Only processes this call started are signaled.
 */
export async function runAgent(
  options: AgentRunOptions,
): Promise<AgentRunOutcome> {
  if (options.keep !== undefined) return runKeptAgent(options, options.keep);
  if (options.signal.aborted) {
    return emptyOutcome({ cancelled: true });
  }

  const executablePath = await findCommand(options.command);
  if (executablePath === undefined) {
    return emptyOutcome({ missing: true });
  }

  const clock = options.clock ?? systemClock;
  let watchedLine: (line: string) => void = () => {};
  let onLineOverflow: () => void = () => {};
  const reply = (text: string): boolean => {
    const pipe = child.stdin;
    if (options.interactive !== true || pipe === null || pipe.destroyed) return false;
    pipe.write(`${text}\n`);
    return true;
  };
  const stdoutLines = new Lines(
    (line) => {
      watchedLine(line);
      return options.onLine(line, reply);
    },
    () => onLineOverflow(),
  );
  const stderrTail = new Tail(undefined);

  let errorDirectory: string;
  try {
    errorDirectory = await mkdtemp(join(tmpdir(), "operad-harness-"));
  } catch (error) {
    return emptyOutcome({ spawnError: messageOf(error) });
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
        env: { ...process.env, ...markerEnv() },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  } catch (error) {
    await rm(errorDirectory, { recursive: true, force: true });
    return emptyOutcome({ spawnError: messageOf(error) });
  }

  trackRoot(child.pid);
  // Before the first line is read: a harness with no session handshake is as
  // ready as it will say, so its ready line must not wait for its first output.
  options.onStart?.();
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

  let watchDone = false;
  const watch = watchRun({
    clock,
    wallMs: options.wallMs,
    stallMs: options.stallMs,
    signal: options.signal,
    toolEvent: options.toolEvent,
    finished: () => watchDone,
    beginStop: () => {
      void stop();
    },
    inbox: options.inbox,
    reply,
  });
  watchedLine = (line) => watch.line(line);
  onLineOverflow = () => watch.interrupt("line");
  watch.start();

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
    const stoppingFor = watch.stoppingFor;
    watchDone = true;
    watch.end();
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
    return emptyOutcome({
      exitCode: exit.code,
      signal: exit.signal,
      cancelled: stoppingFor === "cancel",
      wall: stoppingFor === "wall",
      stall: stoppingFor === "stall",
      lineTooLong: stoppingFor === "line",
      spawnError,
      stderrTail: tail,
    });
  }

  readySeen = true;
  openGate();
  reportWorkerStarted();
  watch.listenInbox();

  const ended = await Promise.race<Ended>([
    nextControl().then((line): Ended => {
      const status = endStatus(line);
      return status === undefined
        ? { kind: "closed" }
        : { kind: "end", exit: exitFromStatus(status) };
    }),
    exited.then((exit): Ended => ({ kind: "exit", exit })),
  ]);

  const stoppingFor = watch.stoppingFor;
  watchDone = true;
  watch.end();

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

  return emptyOutcome({
    exitCode: exit.code,
    signal: exit.signal,
    cancelled: stoppingFor === "cancel",
    wall: stoppingFor === "wall",
    stall: stoppingFor === "stall",
    lineTooLong: stoppingFor === "line",
    stderrTail: tail,
  });
}

/** The result line of a worker as far as keeping cares: its name, or undefined. */
function keptResultName(line: string): "done" | "failed" | "cancelled" | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  if (Reflect.get(value, "type") !== "result") return undefined;
  const name: unknown = Reflect.get(value, "result");
  return name === "done" || name === "failed" || name === "cancelled" ? name : undefined;
}

/**
 * Waits a bounded time for a kept worker to record that it is ready for the
 * next reply. A file that exists but cannot be read as a record is not ready:
 * a worker may create the file before it writes the record into it.
 */
export async function keptRecordAppears(
  meta: string,
  options: {
    readonly now?: (() => number) | undefined;
    readonly wait?: ((directory: string, entry: string, ms: number) => Promise<void>) | undefined;
  } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitForChange;
  const deadline = now() + 1_000;
  while (readKeptWorker(meta) === undefined && now() < deadline) {
    await wait(dirname(meta), basename(meta), 25);
  }
}

/**
 * Runs one reply through a worker kept from an earlier reply. Undefined means
 * the worker was not reached or did not answer its first line; the caller then
 * starts a new one, and the old worker has been ended.
 */
async function runKeptSocket(
  record: KeptWorkerRecord,
  options: AgentRunOptions,
  keep: KeptRunOptions,
  clock: Clock,
): Promise<AgentRunOutcome | undefined> {
  const firstLineMs = keep.firstLineMs ?? KEPT_FIRST_LINE_MS;
  const socket: Socket = connect(record.socket);
  const connected = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      resolve(ok);
    };
    const timer = clock.setTimeout(() => finish(false), firstLineMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
  if (!connected) {
    socket.destroy();
    await stopKeptWorker(record, { clock });
    return undefined;
  }

  let firstSeen = false;
  let firstResolve: () => void = () => {};
  const first = new Promise<void>((resolve) => {
    firstResolve = resolve;
  });
  const firstTimer = clock.setTimeout(() => firstResolve(), firstLineMs);
  let resultName: "done" | "failed" | "cancelled" | undefined;
  let resultResolve: () => void = () => {};
  const result = new Promise<void>((resolve) => {
    resultResolve = resolve;
  });
  let closedResolve: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    closedResolve = resolve;
  });
  const stopWorker = async (): Promise<void> => {
    if (socket.destroyed) {
      await stopKeptWorker(record, { clock });
      return;
    }
    socket.destroy();
    await stopKeptWorker(record, { clock });
  };
  const reply = (text: string): void => {
    if (!socket.destroyed) socket.write(`${text}\n`);
  };
  let watchDone = false;
  const watch = watchRun({
    clock,
    wallMs: options.wallMs,
    stallMs: options.stallMs,
    signal: options.signal,
    toolEvent: options.toolEvent,
    finished: () => watchDone,
    beginStop: () => {
      void stopWorker();
    },
    inbox: options.inbox,
    reply,
  });
  const lines = new Lines(
    async (line) => {
      if (!firstSeen) {
        firstSeen = true;
        clock.clearTimeout(firstTimer);
        firstResolve();
      }
      watch.line(line);
      await options.onLine(line, reply);
      const name = keptResultName(line);
      if (name !== undefined && resultName === undefined) {
        resultName = name;
        resultResolve();
      }
    },
    () => watch.interrupt("line"),
  );
  socket.once("close", () => {
    closedResolve();
    if (!firstSeen) firstResolve();
  });
  socket.once("error", () => {
    closedResolve();
    if (!firstSeen) firstResolve();
  });
  const drained = consume(socket, lines);

  watch.listenInbox();
  socket.write(`${options.stdin ?? ""}\n`);
  options.onStart?.();
  watch.start();

  const started = await Promise.race<"line" | "closed">([
    first.then(() => (firstSeen ? "line" : "closed")),
    closed.then(() => "closed"),
  ]);
  if (started !== "line" || !firstSeen) {
    watchDone = true;
    watch.end();
    clock.clearTimeout(firstTimer);
    await stopWorker();
    socket.destroy();
    await drained;
    return undefined;
  }

  await Promise.race([result, closed]);
  if (resultName === undefined && watch.stoppingFor === undefined) {
    // A close often arrives just before the last line has been handed over.
    await drained;
  }
  const stoppingFor = watch.stoppingFor;
  watchDone = true;
  watch.end();
  clock.clearTimeout(firstTimer);
  socket.destroy();
  await drained;

  if (resultName === "done") {
    return emptyOutcome({ exitCode: 0 });
  }
  await stopKeptWorker(record, { clock });
  if (resultName !== undefined) {
    return emptyOutcome({ exitCode: resultName === "failed" ? 1 : 143, ...stoppedOutcome(stoppingFor) });
  }
  return emptyOutcome(stoppedOutcome(stoppingFor));
}

/** Starts a new worker that will stay after a done reply. */
async function runKeptFresh(
  options: AgentRunOptions,
  keep: KeptRunOptions,
  clock: Clock,
): Promise<AgentRunOutcome> {
  const executablePath = await findCommand(options.command);
  if (executablePath === undefined) return emptyOutcome({ missing: true });
  const slot = newKeptWorkerSlot(keep.home, keep.name);
  const env: NodeJS.ProcessEnv = { ...process.env };
  // A kept worker is not a left-over of the run that started it: no run marker.
  delete env["OPERAD_RUN"];
  delete env["OPERAD_RUN_HOME"];

  let child: ChildProcess;
  try {
    child = spawn(executablePath, [...options.args, keptWorkerArgument(slot.token)], {
      cwd: options.cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return emptyOutcome({ spawnError: messageOf(error) });
  }
  child.unref();

  const stdout = child.stdout;
  const stderr = child.stderr;
  const stderrTail = new Tail(undefined);
  let resultName: "done" | "failed" | "cancelled" | undefined;
  let resultResolve: () => void = () => {};
  const result = new Promise<void>((resolve) => {
    resultResolve = resolve;
  });
  let exitedResolve: (exit: Exit) => void = () => {};
  const exited = new Promise<Exit>((resolve) => {
    exitedResolve = resolve;
  });
  let spawnResolve: (message: string) => void = () => {};
  const spawnFailed = new Promise<string>((resolve) => {
    spawnResolve = resolve;
  });

  const stopWorker = async (): Promise<void> => {
    const pid = child.pid;
    if (pid === undefined) return;
    killProcessGroup(pid, "SIGTERM");
    await clock.sleep(KILL_GRACE_MS);
    killProcessGroup(pid, "SIGKILL");
    await stopKeptWorker(
      {
        pid,
        token: slot.token,
        scope: keep.scope,
        key: keep.key,
        socket: slot.socket,
        meta: slot.meta,
        session: null,
        startedAt: 0,
        lastUsedAt: 0,
      },
      { clock },
    );
  };
  const reply = (text: string): void => {
    if (child.stdin !== null && !child.stdin.destroyed) child.stdin.write(`${text}\n`);
  };
  let watchDone = false;
  const watch = watchRun({
    clock,
    wallMs: options.wallMs,
    stallMs: options.stallMs,
    signal: options.signal,
    toolEvent: options.toolEvent,
    finished: () => watchDone,
    beginStop: () => {
      void stopWorker();
    },
    inbox: options.inbox,
    reply,
  });
  let outputDrained: Promise<void> = Promise.resolve();
  if (stdout !== null) {
    const lines = new Lines(
      async (line) => {
        watch.line(line);
        await options.onLine(line, reply);
        const name = keptResultName(line);
        if (name !== undefined && resultName === undefined) {
          resultName = name;
          resultResolve();
        }
      },
      () => watch.interrupt("line"),
    );
    outputDrained = consume(stdout, lines).then(() => lines.end());
  }
  const drainStderr =
    stderr === null
      ? Promise.resolve()
      : (async () => {
          const decoder = new TextDecoder();
          try {
            for await (const chunk of stderr) stderrTail.push(decoder.decode(chunk as Uint8Array, { stream: true }));
          } catch {
            // A process that failed to start has no stderr.
          }
        })();

  child.once("error", (error) => spawnResolve(messageOf(error)));
  child.once("exit", (code, signal) => exitedResolve({ code, signal }));
  if (child.stdin !== null) child.stdin.on("error", () => undefined);
  watch.listenInbox();
  // The first input tells the worker where its socket and record are, so it can
  // stay after this reply. A reused worker ignores this field.
  let firstInput = options.stdin ?? "";
  try {
    const value: unknown = JSON.parse(firstInput);
    if (isRecord(value)) {
      firstInput = JSON.stringify({
        ...value,
        keep: {
          socket: slot.socket,
          meta: slot.meta,
          token: slot.token,
          scope: keep.scope,
          key: keep.key,
          timeoutMs: keep.timeoutMs ?? KEPT_WORKER_MS,
        },
      });
    }
  } catch {
    // Not JSON: the worker will report invalid input as it always did.
  }
  reply(firstInput);
  options.onStart?.();
  watch.start();

  const settled = await Promise.race<"result" | "exit" | "error">([
    result.then(() => "result" as const),
    exited.then(() => "exit" as const),
    spawnFailed.then(() => "error" as const),
  ]);
  if (settled === "exit" && resultName === undefined) await outputDrained;
  const stoppingFor = watch.stoppingFor;
  watchDone = true;
  watch.end();

  if (settled === "error") {
    const spawnError = await spawnFailed;
    await stopWorker();
    return emptyOutcome({ spawnError });
  }

  if (settled === "result" && resultName === "done") {
    // The worker writes its record after the Result; the next message must find it.
    await keptRecordAppears(slot.meta);
    // Two replies can finish at once in one home: the cap holds after the
    // record is there too, not only before a worker is started.
    await trimKept(keep, clock, (count, max) => count > max);
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    return emptyOutcome({ exitCode: 0 });
  }

  const exit = settled === "exit" ? await exited : await Promise.race<Exit | undefined>([exited, Promise.resolve(undefined)]);
  if (resultName !== undefined) {
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    await stopWorker();
    return emptyOutcome({
      exitCode: resultName === "failed" ? 1 : 143,
      ...stoppedOutcome(stoppingFor),
    });
  }
  await stopWorker();
  await drainStderr;
  return emptyOutcome({
    exitCode: exit?.code ?? null,
    signal: exit?.signal ?? null,
    ...stoppedOutcome(stoppingFor),
    stderrTail: stderrTail.lines(20),
  });
}

/** Chooses, ends and starts kept workers for one reply. */
async function runKeptAgent(options: AgentRunOptions, keep: KeptRunOptions): Promise<AgentRunOutcome> {
  if (options.signal.aborted) return emptyOutcome({ cancelled: true });
  const clock = options.clock ?? systemClock;
  const records = readKeptWorkers(keep.home, keep.name);
  const sameScope = records.filter((record) => record.scope === keep.scope);
  // A worker started with another model, effort, directory, profile or skills
  // no longer holds; end it before this reply starts a new one.
  for (const record of sameScope.filter((record) => record.key !== keep.key)) {
    await stopKeptWorker(record, { clock });
  }
  const candidates = sameScope
    .filter((record) => record.key === keep.key)
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt);
  for (const record of candidates) {
    const outcome = await runKeptSocket(record, options, keep, clock);
    if (outcome !== undefined) return outcome;
  }

  // A new worker is the fourth only after the one idle longest has ended.
  await trimKept(keep, clock, (count, max) => count >= max);
  return runKeptFresh(options, keep, clock);
}
