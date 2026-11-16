/**
 * The line channel of a harness child and the part of its life that serves
 * more than one reply.
 *
 * Every harness worker reads one JSON object from stdin, answers with JSON
 * lines, and may be kept after a done reply. The socket, the record, the idle
 * timer and the stop request are the same for every harness; only the program
 * that runs one prompt and the shape of its Result differ, so those are the
 * adapter this module calls.
 */

import { createHash } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import {
  removeKeptWorker,
  writeKeptWorker,
} from "@operad-io/engine/platform";
import { messageText } from "./inbox.ts";
import type { CallAnswer } from "./ask-call.ts";

export const EXIT_FAILED = 1;
export const EXIT_INVALID_INPUT = 2;
export const EXIT_CANCELLED = 143;


/** A stable JSON value: object keys sorted, arrays in order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(Reflect.get(value, key))]),
    );
  }
  return value;
}

/**
 * What a worker is started with, apart from one reply: a worker started with
 * another model, effort, directory, access profile, skills or MCP servers is
 * not the same worker. One-time grants and the prompt belong to a reply, so
 * they do not name the worker.
 */
export function keepKeyOf(config: Readonly<Record<string, unknown>>): string {
  const { prompt: _prompt, images: _images, resumeSession: _resume, ...rest } = config;
  const accessValue = rest["access"];
  const access =
    typeof accessValue === "object" && accessValue !== null
      ? { ...(accessValue as Record<string, unknown>) }
      : accessValue;
  if (typeof access === "object" && access !== null) {
    delete (access as Record<string, unknown>)["grants"];
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical({ ...rest, access })))
    .digest("hex");
}

/** How a chat worker stays reachable for its next prompt. */
export interface WorkerKeep {
  readonly socket: string;
  readonly meta: string;
  readonly token: string;
  readonly scope: string;
  readonly key: string;
  /** How long the worker stays after a reply before it ends itself. */
  readonly timeoutMs: number;
}

/** Where the program talks to the world; the process entry points them at stdout and stderr. */
export interface WorkerPorts {
  write(text: string): void;
  log(text: string): void;
}

/** Where the program writes. Lines are written whole, in order. */
export interface WorkerIo<TLine = unknown> {
  line(line: TLine): void;
  /** Free text for humans; never parsed. */
  log(text: string): void;
  /**
   * Asks the host to use up a one-time permission. True when it did and the
   * call may run. Absent when the host cannot answer; no grant then applies.
   */
  useGrant?(waitId: string): Promise<boolean>;
  /**
   * Asks the host to ask a person whether one call may run, and resolves with
   * the answer. Absent when the host cannot answer; a call that must ask is then
   * refused.
   */
  ask?(call: {
    readonly kind: "command" | "path";
    readonly value: string;
    readonly tool?: string;
    readonly shown: string;
    readonly session: string | null;
  }): Promise<CallAnswer>;
  /**
   * Hands each message the host sends mid-run to `handler`, those that came
   * before the call first. Absent when the host cannot send any.
   */
  onMessage?(handler: (text: string) => void): void;
}

export type ParsedInput<TInput> =
  | { readonly ok: true; readonly input: TInput }
  | { readonly ok: false; readonly message: string };

/** What a harness supplies; everything else is the same for every worker. */
export interface WorkerAdapter<TInput> {
  /** Reads the program's input shape; the message names the field at fault. */
  parse(text: string): ParsedInput<TInput>;
  /** The line an invalid input writes. */
  invalidInput(message: string): unknown;
  /** The line the program writes when the harness itself failed. */
  error(message: string): unknown;
  /** The keep request in an input, if it asks for one. */
  keep(input: TInput): WorkerKeep | undefined;
  /** Runs one reply and writes its lines; returns the exit code. */
  run(input: TInput, io: WorkerIo<unknown>, cancel: AbortSignal): Promise<number>;
  /** Releases what outlives one reply, when this worker process ends. */
  close?(): void;
  /** The session the next reply continues, as the kept record reports it. */
  session?(): string | null;
  /** Remembers the session a done reply reports. */
  setSession?(session: string | null): void;
  /** Called when the kept session ends by itself, so the worker can leave too. */
  onEnded?(handler: (code: number) => void): void;
}

/** One Result line as far as keeping cares: its name and session. */
interface KeptResult {
  readonly result: "done" | "failed" | "cancelled";
  readonly sessionId: string | null;
}

