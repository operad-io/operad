/**
 * Process groups. A plugin that runs a command starts it in a process group of
 * its own and stops only the group it started. This module holds the pieces
 * that took several review rounds to get right: the sentinel that leads the
 * group, the control pipe it reports on, and the stop that signals the group
 * with TERM and then KILL. `runLine` is the whole thing for one shell line; the
 * helpers it is built from are exported for a plugin that streams a command's
 * output its own way. Nothing here runs in the kernel.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import { Readable } from "node:stream";
import { messageOf } from "../plugin/errors.ts";
import type { PluginLogger } from "../plugin/types.ts";
import { markerEnv, trackRoot } from "./step-reap.ts";

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
 * The sentinel also watches the process that started it (`$2`), from a helper
 * that runs beside the line: if the host is killed before it can stop the
 * group, the helper kills the whole group, line included, instead of leaving
 * both to run on for a host that is gone. The check must not wait for the line
 * to end, because the line may be the thing that never does.
 *
 * The control pipe is the sentinel's stderr; the line gets stderr redirected to
 * its stdout, so the two channels never mix. The line cannot write to the
 * control channel, and a reader that does not know a line ignores it.
 */
const SENTINEL = [
  "trap ':' TERM",
  // The helper's output goes nowhere, so it never holds the control pipe open.
  // The numeric group form is POSIX; dash does not accept `--` before it.
  '( while kill -0 "$2" 2>/dev/null; do sleep 1; done; kill -KILL -$$ ) >/dev/null 2>&1 &',
  "printf 'ready\\n' >&2",
  'sh -c "$1" 2>&1',
  "status=$?",
  "printf 'end %s\\n' \"$status\" >&2",
  'while kill -0 "$2" 2>/dev/null; do sleep 1 2>/dev/null; done',
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
  /**
   * Test-only seam: replaces the sentinel script, so a test can delay the
   * `ready` announcement and exercise a stop that arrives before it. A
   * production run never sets it.
   */
  readonly sentinelScript?: string | undefined;
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

export interface Exit {
  readonly code: number | null;
  readonly signal: string | null;
}

/** The first line the sentinel writes: it is ready, or the shell is gone. */
export type Startup =
  | { readonly kind: "ready" }
  | { readonly kind: "closed" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "exit"; readonly exit: Exit };

/** How the line's own shell ended. */
export type Ended =
  | { readonly kind: "end"; readonly exit: Exit }
  | { readonly kind: "exit"; readonly exit: Exit }
  | { readonly kind: "closed" };

/**
 * The status a shell reports for a line that a signal ended: 128 plus the
 * signal number. A line that exits with such a code on purpose reads the same.
 */
export function exitFromStatus(status: number | null): Exit {
  if (status === null) return { code: null, signal: null };
  // The shell keeps only one number, so a line that exits 130 on purpose and
  // one killed by SIGINT read the same. The exit code is the fact's own
  // value; the signal is what that number would name, recorded beside it.
  if (status > 128) {
    const signal = SIGNALS_BY_NUMBER.get(status - 128);
    return { code: status, signal: signal ?? null };
  }
  return { code: status, signal: null };
}

/** The exit status in a sentinel `end <status>` line, if that is what it is. */
export function endStatus(line: string | null): number | undefined {
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
export class ControlReader {
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
    // Resolve a pending read: `stream.destroy()` may only emit `close` later,
    // and a waiter left until then would never settle.
    this.finish();
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

/** Sends a signal to a whole process group. False when it could not. */
export function killProcessGroup(
  pgid: number,
  signal: NodeJS.Signals | 0,
): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

/** What the stop of one sentinel-led group reads while it runs. */
export interface GroupStopOptions {
  readonly clock: Clock;
  /** Sends a signal to one process group; a test replaces it to watch signals. */
  readonly killGroup: (pgid: number, signal: NodeJS.Signals | 0) => boolean;
  /** The sentinel's pid, which is the group id. */
  readonly pid: () => number | undefined;
  readonly sentinelExited: () => boolean;
  /** True once the sentinel announced that its TERM trap is installed. */
  readonly readySeen: () => boolean;
  /** Settles when the sentinel announces `ready`. */
  readonly ready: Promise<void>;
  /**
   * True while any process is left in the group. The default asks the kernel
   * with signal 0; a test replaces it. Not routed through `killGroup`, so a
   * test that records signals sees only the TERM and KILL that were sent.
   */
  readonly groupExists?: ((pgid: number) => boolean) | undefined;
  /** Waits a moment, in real time, between two sweeps of the group. Blocks. */
  readonly pause?: (() => void) | undefined;
}

/** How often the last SIGKILL is repeated for a straggler, and the wait between. */
export const SWEEP_ATTEMPTS = 50;
export const SWEEP_PAUSE_MS = 1;

/**
 * Repeats SIGKILL while the group still has a member. A signal to a group
 * reaches the processes that exist when it is delivered: a shell that forks at
 * that instant leaves a child the signal missed, which then holds the line's
 * output open for as long as it runs (a `sleep 30` outlived a cancelled line
 * and the run waited for it).
 *
 * The group id is safe to signal only while its leader still owns it. The
 * killed leader stays a zombie until the event loop reaps it, so the whole
 * sweep is one synchronous step, with no yield: no exit event is handled
 * inside it, the id cannot have been freed and reused, and every signal goes
 * to the line's own group. The check below covers a leader reaped earlier.
 */
function sweep(pgid: number, options: GroupStopOptions): void {
  const exists = options.groupExists ?? groupExists;
  const pause = options.pause ?? sleepSync;
  for (let attempt = 0; attempt < SWEEP_ATTEMPTS; attempt += 1) {
    // A kill of the group can take a moment to show; look after a pause.
    pause();
    if (options.sentinelExited() || !exists(pgid)) return;
    options.killGroup(pgid, "SIGKILL");
  }
}

/** Blocks the thread for one sweep pause. */
function sleepSync(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SWEEP_PAUSE_MS);
}

/** True while the kernel still has a process in the group. */
function groupExists(pgid: number): boolean {
  return killProcessGroup(pgid, 0);
}

/**
 * Returns the stop of a sentinel-led group: SIGTERM, then SIGKILL after the
 * grace period. It runs once; every later call returns the same promise. A
 * signal before `ready` could reach the sentinel before it ignores TERM, so the
 * stop waits for the announcement, bounded by the same grace.
 */
export function createGroupStop(options: GroupStopOptions): () => Promise<void> {
  let stopping: Promise<void> | undefined;
  return () => {
    stopping ??= (async () => {
      if (options.sentinelExited()) return;
      const pid = options.pid();
      // A spawn that never produced a process has no group to signal or wait
      // for; returning here keeps a failed spawn from paying the grace.
      if (pid === undefined) return;
      let ready = true;
      if (!options.readySeen()) {
        const outcome = await Promise.race<"ready" | "grace">([
          options.ready.then(() => "ready"),
          options.clock.sleep(KILL_GRACE_MS).then(() => "grace"),
        ]);
        ready = outcome === "ready";
      }
      if (options.sentinelExited()) return;
      if (!ready) {
        // The sentinel never announced its trap. There is no safe delay: one
        // immediate SIGKILL while our leader is still alive is the only signal.
        if (options.killGroup(pid, "SIGKILL")) sweep(pid, options);
        return;
      }
      if (!options.killGroup(pid, "SIGTERM")) return;
      await options.clock.sleep(KILL_GRACE_MS);
      // The sentinel ignores SIGTERM, so its group id is still this command's
      // unless it exited, in which case nothing is signaled at all.
      if (options.sentinelExited()) return;
      // A SIGKILL that found no group means the leader is gone and the id may
      // already be someone else's: sweeping then would signal a stranger.
      if (options.killGroup(pid, "SIGKILL")) sweep(pid, options);
    })();
    return stopping;
  };
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
    child = spawn(
      "sh",
      [
        "-c",
        options.sentinelScript ?? SENTINEL,
        "operad-shell",
        options.line,
        String(process.pid),
      ],
      {
        cwd: options.cwd,
        env: { ...process.env, ...markerEnv(), ...options.env },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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

  trackRoot(child.pid);
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
    let drainTimer: unknown;
    const drainLimit = new Promise<void>((resolve) => {
      drainTimer = clock.setTimeout(resolve, DRAIN_GRACE_MS);
    });
    await Promise.race([drainedOutput, drainLimit]);
    if (drainTimer !== undefined) clock.clearTimeout(drainTimer);
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

  // One read serves the race and, if the shell's exit wins it, the look for
  // the record afterwards: a second read would queue behind this one and miss
  // the line it takes.
  const endRead = nextControl();
  const ended = await Promise.race<Ended>([
    endRead.then((line): Ended => {
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
  if (ended.kind === "end") exit = ended.exit;
  else {
    // A control pipe that closed with the sentinel still alive leaves nothing
    // that would end it: stop the group before waiting for an exit.
    if (ended.kind === "closed") await stop();
    // The shell's exit event can arrive before the end record it wrote has been
    // read. The record holds the line's own status, so read the pipe to its
    // close before settling for the shell's exit: a deliberate nonzero status
    // must not turn into the shell's own.
    const record = endStatus(await endRead);
    exit = record === undefined ? await exited : exitFromStatus(record);
  }

  // Stop the group the line left behind: the sentinel and any forked child.
  // A line that reported its own status has already ended, so there is nothing
  // left to give SIGTERM time for; waiting the grace here made every successful
  // line pay 500 ms. A cancellation or timeout still takes the TERM path.
  if (ended.kind === "end" && !cancelled && !timedOut) {
    const pid = child.pid;
    if (pid !== undefined) (options.killGroup ?? killProcessGroup)(pid, "SIGKILL");
  } else {
    await stop();
  }
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
