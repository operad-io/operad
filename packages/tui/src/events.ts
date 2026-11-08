/**
 * The `/v1/events` stream: server-sent events parsed by hand, an opaque
 * `Last-Event-ID` kept across reconnects, one reset signal when the server
 * cannot resume, and a reconnect with capped backoff until the caller stops it.
 */

import {
  defaultFetch,
  httpError,
  TuiUnreachableError,
  type FetchLike,
  type TuiError,
} from "./client.ts";

/** The first delay before a reconnect. */
export const DEFAULT_RETRY_MIN_MS = 250;

/** The longest delay between reconnects. */
export const DEFAULT_RETRY_MAX_MS = 5_000;

/** One object changed. */
export interface TuiChangeEvent {
  readonly kind: "change";
  readonly id: string;
}

/** The server could not resume; refetch the lists and open sections. */
export interface TuiResetEvent {
  readonly kind: "reset";
}

/**
 * The server refused the stream. `error` is the typed error of the response.
 * After a 401, 404 or 409 the stream ends (a wrong token, or an old or wrong
 * server: retrying cannot help). After a 5xx the stream goes on with backoff,
 * and another error event follows each failed attempt.
 */
export interface TuiErrorEvent {
  readonly kind: "error";
  readonly error: TuiError;
}

/**
 * What the event stream yields: `change` (one object changed), `reset` (refetch
 * the lists and open sections; also sent by the client itself when it
 * reconnected with no id to resume from) and `error` (the server refused).
 */
export type TuiEvent = TuiChangeEvent | TuiResetEvent | TuiErrorEvent;

/** Statuses after which a retry cannot succeed. */
const FINAL_STATUSES: ReadonlySet<number> = new Set([401, 404, 409]);

/** Options for one event stream. */
export interface TuiEventsOptions {
  readonly url: string;
  readonly token: string;
  readonly fetch?: FetchLike | undefined;
  /** Resume from this opaque id instead of from now. */
  readonly lastEventId?: string | undefined;
  readonly retryMinMs?: number | undefined;
  readonly retryMaxMs?: number | undefined;
  /** Stops the stream from outside, like a screen closing. */
  readonly signal?: AbortSignal | undefined;
  /** Tests inject a wait instead of a real timer. */
  readonly wait?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
}

/** The retry delay: double each failure, never past the cap. */
export function retryDelay(
  attempt: number,
  minMs = DEFAULT_RETRY_MIN_MS,
  maxMs = DEFAULT_RETRY_MAX_MS,
): number {
  const low = Math.max(0, minMs);
  const high = Math.max(low, maxMs);
  const step = Math.min(Math.max(0, Math.trunc(attempt)), 30);
  return Math.min(high, low * 2 ** step);
}

/** Waits for a retry, or ends at once when the stream is stopped. */
export function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface SseBlock {
  readonly id: string | undefined;
  readonly event: string;
  readonly data: string;
}

/** Reads one SSE block; a comment-only block is undefined. */
function parseBlock(block: string): SseBlock | undefined {
  let id: string | undefined;
  let event = "message";
  const data: string[] = [];
  let sawField = false;
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    sawField = true;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (!sawField) return undefined;
  return { id, event, data: data.join("\n") };
}

/** One live event stream; it reconnects until `stop()`. */
export class TuiEvents implements AsyncIterableIterator<TuiEvent> {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly retryMinMs: number;
  private readonly retryMaxMs: number;
  private readonly waitImpl: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly abort = new AbortController();
  private readonly externalSignal: AbortSignal | undefined;
  private readonly onExternalAbort: () => void;
  private readonly queue: TuiEvent[] = [];
  private readonly waiters: ((result: IteratorResult<TuiEvent>) => void)[] = [];
  private lastId: string | undefined;
  private connectedBefore = false;
  private started = false;
  private closed = false;

  constructor(options: TuiEventsOptions) {
    this.baseUrl = options.url.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? defaultFetch;
    this.retryMinMs = options.retryMinMs ?? DEFAULT_RETRY_MIN_MS;
    this.retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    this.waitImpl = options.wait ?? waitForRetry;
    this.lastId = options.lastEventId;
    this.externalSignal = options.signal;
    this.onExternalAbort = (): void => {
      this.stop();
    };
    if (options.signal !== undefined) {
      if (options.signal.aborted) this.closed = true;
      else options.signal.addEventListener("abort", this.onExternalAbort, { once: true });
    }
  }