function keptResultOf(line: unknown): KeptResult | undefined {
  if (typeof line !== "object" || line === null) return undefined;
  if (Reflect.get(line, "type") !== "result") return undefined;
  const name: unknown = Reflect.get(line, "result");
  if (name !== "done" && name !== "failed" && name !== "cancelled") return undefined;
  const session: unknown = Reflect.get(line, "sessionId");
  return { result: name, sessionId: typeof session === "string" ? session : null };
}

/** Wraps an io and remembers the last Result written through it. */
class Capture implements WorkerIo<unknown> {
  private last: KeptResult | undefined;

  constructor(private readonly inner: WorkerIo<unknown>) {}

  get result(): KeptResult | undefined {
    return this.last;
  }

  line(line: unknown): void {
    const result = keptResultOf(line);
    if (result !== undefined) this.last = result;
    this.inner.line(line);
  }

  log(text: string): void {
    this.inner.log(text);
  }

  useGrant = (waitId: string): Promise<boolean> => {
    return this.inner.useGrant?.(waitId) ?? Promise.resolve(false);
  };

  ask = (call: Parameters<NonNullable<WorkerIo["ask"]>>[0]): Promise<CallAnswer> => {
    return this.inner.ask?.(call) ?? Promise.resolve({ decision: "deny", reason: "the host cannot ask" });
  };

  onMessage = (handler: (text: string) => void): void => {
    this.inner.onMessage?.(handler);
  };
}

/**
 * Stdin or a socket as lines. The first line is the input; later lines are the
 * host's answers.
 */
class StdinLines {
  readonly #reader: AsyncIterator<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #done = false;

  constructor(stream: AsyncIterable<Uint8Array>) {
    this.#reader = stream[Symbol.asyncIterator]();
  }

  /** Stops reading; a read that waits ends as if stdin had ended. */
  close(): void {
    void this.#reader.return?.()?.catch(() => undefined);
  }

  async #more(): Promise<boolean> {
    if (this.#done) return false;
    const chunk = await this.#reader.next();
    if (chunk.done) {
      this.#done = true;
      this.#buffer += this.#decoder.decode();
      return false;
    }
    this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
    return true;
  }

  /** The next line, or what is left at the end of the stream; undefined when nothing is. */
  async next(): Promise<string | undefined> {
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline !== -1) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.trim().length === 0) continue;
        return line;
      }
      if (!(await this.#more())) {
        const rest = this.#buffer;
        this.#buffer = "";
        return rest.trim().length === 0 ? undefined : rest;
      }
    }
  }

  async first(): Promise<string> {
    return (await this.next()) ?? "";
  }
}

/** One line channel of a worker: stdin for the first reply, a socket for a kept one. */
export class Channel<TLine = unknown> {
  readonly io: WorkerIo<TLine>;
  private readonly lines: StdinLines;
  private readonly waiting = new Map<number, (used: boolean) => void>();
  private readonly questions = new Map<number, (answer: CallAnswer) => void>();
  private readonly early: string[] = [];
  private readonly onGone: (() => void) | undefined;
  private onMessage: ((text: string) => void) | undefined;
  private nextAsk = 1;
  private nextGrant = 1;
  private hostGone = false;
  private started = false;

  constructor(
    stream: AsyncIterable<Uint8Array>,
    ports: WorkerPorts,
    onGone?: (() => void) | undefined,
  ) {
    this.lines = new StdinLines(stream);
    this.onGone = onGone;
    const write = ports.write;
    this.io = {
      line: (line) => write(`${JSON.stringify(line)}\n`),
      onMessage: (handler) => {
        this.onMessage = handler;
        for (const text of this.early.splice(0)) handler(text);
      },
      log: (text) => ports.log(text),
      useGrant: (waitId) =>
        new Promise<boolean>((resolve) => {
          if (this.hostGone) {
            resolve(false);
            return;
          }
          const id = this.nextGrant;
          this.nextGrant += 1;
          this.waiting.set(id, resolve);
          write(`${JSON.stringify({ type: "grant_use", id, waitId })}\n`);
        }),
      ask: (call) =>
        new Promise<CallAnswer>((resolve) => {
          if (this.hostGone) {
            resolve({ decision: "deny", reason: "the host is gone" });
            return;
          }
          const id = this.nextAsk;
          this.nextAsk += 1;
          this.questions.set(id, (answer) => {
            // The line that closes the question, so the host's stall timer runs again.
            write(`${JSON.stringify({ type: "ask_resolved", id })}\n`);
            resolve(answer);
          });
          write(`${JSON.stringify({ type: "ask_call", id, ...call })}\n`);
        }),
    };
  }

