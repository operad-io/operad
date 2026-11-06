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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * Runs one line. Cancellation and the timeout signal the process group with
 * SIGTERM and, after the grace period, SIGKILL. The group is always stopped
 * after the main process exits too, so a child it forked cannot outlive it.
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

  const output = new Output(options.logger);
  let child: ChildProcess;
  try {
    child = spawn("sh", ["-c", options.line], {
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
  const signalGroup = (signal: NodeJS.Signals): boolean => {
    const pid = child.pid;
    if (pid === undefined) return false;
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  };
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      if (!signalGroup("SIGTERM")) return;
      await delay(KILL_GRACE_MS);
      signalGroup("SIGKILL");
    })();
    return stopping;
  };

  let timedOut = false;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      void stop();
    }, options.timeoutMs);
  }
  const onAbort = (): void => {
    cancelled = true;
    void stop();
  };
  options.signal.addEventListener("abort", onAbort, { once: true });

  const first = await Promise.race<First>([
    exited.then((value) => ({ kind: "exit", value })),
    failed.then((message) => ({ kind: "error", message })),
  ]);

  if (timer !== undefined) clearTimeout(timer);
  options.signal.removeEventListener("abort", onAbort);

  // The main process is done; stop whatever it left behind in the group.
  await stop();
  await Promise.all(drained);
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