  /** The opaque id to resume from; cleared by a reset event. */
  get lastEventId(): string | undefined {
    return this.lastId;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<TuiEvent> {
    this.start();
    return this;
  }

  next(): Promise<IteratorResult<TuiEvent>> {
    this.start();
    const event = this.queue.shift();
    if (event !== undefined) {
      return Promise.resolve({ done: false, value: event });
    }
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise<IteratorResult<TuiEvent>>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  return(): Promise<IteratorResult<TuiEvent>> {
    this.stop();
    return Promise.resolve({ done: true, value: undefined });
  }

  /** Stops the stream and ends any waiting `next()`. */
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    if (this.externalSignal !== undefined) {
      this.externalSignal.removeEventListener("abort", this.onExternalAbort);
    }
    this.settle();
  }

  private start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    void this.run();
  }

  private settle(): void {
    for (const resolve of this.waiters.splice(0)) {
      resolve({ done: true, value: undefined });
    }
  }

  private push(event: TuiEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value: event });
      return;
    }
    this.queue.push(event);
  }

  private async run(): Promise<void> {
    let attempt = 0;
    let down = false;
    while (!this.closed) {
      let delivered = false;
      try {
        delivered = await this.connect();
        down = false;
      } catch (error) {
        // A refused connection or a dropped stream is retried below, and said
        // once per outage so the app can show it and ask the lists again.
        if (!this.closed && !down) {
          down = true;
          this.push({
            kind: "error",
            error: new TuiUnreachableError(
              `the event stream to ${this.baseUrl} was lost`,
              error,
            ),
          });
        }
      }
      if (this.closed) break;
      // A server that accepts and then closes without an event is still a
      // failure: only a connection that delivered something resets the backoff.
      if (delivered) attempt = 0;
      const delay = retryDelay(attempt, this.retryMinMs, this.retryMaxMs);
      attempt += 1;
      await this.waitImpl(delay, this.abort.signal);
    }
    this.settle();
  }

  /** Reads one connection to its end; true when it delivered an event. */
  private async connect(): Promise<boolean> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "text/event-stream",
    };
    if (this.lastId !== undefined) headers["last-event-id"] = this.lastId;

    const response = await this.fetchImpl(`${this.baseUrl}/v1/events`, {
      headers,
      signal: this.abort.signal,
    });
    if (!response.ok) {
      const error = await httpError(response);
      this.push({ kind: "error", error });
      if (error.status !== undefined && FINAL_STATUSES.has(error.status)) {
        this.stop();
      }
      return false;
    }
    if (response.body === null) {
      throw new Error("the event stream has no body");
    }
    // A reconnect with no id asks "from now", and the server then cannot say
    // that events were missed: the client says it.
    if (this.connectedBefore && this.lastId === undefined) {
      this.push({ kind: "reset" });
    }
    this.connectedBefore = true;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let delivered = false;
    try {
      while (!this.closed) {
        const read = await reader.read();
        if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        const drained = this.drain(buffer);
        buffer = drained.remaining;
        delivered = delivered || drained.delivered;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return delivered;
  }

  /** Consumes every complete block and returns the unfinished tail. */
  private drain(buffer: string): { remaining: string; delivered: boolean } {
    let remaining = buffer;
    let delivered = false;
    for (;;) {
      const match = /\r?\n\r?\n/.exec(remaining);
      if (match === null) break;
      const block = remaining.slice(0, match.index);
      remaining = remaining.slice(match.index + match[0].length);
      if (this.handleBlock(block)) delivered = true;
    }
    return { remaining, delivered };
  }

  /** Handles one block; true when it yielded an event. */
  private handleBlock(block: string): boolean {
    const parsed = parseBlock(block);
    if (parsed === undefined) return false;
    if (parsed.id !== undefined && parsed.id.length > 0) {
      this.lastId = parsed.id;
    }
    if (parsed.event === "reset") {
      // The old id is not resumable. The next connection starts from now, so a
      // second reset does not follow the first.
      this.lastId = undefined;
      this.push({ kind: "reset" });
      return true;
    }
    if (parsed.event !== "message" || parsed.data.length === 0) return false;
    let body: unknown;
    try {
      body = JSON.parse(parsed.data);
    } catch {
      return false;
    }
    if (!isRecord(body) || typeof body.id !== "string") return false;
    this.push({ kind: "change", id: body.id });
    return true;
  }
}