  /** The first line, read before the host may send answers or messages. */
  next(): Promise<string | undefined> {
    return this.lines.next();
  }

  /** Starts taking the host's later lines. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.#read();
  }

  close(): void {
    this.lines.close();
    this.#gone();
  }

  async #read(): Promise<void> {
    for (;;) {
      const line = await this.lines.next();
      if (line === undefined) break;
      const said = messageText(line);
      if (said !== undefined) {
        if (this.onMessage === undefined) this.early.push(said);
        else this.onMessage(said);
        continue;
      }
      try {
        const ack: unknown = JSON.parse(line);
        if (typeof ack === "object" && ack !== null && Reflect.get(ack, "type") === "ask_ack") {
          const id: unknown = Reflect.get(ack, "id");
          const decision: unknown = Reflect.get(ack, "decision");
          const reason: unknown = Reflect.get(ack, "reason");
          if (typeof id === "number") {
            this.questions.get(id)?.({
              decision: decision === "allow" || decision === "stop" ? decision : "deny",
              ...(typeof reason === "string" ? { reason } : {}),
            });
            this.questions.delete(id);
          }
        }
        if (typeof ack === "object" && ack !== null && Reflect.get(ack, "type") === "grant_ack") {
          const id: unknown = Reflect.get(ack, "id");
          const used: unknown = Reflect.get(ack, "used");
          if (typeof id === "number") {
            this.waiting.get(id)?.(used === true);
            this.waiting.delete(id);
          }
        }
      } catch {
        // Not a line the program understands; it is ignored.
      }
    }
    this.#gone();
  }

  #gone(): void {
    if (this.hostGone) return;
    this.hostGone = true;
    for (const resolve of this.waiting.values()) resolve(false);
    this.waiting.clear();
    for (const resolve of this.questions.values()) resolve({ decision: "deny", reason: "the host is gone" });
    this.questions.clear();
    this.onGone?.();
  }
}

/** Runs one reply from stdin and stops; the program is not kept. */
export async function serveOne<TInput>(
  stdinStream: AsyncIterable<Uint8Array>,
  ports: WorkerPorts,
  cancel: AbortSignal,
  adapter: WorkerAdapter<TInput>,
): Promise<number> {
  const channel = new Channel(stdinStream, ports);
  let code: number;
  try {
    const text = await channel.next();
    const parsed = adapter.parse(text ?? "");
    if (!parsed.ok) {
      channel.io.line(adapter.invalidInput(parsed.message));
      code = EXIT_INVALID_INPUT;
    } else {
      channel.start();
      code = await adapter.run(parsed.input, channel.io, cancel);
    }
  } catch (error) {
    channel.io.log(error instanceof Error ? (error.stack ?? error.message) : String(error));
    channel.io.line(adapter.error(error instanceof Error ? error.message : String(error)));
    code = EXIT_FAILED;
  }
  channel.close();
  adapter.close?.();
  return code;
}

/**
 * Runs the first reply from stdin and, when the reply was done and asked for
 * keeping, serves later replies from a socket in the operad home. The worker's
 * own timer ends it after the kept time; a failed, stopped or interrupted reply
 * leaves no kept worker.
 */
export async function serveKeptWorker<TInput>(
  stdinStream: AsyncIterable<Uint8Array>,
  ports: WorkerPorts,
  cancel: AbortSignal,
  adapter: WorkerAdapter<TInput>,
): Promise<number> {
  const channel = new Channel(stdinStream, ports);
  let code: number;
  try {
    const text = await channel.next();
    const parsed = adapter.parse(text ?? "");
    if (!parsed.ok) {
      channel.io.line(adapter.invalidInput(parsed.message));
      code = EXIT_INVALID_INPUT;
    } else {
      channel.start();
      const capture = new Capture(channel.io);
      code = await adapter.run(parsed.input, capture, cancel);
      channel.close();
      const keep = adapter.keep(parsed.input);
      const result = capture.result;
      if (keep !== undefined && result?.result === "done") {
        adapter.setSession?.(result.sessionId);
        return await serveKept(keep, ports, cancel, adapter);
      }
    }
  } catch (error) {
    channel.io.log(error instanceof Error ? (error.stack ?? error.message) : String(error));
    channel.io.line(adapter.error(error instanceof Error ? error.message : String(error)));
    code = EXIT_FAILED;
  }
  channel.close();
  adapter.close?.();
  return code;
}

/** The kept part of a worker's life: one socket, one reply at a time, its own timer. */
async function serveKept<TInput>(
  keep: WorkerKeep,
  ports: WorkerPorts,
  cancel: AbortSignal,
  adapter: WorkerAdapter<TInput>,
): Promise<number> {
  const startedAt = Date.now();
  let session = adapter.session?.() ?? null;
  let lastUsedAt = startedAt;
  let busy = false;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let server: ReturnType<typeof createServer> | undefined;

  const record = () => ({
    pid: process.pid,
    token: keep.token,
    scope: keep.scope,
    key: keep.key,
    socket: keep.socket,
    meta: keep.meta,
    session,
    startedAt,
    lastUsedAt,
    ...(busy ? { busy: true } : {}),
  });
  const save = (): void => {
    try {
      writeKeptWorker(record());
    } catch {
      // A record that cannot be written means the next reply starts a new worker.
    }
  };
  const shutdown = (code: number): void => {
    if (stopping) return;
    stopping = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    server?.close();
    removeKeptWorker({ meta: keep.meta, socket: keep.socket });
    adapter.close?.();
    process.exit(code);
  };
  const idle = (): void => {
    if (stopping) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => shutdown(0), keep.timeoutMs);
  };

