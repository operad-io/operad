/**
 * An MCP server in this process: the same request handling the stdio program
 * runs, with an in-memory input and a captured output. A test that needs a real
 * process starts one itself.
 */

import { runMcpServer } from "../src/server.ts";

/** Output lines the server wrote, with a wait for the next one. */
export class Lines {
  readonly seen: string[] = [];
  private readonly queue: string[] = [];
  private readonly waiting: ((line: string | undefined) => void)[] = [];
  private ended = false;

  push(text: string): void {
    let start = 0;
    for (;;) {
      const at = text.indexOf("\n", start);
      if (at < 0) break;
      const line = text.slice(start, at);
      start = at + 1;
      if (line.length > 0) this.emit(line);
    }
  }

  end(): void {
    this.ended = true;
    for (const resolve of this.waiting.splice(0)) resolve(undefined);
  }

  next(timeoutMs = 10_000): Promise<string> {
    const line = this.queue.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.ended) return Promise.reject(new Error("the server closed its output"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("the server did not answer"));
      }, timeoutMs);
      this.waiting.push((value) => {
        clearTimeout(timer);
        if (value === undefined) reject(new Error("the server closed its output"));
        else resolve(value);
      });
    });
  }

  private emit(line: string): void {
    this.seen.push(line);
    const resolve = this.waiting.shift();
    if (resolve !== undefined) resolve(line);
    else this.queue.push(line);
  }
}

/** Where an in-process session writes and what it reports. */
export interface SessionOptions {
  readonly home: string;
  readonly cwd?: string | undefined;
  readonly claudeChannel?: boolean | undefined;
  readonly types?: readonly string[] | undefined;
}

/** A server opened in this process, driven one request at a time. */
export class Session {
  readonly lines = new Lines();
  readonly errors: string[] = [];
  private readonly queued: string[] = [];
  private readonly waiting: ((text: string | undefined) => void)[] = [];
  private ended = false;
  private readonly finished: Promise<void>;

  constructor(options: SessionOptions) {
    this.finished = runMcpServer({
      home: options.home,
      cwd: options.cwd ?? options.home,
      input: this.input(),
      write: (text) => {
        this.lines.push(text);
      },
      error: (text) => {
        this.errors.push(text);
      },
      ...(options.claudeChannel === true ? { claudeChannel: true } : {}),
      ...(options.types === undefined ? {} : { types: options.types }),
    });
    // A refused option (an unknown --types entry) rejects; close reports it.
    this.finished.catch(() => undefined);
  }

  /** Writes one line exactly as given, newline included or not. */
  sendText(text: string): void {
    const resolve = this.waiting.shift();
    if (resolve !== undefined) resolve(text);
    else this.queued.push(text);
  }

  send(message: unknown): void {
    this.sendText(`${JSON.stringify(message)}\n`);
  }

  async request(
    id: number,
    method: string,
    params?: unknown,
  ): Promise<Record<string, unknown>> {
    this.send({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
    return JSON.parse(await this.lines.next()) as Record<string, unknown>;
  }

  notify(method: string): void {
    this.send({ jsonrpc: "2.0", method });
  }

  async close(): Promise<{ out: string; err: string; code: number }> {
    this.ended = true;
    for (const resolve of this.waiting.splice(0)) resolve(undefined);
    let failure: unknown;
    try {
      await this.finished;
    } catch (error) {
      failure = error;
    }
    this.lines.end();
    if (failure !== undefined) throw failure;
    return { out: this.lines.seen.join("\n"), err: this.errors.join(""), code: 0 };
  }

  private async *input(): AsyncGenerator<string, void, void> {
    for (;;) {
      const text = this.queued.shift();
      if (text !== undefined) {
        yield text;
        continue;
      }
      if (this.ended) return;
      const next = await new Promise<string | undefined>((resolve) => {
        this.waiting.push(resolve);
      });
      if (next === undefined) return;
      yield next;
    }
  }
}

/** Opens a session for the flags the CLI would parse. */
export function openSession(
  home: string,
  cwd = home,
  extra: readonly string[] = [],
): Session {
  let claudeChannel = false;
  let types: string[] | undefined;
  for (let index = 0; index < extra.length; index += 1) {
    const arg = extra[index];
    if (arg === "--claude-channel") {
      claudeChannel = true;
      continue;
    }
    if (arg === "--types") {
      const value = extra[index + 1] ?? "";
      types = value
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      index += 1;
    }
  }
  return new Session({ home, cwd, claudeChannel, types });
}