  rmSync(keep.meta, { force: true });
  rmSync(keep.socket, { force: true });

  const handle = async (socket: Socket): Promise<void> => {
    if (stopping) {
      socket.destroy();
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const connection = new AbortController();
    const channel = new Channel(
      socket,
      {
        write: (text) => {
          if (!socket.destroyed) socket.write(text);
        },
        log: ports.log,
      },
      () => connection.abort(),
    );
    try {
      const first = await channel.next();
      if (first === undefined) {
        channel.close();
        idle();
        return;
      }
      let command: unknown;
      try {
        command = JSON.parse(first);
      } catch {
        command = undefined;
      }
      if (
        typeof command === "object" &&
        command !== null &&
        Reflect.get(command, "type") === "stop"
      ) {
        channel.close();
        socket.end();
        shutdown(0);
        return;
      }
      const parsed = adapter.parse(first);
      if (!parsed.ok) {
        channel.io.line(adapter.invalidInput(parsed.message));
        channel.close();
        socket.end();
        idle();
        return;
      }
      busy = true;
      save();
      channel.start();
      const capture = new Capture(channel.io);
      let code = EXIT_FAILED;
      try {
        code = await adapter.run(
          parsed.input,
          capture,
          AbortSignal.any([cancel, connection.signal]),
        );
      } catch (error) {
        channel.io.log(error instanceof Error ? (error.stack ?? error.message) : String(error));
        channel.io.line(adapter.error(error instanceof Error ? error.message : String(error)));
      }
      channel.close();
      if (!socket.destroyed) socket.end();
      busy = false;
      lastUsedAt = Date.now();
      const result = capture.result;
      if (result?.result === "done") {
        session = result.sessionId ?? session;
        adapter.setSession?.(session);
        save();
        idle();
      } else {
        shutdown(code);
      }
    } catch (error) {
      ports.log(error instanceof Error ? (error.stack ?? error.message) : String(error));
      channel.close();
      socket.destroy();
      idle();
    }
  };

  let chain: Promise<void> = Promise.resolve();
  server = createServer((socket) => {
    chain = chain.then(
      () => handle(socket),
      () => handle(socket),
    );
  });
  await new Promise<void>((resolve, reject) => {
    if (server === undefined) {
      reject(new Error("the kept worker has no server"));
      return;
    }
    server.once("error", reject);
    server.listen(keep.socket, () => resolve());
  });
  chmodSync(keep.socket, 0o600);
  save();
  idle();
  adapter.onEnded?.((code) => shutdown(code));
  cancel.addEventListener(
    "abort",
    () => {
      if (!busy) shutdown(EXIT_CANCELLED);
    },
    { once: true },
  );
  return await new Promise<number>(() => undefined);
}
