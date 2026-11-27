/**
 * The HTTP face of the presentation kernel: the same list, get, section,
 * events and act a local client calls, behind one bearer token. Only `serve`
 * starts this; no other command opens the port.
 */

import type { PluginAdmin } from "./plugins.ts";
import type { FlowStarter } from "./flows.ts";
import { listFlows } from "../views/flows.ts";
import { randomBytes } from "node:crypto";
import type { HttpConfig } from "../config/config.ts";
import type { LogBackend } from "../log/types.ts";
import { messageOf } from "../plugin/errors.ts";
import type { PluginRegistry } from "../plugin/registry.ts";
import type {
  Actor,
  AskQuestionAnswer,
  PluginHttp,
  PluginStream,
  PluginStreamEvent,
} from "../plugin/types.ts";
import type { Kernel } from "../trigger/kernel.ts";
import { eventLine, fitsEventLine } from "../views/event-line.ts";
import { listPending } from "../views/pending.ts";
import {
  DEFAULT_MAX_EVENT_IDS,
  ViewError,
  type ViewEvent,
  type Views,
} from "../views/presentation.ts";
import { listRunning } from "../views/running.ts";
import { Uploads, UploadTooLargeError, MAX_UPLOAD_BYTES } from "../views/uploads.ts";
import { listTypes } from "../views/types.ts";
import {
  isLocalRequest,
  missingAddressMessage,
  noListenAddressMessage,
  splitListenAddresses,
  validateListenAddresses,
  type NetworkInterfaceList,
} from "./address.ts";
import {
  ensureHttpToken,
  readHttpToken,
  tokensEqual,
  type HttpToken,
} from "./token.ts";
import { isRecord } from "../util.ts";
import { StoreClosedError } from "../log/errors.ts";
import { InFlight } from "../plugin/in-flight.ts";

/** How long an idle event stream waits before a keep-alive comment. */
export const DEFAULT_KEEP_ALIVE_MS = 15_000;

/** The header a client names itself in; the name becomes the actor's `via`. */
export const CLIENT_HEADER = "x-operad-client";

/** The client's name when it is a short lowercase word; `http` when missing or not one. */
export function clientName(header: string | null): string {
  const name = header?.trim() ?? "";
  return /^[a-z][a-z0-9_-]{0,31}$/.test(name) ? name : "http";
}

/** How often a running server checks whether `http token rotate` replaced the token. */
export const DEFAULT_TOKEN_CHECK_MS = 1_000;

/** The largest JSON request body `serve` accepts, in bytes. */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export { MAX_SSE_EVENT_BYTES } from "../views/event-line.ts";

/**
 * How much unread plugin event data one stream holds before it is dropped;
 * `snapshot` events are not counted.
 */
export const MAX_PLUGIN_STREAM_BYTES = 32 * 1024 * 1024;

/** The first path segments serve answers itself; no plugin is asked about them. */
const BUILT_IN_ENDPOINTS: ReadonlySet<string> = new Set([
  "act",
  "answer",
  "attachments",
  "commands",
  "events",
  "flows",
  "keys",
  "objects",
  "pending",
  "plugins",
  "running",
  "settings",
  "types",
  "uploads",
]);

/** How often a running server removes the uploads no action used. */
export const DEFAULT_UPLOAD_SWEEP_MS = 10 * 60 * 1000;

export interface HttpServerOptions {
  readonly home: string;
  readonly config: HttpConfig;
  readonly views: Views;
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  readonly kernel?: Kernel | undefined;
  /** Lists and switches plugins for `/v1/plugins`; without it the endpoint is `404`. */
  readonly plugins?: PluginAdmin | undefined;
  /** Starts a flow for `/v1/flows/start`; without it the endpoint is `404`. */
  readonly flows?: FlowStarter | undefined;
  readonly onLog?: ((message: string) => void) | undefined;
  /** What a running plugin serves under `/v1/<name>` and on the event stream. */
  readonly pluginHttp?: ((plugin: string) => PluginHttp | undefined) | undefined;
  /** The address a request came from; tests replace it to stand for another machine. */
  readonly peerAddress?: ((address: string | undefined) => string | undefined) | undefined;
  /** Called once per address with the URL it listens on. */
  readonly onListen?: ((url: string) => void) | undefined;
  readonly maxEventIds?: number | undefined;
  readonly keepAliveMs?: number | undefined;
  readonly tokenCheckMs?: number | undefined;
  /** How long an upload no action used stays; default one hour. */
  readonly uploadTtlMs?: number | undefined;
  readonly uploadSweepMs?: number | undefined;
  /** The largest upload in bytes; default 20 MB. */
  readonly uploadLimitBytes?: number | undefined;
  readonly clock?: (() => number) | undefined;
  /** How long `stop` waits for the addresses to release; default 5 seconds. */
  readonly stopTimeoutMs?: number | undefined;
  /** Waits `ms`; tests inject it instead of a timer. */
  readonly wait?: ((ms: number) => Promise<void>) | undefined;
  /** Starts one listener; tests replace it to fake a listener that will not stop. */
  readonly listener?: typeof Bun.serve | undefined;
  /** The machine's network interfaces; default `os.networkInterfaces`. */
  readonly interfaces?: NetworkInterfaceList | undefined;
}

/** How long `stop` waits for every listen address to be released. */
export const DEFAULT_STOP_TIMEOUT_MS = 5_000;

/** `stop` could not release an address in time; the process still holds it. */
export class HttpStopError extends Error {
  readonly addresses: readonly string[];
  constructor(addresses: readonly string[]) {
    super(`http: ${addresses.join(", ")} did not release the port`);
    this.name = "HttpStopError";
    this.addresses = addresses;
  }
}

export interface HttpServerHandle {
  /** The URLs the server listens on, one per configured address this machine has. */
  readonly urls: readonly string[];
  readonly port: number;
  stop(): Promise<void>;
}

export interface EventEntry {
  /** The position inside this process's stream. */
  readonly seq: number;
  /** The SSE id: `<bootId>-<seq>`, opaque to the client. */
  readonly event: string;
  /** The object that changed. */
  readonly id: string;
}

type HubEvent =
  | { readonly kind: "change"; readonly entry: EventEntry }
  | { readonly kind: "live"; readonly event: ViewEvent }
  | { readonly kind: "reset" };

type HubListener = (event: HubEvent) => void;
type HubFailure = ((error: unknown) => void) | undefined;

/** The first delay before the hub re-opens a source that failed or ended. */
export const DEFAULT_EVENT_RETRY_MIN_MS = 250;

/** The longest such delay; the hub keeps retrying at this pace. */
export const DEFAULT_EVENT_RETRY_MAX_MS = 5_000;

/** The restart delay: double each failure, never past the cap. */
export function eventRetryDelay(
  attempt: number,
  minMs = DEFAULT_EVENT_RETRY_MIN_MS,
  maxMs = DEFAULT_EVENT_RETRY_MAX_MS,
): number {
  const low = Math.max(0, minMs);
  const high = Math.max(low, maxMs);
  const step = Math.min(Math.max(0, Math.trunc(attempt)), 30);
  return Math.min(high, low * 2 ** step);
}

/** Waits before a retry; unref'd so a stopped hub does not hold the process up. */
function waitForRestart(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    (setTimeout(resolve, ms) as { unref?: () => void }).unref?.();
  });
}

export interface EventHubOptions {
  /** Waits `ms` before re-opening a failed source; tests inject it. */
  readonly wait?: ((ms: number) => Promise<void>) | undefined;
  readonly retryMinMs?: number | undefined;
  readonly retryMaxMs?: number | undefined;
  /** The clock; a source that stayed open at least the longest wait is healthy. */
  readonly clock?: (() => number) | undefined;
}

/** The bounded stream of ids every event client resumes from. */
export class EventHub {
  private readonly entries: EventEntry[] = [];
  private readonly max: number;
  private readonly listeners = new Map<HubListener, HubFailure>();
  private readonly events: () => AsyncIterable<ViewEvent>;
  private readonly onLog: (message: string) => void;
  private iterator: AsyncIterator<ViewEvent> | undefined;
  /** Random once per process: an id from another boot never resumes here. */
  private readonly bootId = randomBytes(8).toString("hex");
  private seq = 0;
  /** The first id after the last source restart; older ids cannot resume. */
  private resetFrom = 0;
  /** Whether this outage already told the open streams to reset. */
  private resetAnnounced = false;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly retryMinMs: number;
  private readonly retryMaxMs: number;
  /** An open at least this long counts as healthy and starts the wait over. */
  private readonly healthyMs: number;
  private readonly clock: () => number;
  private stopped = false;

  constructor(
    events: () => AsyncIterable<ViewEvent>,
    max: number,
    onLog: (message: string) => void,
    options: EventHubOptions = {},
  ) {
    this.max = Math.max(1, max);
    this.events = events;
    this.onLog = onLog;
    this.wait = options.wait ?? waitForRestart;
    this.retryMinMs = options.retryMinMs ?? DEFAULT_EVENT_RETRY_MIN_MS;
    this.retryMaxMs = options.retryMaxMs ?? DEFAULT_EVENT_RETRY_MAX_MS;
    this.healthyMs = Math.max(Math.max(0, this.retryMinMs), this.retryMaxMs);
    this.clock = options.clock ?? Date.now;
    void this.pump();
  }

  /**
   * Reads the source to its end, then re-opens it. A source that fails or ends
   * at once on every open waits longer each time, up to the cap, so it cannot
   * spin through the event loop; only a source that stayed open at least as
   * long as the longest wait starts over, so one that hands over an event and
   * dies on every open keeps backing off instead of retrying at the minimum.
   */
  private async pump(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      let failure: unknown;
      let ended = false;
      const openedAt = this.clock();
      try {
        const iterator = this.events()[Symbol.asyncIterator]();
        this.iterator = iterator;
        while (!this.stopped) {
          const next = await iterator.next();
          if (next.done) {
            ended = true;
            break;
          }
          this.publish(next.value);
        }
      } catch (error) {
        failure = error;
      }
      if (this.stopped) return;
      if (this.clock() - openedAt >= this.healthyMs) attempt = 0;
      const delay = eventRetryDelay(attempt, this.retryMinMs, this.retryMaxMs);
      attempt += 1;
      this.onLog(
        ended
          ? `http events: the source ended; re-opening it in ${delay} ms`
          : `http events: ${messageOf(failure)}; re-opening it in ${delay} ms`,
      );
      this.restart();
      await this.wait(delay);
    }
  }

  private publish(value: ViewEvent): void {
    if (value.section !== undefined) {
      // A live part is for the clients connected now; it is not replayed on a
      // reconnect, where the section read gives the whole current tail again.
      // A part too large for one line is dropped, never cut and never a second
      // change: the kernel announces the object's growth change within its own
      // window, and that change asks the client to read the open section again.
      if (fitsEventLine(value)) this.notify({ kind: "live", event: value });
      return;
    }
    this.resetAnnounced = false;
    this.seq += 1;
    const entry: EventEntry = {
      seq: this.seq,
      event: `${this.bootId}-${this.seq}`,
      id: value.id,
    };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.shift();
    this.notify({ kind: "change", entry });
  }

  /**
   * A source that failed or ended cannot replay what happened while it was
   * gone. Open streams get a reset, and no id from before the break resumes.
   */
  private restart(): void {
    this.resetFrom = this.seq + 1;
    this.entries.length = 0;
    // Repeated failures without a change in between carry no new gap, so one
    // reset per outage is enough; repeating it would make every client re-read
    // its state once per retry.
    if (this.resetAnnounced) return;
    this.resetAnnounced = true;
    this.notify({ kind: "reset" });
  }

  /** One failing subscriber is dropped; it does not stop the others. */
  private notify(event: HubEvent): void {
    for (const [listener, fail] of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.listeners.delete(listener);
        this.onLog(`http events: a subscriber failed: ${messageOf(error)}`);
        try {
          fail?.(error);
        } catch (failure) {
          this.onLog(`http events: a subscriber could not be closed: ${messageOf(failure)}`);
        }
      }
    }
  }

  snapshot(lastId: string | undefined): {
    readonly reset: boolean;
    readonly replay: readonly EventEntry[];
  } {
    if (lastId === undefined) return { reset: false, replay: [] };
    const parsed = parseEventId(lastId);
    // An id from another boot, or one that does not parse, cannot be resumed:
    // the client refetches instead of silently missing changes.
    if (parsed === undefined || parsed.bootId !== this.bootId) {
      return { reset: true, replay: [] };
    }
    if (parsed.seq < this.resetFrom) return { reset: true, replay: [] };
    const oldest = this.entries[0]?.seq;
    const latest = this.entries.at(-1)?.seq;
    if (oldest === undefined || latest === undefined) {
      return { reset: true, replay: [] };
    }
    if (parsed.seq < oldest - 1 || parsed.seq > latest) {
      return { reset: true, replay: [] };
    }
    return {
      reset: false,
      replay: this.entries.filter((entry) => entry.seq > parsed.seq),
    };
  }

  subscribe(listener: HubListener, onFailure?: (error: unknown) => void): () => void {
    this.listeners.set(listener, onFailure);
    return () => {
      this.listeners.delete(listener);
    };
  }

  stop(): void {
    this.stopped = true;
    void this.iterator?.return?.();
  }
}

function parseEventId(value: string): { bootId: string; seq: number } | undefined {
  const match = /^([0-9a-f]+)-([0-9]+)$/i.exec(value.trim());
  if (match === null) return undefined;
  const bootId = match[1];
  const text = match[2];
  if (bootId === undefined || text === undefined) return undefined;
  const seq = Number(text);
  if (!Number.isSafeInteger(seq) || seq < 0) return undefined;
  return { bootId, seq };
}

/** One open event stream, closed when its token is no longer current. */
interface OpenStream {
  readonly token: string;
  readonly close: () => void;
}

/** The event streams a server has open, so a token rotation can end them. */
class StreamRegistry {
  private readonly streams = new Set<OpenStream>();

  track(token: string, close: () => void): () => void {
    const stream: OpenStream = { token, close };
    this.streams.add(stream);
    return () => {
      this.streams.delete(stream);
    };
  }

  /** Ends every stream opened with a token other than `token`. */
  closeStale(token: string): void {
    for (const stream of [...this.streams]) {
      if (stream.token === token) continue;
      this.streams.delete(stream);
      stream.close();
    }
  }

  closeAll(): void {
    for (const stream of [...this.streams]) {
      this.streams.delete(stream);
      stream.close();
    }
  }
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
} as const;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: JSON_HEADERS,
  });
}

function errorResponse(status: number, kind: string, message: string): Response {
  return json({ error: { kind, message } }, status);
}

function viewErrorStatus(kind: ViewError["kind"]): number {
  switch (kind) {
    case "args":
    case "note":
    case "where":
    case "filter":
    case "cursor":
    case "ambiguous":
      return 400;
    case "not-found":
    case "section":
    case "no-views":
    case "action":
      return 404;
    case "unavailable":
    case "not-available":
    case "confirm":
      return 409;
    case "refused":
      return 422;
    case "timeout":
      return 504;
    default:
      return 500;
  }
}

function viewErrorResponse(error: ViewError): Response {
  const status = viewErrorStatus(error.kind);
  if (status === 500) {
    return errorResponse(500, "internal", "the request failed");
  }
  return errorResponse(status, error.kind, error.message);
}

/** The name a type shows in a client: `task` becomes `Task`. */
export { displayNameOf } from "../views/types.ts";

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ViewError("args", "the request path is not valid percent-encoding");
  }
}

function trueValue(value: string | null): boolean {
  return value === "true" || value === "1";
}

function lastEventId(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

async function authenticate(
  header: string | null,
  home: string,
): Promise<HttpToken | undefined> {
  if (header === null) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const provided = match?.[1];
  if (provided === undefined) return undefined;
  const expected = await readHttpToken(home);
  if (expected === undefined) return undefined;
  return tokensEqual(expected.token, provided) ? expected : undefined;
}

function urlFor(address: string, port: number): string {
  return address.includes(":")
    ? `http://[${address}]:${port}`
    : `http://${address}:${port}`;
}

const RESET_EVENT = "event: reset\ndata: {}\n\n";

/** A change event whose data line fits; an id too long to send becomes a reset. */
function formatEvent(entry: EventEntry): string {
  const line = eventLine({ id: entry.id });
  return line === undefined
    ? RESET_EVENT
    : `id: ${entry.event}\n${line}\n\n`;
}

function formatTailEvent(event: ViewEvent): string {
  return `event: tail\ndata: ${JSON.stringify(event)}\n\n`;
}

export function eventResponse(
  request: Request,
  hub: EventHub,
  keepAliveMs: number,
  queueLimit: number,
  token: string,
  track: (token: string, close: () => void) => () => void,
  plugins: readonly { readonly plugin: string; readonly stream: PluginStream }[] = [],
): Response {
  const resumeFrom = lastEventId(request.headers.get("last-event-id"));
  const encoder = new TextEncoder();
  /** `entry` marks the kernel's own; `pluginBytes` is what a plugin's one counts. */
  const queue: { readonly text: string; readonly entry: boolean; readonly pluginBytes: number }[] = [];
  /** The kernel's own entries in the queue, and the bytes of the plugins'. */
  let queued = 0;
  let queuedPluginBytes = 0;
  const closers: (() => void)[] = [];
  let closed = false;
  let finished = false;
  let wake: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let untrack: (() => void) | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

  const close = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    for (const closer of closers.splice(0)) closer();
    untrack?.();
    untrack = undefined;
    if (keepAlive !== undefined) clearInterval(keepAlive);
    keepAlive = undefined;
    const resume = wake;
    wake = undefined;
    resume?.();
  };

  /** Ends the response; an overflowed client reconnects and gets a reset. */
  const finish = (): void => {
    if (finished) return;
    finished = true;
    close();
    controller?.close();
  };

  const enqueue = (text: string, entry: boolean, pluginBytes: number): void => {
    if (entry) queued += 1;
    queuedPluginBytes += pluginBytes;
    queue.push({ text, entry, pluginBytes });
    const resume = wake;
    wake = undefined;
    resume?.();
  };

  /** The client is not reading: it is dropped rather than let grow without bound. */
  const push = (text: string): void => {
    if (closed) return;
    if (queued >= queueLimit) finish();
    else enqueue(text, true, 0);
  };

  const pushPlugin = (plugin: string, event: PluginStreamEvent): void => {
    if (closed) return;
    const text = `event: ${plugin}.${event.name}\ndata: ${JSON.stringify(event.data)}\n\n`;
    const bytes = event.snapshot === true ? 0 : Buffer.byteLength(text);
    if (queuedPluginBytes + bytes > MAX_PLUGIN_STREAM_BYTES) finish();
    else enqueue(text, false, bytes);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(started) {
      controller = started;
      // `start` is synchronous, so no event can land between the snapshot and
      // the subscription.
      const snapshot = hub.snapshot(resumeFrom);
      if (snapshot.reset) push(RESET_EVENT);
      else for (const entry of snapshot.replay) push(formatEvent(entry));
      unsubscribe = hub.subscribe((event) => {
        if (event.kind === "reset") push(RESET_EVENT);
        else if (event.kind === "live") push(formatTailEvent(event.event));
        else push(formatEvent(event.entry));
      }, finish);
      untrack = track(token, finish);
      // An immediate comment flushes the response headers; the client then has
      // a stream even when nothing changes for a while.
      push(": keep-alive\n\n");
      for (const { plugin, stream: part } of plugins) {
        if (closed) break;
        const closer = part.open((event) => pushPlugin(plugin, event));
        // The stream may have ended while the plugin was opening its part.
        if (closed) closer();
        else closers.push(closer);
      }
      keepAlive = setInterval(() => push(": keep-alive\n\n"), keepAliveMs);
      (keepAlive as { unref?: () => void }).unref?.();
      request.signal.addEventListener("abort", close, { once: true });
    },
    async pull(started) {
      while (!closed && queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (finished) return;
      const chunk = queue.shift();
      if (chunk !== undefined) {
        if (chunk.entry) queued -= 1;
        queuedPluginBytes -= chunk.pluginBytes;
        started.enqueue(encoder.encode(chunk.text));
        return;
      }
      finish();
    },
    cancel() {
      close();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

/** A request body over the limit: the status line is 413. */
class BodyTooLarge extends Error {}

async function readBody(request: Request): Promise<unknown> {
  // The listener takes bodies as large as an upload, so a JSON body is held to its own limit here.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_REQUEST_BODY_BYTES) throw new BodyTooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLarge();
      }
      chunks.push(chunk.value);
    }
  }
  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch {
    throw new ViewError("args", "the request body is not valid JSON");
  }
}

function megabytes(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))} MB`;
}

function createHandler(
  options: HttpServerOptions,
  uploads: Uploads,
  hub: EventHub,
  streams: StreamRegistry,
  onLog: (message: string) => void,
): (request: Request, peer?: string) => Promise<Response> {
  const keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
  // One slot past the resume window so a full replay plus the greeting fits.
  const queueLimit = Math.max(1, options.maxEventIds ?? DEFAULT_MAX_EVENT_IDS) + 1;

  const handle = async (
    request: Request,
    token: HttpToken,
    peer: string | undefined,
  ): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (method === "GET" && path === "/v1/events") {
      const parts: { readonly plugin: string; readonly stream: PluginStream }[] = [];
      for (const name of new Set(url.searchParams.keys())) {
        const served = options.pluginHttp?.(name);
        if (served?.stream === undefined) continue;
        const joined = served.stream({
          values: url.searchParams.getAll(name),
          local: isLocalRequest(peer, request),
        });
        if (!("open" in joined)) return json(joined.body, joined.status);
        parts.push({ plugin: name, stream: joined });
      }
      return eventResponse(
        request,
        hub,
        keepAliveMs,
        queueLimit,
        token.token,
        (value, close) => streams.track(value, close),
        parts,
      );
    }

    if (method === "GET" && path === "/v1/types") {
      return json({ types: listTypes(options.registry) });
    }

    if (method === "GET" && path === "/v1/keys") {
      return json({
        keys: options.registry.keyBindings().map((binding) => ({
          key: binding.key,
          action: binding.name,
          source: binding.source,
        })),
      });
    }

    if (method === "GET" && path === "/v1/objects") {
      const type = url.searchParams.get("type");
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const parent = url.searchParams.get("parent") ?? undefined;
      const root = url.searchParams.has("root");
      const named = type !== null && type.trim().length > 0 ? type : undefined;
      if (named === undefined && !root && parent === undefined) {
        return errorResponse(400, "args", "the query needs a type, root or parent");
      }
      const filterName = url.searchParams.get("filter") ?? undefined;
      if (root || parent !== undefined) {
        return json(
          await options.views.listTree(named, {
            root,
            ...(parent === undefined ? {} : { parent }),
            ...(cursor === undefined ? {} : { cursor }),
            ...(filterName === undefined ? {} : { filter: filterName }),
          }),
        );
      }
      if (named === undefined) {
        return errorResponse(400, "args", "the query needs a type");
      }
      const filter = filterName ?? options.views.defaultFilterOf(named);
      return json(
        await options.views.list(named, {
          ...(cursor === undefined ? {} : { cursor }),
          ...(filter === undefined ? {} : { filter }),
        }),
      );
    }

    if (method === "GET" && path === "/v1/pending") {
      return json(
        await listPending(
          options.log,
          options.registry,
          options.kernel,
          options.views,
        ),
      );
    }

    if (method === "GET" && path === "/v1/running") {
      return json(await listRunning(options.log, options.clock, options.views));
    }

    if (path === "/v1/flows") {
      if (method !== "GET") return errorResponse(405, "method", "this endpoint takes GET");
      return json({ flows: listFlows(options.registry) });
    }

    if (path === "/v1/flows/start") {
      const starter = options.flows;
      if (starter === undefined) return errorResponse(404, "not-found", "no such endpoint");
      if (method !== "POST") return errorResponse(405, "method", "this endpoint takes POST");
      const body = await readBody(request);
      if (!isRecord(body)) {
        return errorResponse(400, "args", "the body must be an object");
      }
      const { flow, params } = body;
      if (typeof flow !== "string" || flow.length === 0) {
        return errorResponse(400, "args", "the body needs a flow");
      }
      const actor: Actor = { via: clientName(request.headers.get(CLIENT_HEADER)), id: token.label };
      try {
        const started = await starter.start(flow, params, actor);
        onLog(`http: flow "${flow}" started as ${started.runId} via ${actor.via} as ${actor.id}`);
        return json(started);
      } catch (error) {
        if (error instanceof ViewError) {
          onLog(`http: flow "${flow}" refused (${viewErrorStatus(error.kind)}): ${error.message}`);
          throw error;
        }
        onLog(`http: flow "${flow}" refused (422): ${messageOf(error)}`);
        return errorResponse(422, "refused", messageOf(error));
      }
    }

    const setupOf = /^\/v1\/plugins\/([^/]+)\/setup$/.exec(path);
    if (setupOf !== null) {
      const admin = options.plugins;
      if (admin?.setup === undefined) return errorResponse(404, "not-found", "no such endpoint");
      if (method !== "GET") return errorResponse(405, "method", "this endpoint takes GET");
      const name = decodeURIComponent(setupOf[1] ?? "");
      const found = await admin.setup(name);
      if (found === undefined) return errorResponse(404, "not-found", `plugin "${name}" has no setup guide`);
      return json({ setup: found });
    }

    if (path === "/v1/plugins") {
      const admin = options.plugins;
      if (admin === undefined) return errorResponse(404, "not-found", "no such endpoint");
      if (method === "GET") return json({ plugins: await admin.list() });
      if (method !== "POST") {
        return errorResponse(405, "method", "this endpoint takes GET or POST");
      }
      const body = await readBody(request);
      if (!isRecord(body)) {
        return errorResponse(400, "args", "the body must be an object");
      }
      const { install, name, enabled, confirmed } = body;
      if (confirmed !== undefined && typeof confirmed !== "boolean") {
        return errorResponse(400, "args", "confirmed must be a boolean");
      }
      const actor: Actor = { via: clientName(request.headers.get(CLIENT_HEADER)), id: token.label };
      if (install !== undefined) {
        if (typeof install !== "string" || install.trim().length === 0) {
          return errorResponse(400, "args", "install must be a non-empty package name");
        }
        try {
          const plugin = await admin.install(install, { confirmed: confirmed === true, actor });
          onLog(`http: plugin installed from "${install}" via ${actor.via} as ${actor.id}`);
          return json({ plugin });
        } catch (error) {
          if (error instanceof ViewError) {
            onLog(`http: plugin "${install}" refused (${viewErrorStatus(error.kind)}): ${error.message}`);
            throw error;
          }
          onLog(`http: plugin "${install}" refused (422): ${messageOf(error)}`);
          return errorResponse(422, "refused", messageOf(error));
        }
      }
      if (typeof name !== "string" || name.length === 0) {
        return errorResponse(400, "args", "the body needs a name or an install");
      }
      if (typeof enabled !== "boolean") {
        return errorResponse(400, "args", "enabled must be true or false");
      }
      try {
        const plugin = await admin.set(name, enabled, { confirmed: confirmed === true, actor });
        // A switch belongs in the lasting log like an action's caller, even
        // though it changes config.json rather than an object.
        try {
          await options.log.appendGlobal({
            kind: "plugin_switched",
            payload: {
              name: plugin.name,
              enabled: plugin.enabled,
              actor: { via: actor.via, id: actor.id },
            },
            cause: `plugin:${plugin.name}`,
          });
        } catch (error) {
          onLog(`http: could not record the switch of "${plugin.name}": ${messageOf(error)}`);
        }
        onLog(`http: plugin "${name}" ${enabled ? "enabled" : "disabled"} via ${actor.via} as ${actor.id}`);
        return json({ plugin });
      } catch (error) {
        if (error instanceof ViewError) {
          onLog(`http: plugin "${name}" refused (${viewErrorStatus(error.kind)}): ${error.message}`);
          throw error;
        }
        onLog(`http: plugin "${name}" refused (422): ${messageOf(error)}`);
        return errorResponse(422, "refused", messageOf(error));
      }
    }

    if (path === "/v1/commands") {
      if (method !== "POST") {
        return errorResponse(405, "method", "this endpoint takes POST");
      }
      const body = await readBody(request);
      if (!isRecord(body)) {
        return errorResponse(400, "args", "the body must be an object");
      }
      const { plugin, verb, args, input } = body;
      if (typeof plugin !== "string" || plugin.length === 0) {
        return errorResponse(400, "args", "the body needs a plugin");
      }
      if (typeof verb !== "string" || verb.length === 0) {
        return errorResponse(400, "args", "the body needs a verb");
      }
      if (args !== undefined && (!Array.isArray(args) || !args.every((item) => typeof item === "string"))) {
        return errorResponse(400, "args", "args must be an array of strings");
      }
      if (input !== undefined && typeof input !== "string") {
        return errorResponse(400, "args", "input must be a string");
      }
      const commandArgs = args === undefined ? [] : (args as readonly string[]);
      try {
        // A served command never reads the serve process's own stdin: an
        // omitted input is an empty one.
        const run = await options.registry.runCommand([plugin, verb, ...commandArgs], {
          input: input ?? "",
        });
        if (run === undefined) {
          return errorResponse(
            404,
            "not-found",
            `no loaded plugin "${plugin}" declares the verb "${verb}"`,
          );
        }
        return json({ plugin: run.plugin, verb: run.command, value: run.value });
      } catch (error) {
        onLog(`http: command "${plugin} ${verb}" refused: ${messageOf(error)}`);
        return errorResponse(422, "refused", messageOf(error));
      }
    }

    if (path === "/v1/settings") {
      if (method === "GET") {
        const scope = url.searchParams.get("scope") ?? undefined;
        return json({ settings: await options.views.settings(scope) });
      }
      if (method !== "POST") {
        return errorResponse(405, "method", "this endpoint takes GET or POST");
      }
      const body = await readBody(request);
      if (!isRecord(body)) {
        return errorResponse(400, "args", "the body must be an object");
      }
      const { name, scope, confirmed } = body;
      if (typeof name !== "string" || name.length === 0) {
        return errorResponse(400, "args", "the body needs a name");
      }
      if (!("value" in body)) {
        return errorResponse(400, "args", "the body needs a value");
      }
      if (scope !== undefined && typeof scope !== "string") {
        return errorResponse(400, "args", "scope must be a string");
      }
      if (confirmed !== undefined && typeof confirmed !== "boolean") {
        return errorResponse(400, "args", "confirmed must be a boolean");
      }
      try {
        return json(
          await options.views.set(name, body.value, {
            ...(scope === undefined ? {} : { scope }),
            confirmed: confirmed === true,
          }),
        );
      } catch (error) {
        // The body was checked above; a value or file the settings schema
        // refuses is unprocessable, not a malformed request.
        if (error instanceof ViewError && error.kind === "args") {
          return errorResponse(422, "args", error.message);
        }
        throw error;
      }
    }

    if (path.startsWith("/v1/attachments/")) {
      if (method !== "GET") {
        return errorResponse(405, "method", "this endpoint takes GET");
      }
      const found = await options.views.file(
        path.slice("/v1/attachments/".length).split("/").map(decodeSegment),
      );
      if (found === undefined) return errorResponse(404, "not-found", "no such attachment");
      return new Response(Bun.file(found.path), {
        headers: {
          "content-type": found.type,
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(found.name)}`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }

    if (path === "/v1/uploads") {
      if (method !== "POST") {
        return errorResponse(405, "method", "this endpoint takes POST");
      }
      // The body is the file itself, streamed to disk; the name and the type travel beside it.
      const name = url.searchParams.get("name") ?? "";
      if (name.trim().length === 0) {
        return errorResponse(400, "args", "the request needs a name query for the file");
      }
      const limit = uploads.limit;
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (declared > limit) {
        // The body is never read; the connection ends so its leftover bytes
        // are not taken for the next request.
        const refused = errorResponse(
          413,
          "too-large",
          `the file is larger than the ${megabytes(limit)} limit`,
        );
        refused.headers.set("connection", "close");
        return refused;
      }
      try {
        const info = await uploads.save(
          request.body,
          name,
          request.headers.get("content-type") ?? "",
        );
        void uploads.sweep().catch(() => undefined);
        return json(info, 201);
      } catch (error) {
        if (error instanceof UploadTooLargeError) {
          return errorResponse(413, "too-large", error.message);
        }
        throw error;
      }
    }

    if (method === "POST" && path === "/v1/answer") {
      const body = await readBody(request);
      if (!isRecord(body)) {
        return errorResponse(400, "args", "the body must be an object");
      }
      const { runId, waitId, choice } = body;
      if (typeof runId !== "string" || runId.length === 0) {
        return errorResponse(400, "args", "the body needs a runId");
      }
      if (typeof waitId !== "string" || waitId.length === 0) {
        return errorResponse(400, "args", "the body needs a waitId");
      }
      const answers = body.answers;
      if (answers !== undefined && !Array.isArray(answers)) {
        return errorResponse(400, "args", "answers must be a list");
      }
      if (
        (choice === undefined || typeof choice !== "string" || choice.length === 0) &&
        answers === undefined
      ) {
        return errorResponse(400, "args", "the body needs a choice or answers");
      }
      if (choice !== undefined && (typeof choice !== "string" || choice.length === 0)) {
        return errorResponse(400, "args", "choice must be a string");
      }
      const note = body.note;
      if (note !== undefined && typeof note !== "string") {
        return errorResponse(400, "args", "note must be a string");
      }
      const confirmed = body.confirmed;
      if (confirmed !== undefined && typeof confirmed !== "boolean") {
        return errorResponse(400, "args", "confirmed must be a boolean");
      }
      const actor: Actor = { via: clientName(request.headers.get(CLIENT_HEADER)), id: token.label };
      try {
        await options.views.answer({
          runId,
          waitId,
          choice: typeof choice === "string" ? choice : undefined,
          ...(answers === undefined
            ? {}
            : { answers: answers as unknown as readonly AskQuestionAnswer[] }),
          ...(note === undefined ? {} : { note }),
          ...(confirmed === true ? { confirmed: true } : {}),
          surface: "http",
          actor,
        });
        return json({ runId, waitId, choice });
      } catch (error) {
        if (error instanceof ViewError) {
          onLog(
            `http: answer "${waitId}" refused (${viewErrorStatus(error.kind)}): ${error.message}`,
          );
          throw error;
        }
        onLog(`http: answer "${waitId}" refused (422): ${messageOf(error)}`);
        return errorResponse(422, "refused", messageOf(error));
      }
    }

    if (method === "POST" && path === "/v1/act") {
      const body = await readBody(request);
      if (!isRecord(body)) {
        return errorResponse(400, "args", "the body must be an object");
      }
      const action = body.action;
      if (typeof action !== "string" || action.length === 0) {
        return errorResponse(400, "args", "the body needs an action");
      }
      // `id` is optional: an action that does not target an object names no
      // object, and the views decide whether the action can run without one.
      const id = body.id;
      if (id !== undefined && typeof id !== "string") {
        return errorResponse(400, "args", "id must be a string");
      }
      const args = body.args === undefined ? {} : body.args;
      if (!isRecord(args)) {
        return errorResponse(400, "args", "args must be an object");
      }
      const note = body.note;
      if (note !== undefined && typeof note !== "string") {
        return errorResponse(400, "args", "note must be a string");
      }
      const confirmed = body.confirmed;
      if (confirmed !== undefined && typeof confirmed !== "boolean") {
        return errorResponse(400, "args", "confirmed must be a boolean");
      }
      const actor: Actor = { via: clientName(request.headers.get(CLIENT_HEADER)), id: token.label };
      try {
        const result = await options.views.act(action, id, {
          args,
          ...(note === undefined ? {} : { note }),
          yes: confirmed === true,
          surface: "http",
          actor,
        });
        return json(result);
      } catch (error) {
        // The status stays in the log; a client shows the line itself.
        if (error instanceof ViewError) {
          onLog(
            `http: action "${action}" refused (${viewErrorStatus(error.kind)}): ${error.message}`,
          );
          throw error;
        }
        onLog(`http: action "${action}" refused (422): ${messageOf(error)}`);
        return errorResponse(422, "refused", messageOf(error));
      }
    }

    if (path.startsWith("/v1/objects/")) {
      if (method !== "GET") {
        return errorResponse(405, "method", "this endpoint takes GET");
      }
      const rest = path.slice("/v1/objects/".length);
      const marker = "/sections/";
      const at = rest.lastIndexOf(marker);
      if (at >= 0) {
        const rawId = rest.slice(0, at);
        const rawSection = rest.slice(at + marker.length);
        if (rawId.length === 0 || rawSection.length === 0) {
          return errorResponse(404, "not-found", "no such section");
        }
        const id = decodeSegment(rawId);
        const section = decodeSegment(rawSection);
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const after = url.searchParams.get("after") ?? undefined;
        return json(
          await options.views.section(id, section, cursor, {
            full: trueValue(url.searchParams.get("full")),
            ...(after === undefined ? {} : { after }),
          }),
        );
      }
      if (rest.length === 0) {
        return errorResponse(404, "not-found", "no such object");
      }
      return json(await options.views.get(decodeSegment(rest)));
    }

    const [, version, plugin, ...rest] = path.split("/");
    if (version === "v1" && plugin !== undefined && !BUILT_IN_ENDPOINTS.has(plugin)) {
      const answer = await options.pluginHttp?.(plugin)?.request({
        method,
        path: rest.map(decodeSegment),
        local: isLocalRequest(peer, request),
        body: () => readBody(request),
      });
      if (answer !== undefined) return json(answer.body, answer.status);
    }
    return errorResponse(404, "not-found", "no such endpoint");
  };

  return async (request: Request, peer?: string): Promise<Response> => {
    try {
      const token = await authenticate(
        request.headers.get("authorization"),
        options.home,
      );
      if (token === undefined) {
        return errorResponse(401, "unauthorized", "a bearer token is required");
      }
      return await handle(request, token, peer);
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        return errorResponse(
          413,
          "too-large",
          `the request body is larger than the ${megabytes(MAX_REQUEST_BODY_BYTES)} limit`,
        );
      }
      if (error instanceof ViewError) return viewErrorResponse(error);
      // A request that outlives its store is over because the server is
      // going away: answer it, and do not log it as a failure.
      if (error instanceof StoreClosedError) {
        return errorResponse(503, "unavailable", "the server is stopping");
      }
      onLog(`http: ${messageOf(error)}`);
      return errorResponse(500, "internal", "the request failed");
    }
  };
}

/** Starts one Bun server per `http.listen` address this machine has. */
export async function startHttpServer(
  options: HttpServerOptions,
): Promise<HttpServerHandle> {
  validateListenAddresses(options.config.listen);
  // A missing address (a network that is down) fails to bind with the same
  // error as a taken port, so it is told apart before binding.
  const { present, missing } = splitListenAddresses(options.config.listen, options.interfaces);
  // Not a `ConfigError`: a serve that retries its bind may see the address return.
  if (present.length === 0) throw new Error(`http: ${noListenAddressMessage(missing)}`);
  const token = await ensureHttpToken(options.home);

  const onLog = options.onLog ?? (() => undefined);
  for (const address of missing) onLog(`http: ${missingAddressMessage(address)}`);
  const wait = options.wait ?? waitForRestart;
  const hub = new EventHub(
    () => options.views.events(),
    options.maxEventIds ?? DEFAULT_MAX_EVENT_IDS,
    onLog,
    { wait },
  );
  const streams = new StreamRegistry();
  const uploads = new Uploads({
    home: options.home,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.uploadTtlMs === undefined ? {} : { ttlMs: options.uploadTtlMs }),
    ...(options.uploadLimitBytes === undefined ? {} : { limit: options.uploadLimitBytes }),
  });
  void uploads.sweep().catch(() => undefined);
  const uploadSweep = setInterval(() => {
    void uploads.sweep().catch(() => undefined);
  }, options.uploadSweepMs ?? DEFAULT_UPLOAD_SWEEP_MS);
  (uploadSweep as { unref?: () => void }).unref?.();
  const handle = createHandler(options, uploads, hub, streams, onLog);
  // Requests in flight are waited for (bounded) by `stop`, so the store they
  // read is not closed under them.
  const requests = new InFlight();
  const handler = async (request: Request, peer: string | undefined): Promise<Response> =>
    requests.draining
      ? errorResponse(503, "unavailable", "the server is stopping")
      : await requests.track(() => handle(request, peer));
  const peerAddress = options.peerAddress ?? ((address: string | undefined) => address);
  const servers: { readonly address: string; readonly server: ReturnType<typeof Bun.serve> }[] = [];
  const listener = options.listener ?? Bun.serve;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

  /**
   * Stops every listener at once, so one that will not stop (a peer that
   * never reads its stream) cannot keep the others bound, and waits a bounded
   * time. The addresses that did not release in time are named.
   */
  const stopAll = async (): Promise<readonly string[]> => {
    const pending = new Set(servers.map(({ address }) => address));
    const stops = servers.map(async ({ address, server }) => {
      await Promise.resolve(server.stop(true)).catch(() => undefined);
      pending.delete(address);
    });
    await Promise.race([Promise.all(stops), wait(stopTimeoutMs)]);
    return [...pending];
  };

  // A rotation happens in another process (`operad http token rotate`), so the
  // server notices it by reading the secret file again. A stream opened with the
  // old token ends; the client reconnects and gets a reset.
  let currentToken = token.token;
  let checking = false;
  const tokenCheck = setInterval(() => {
    if (checking) return;
    checking = true;
    void readHttpToken(options.home)
      .then((latest) => {
        if (latest === undefined || latest.token === currentToken) return;
        currentToken = latest.token;
        streams.closeStale(currentToken);
      })
      .catch(() => undefined)
      .finally(() => {
        checking = false;
      });
  }, options.tokenCheckMs ?? DEFAULT_TOKEN_CHECK_MS);
  (tokenCheck as { unref?: () => void }).unref?.();

  try {
    for (const address of present) {
      let server: ReturnType<typeof Bun.serve>;
      try {
        server = listener({
          hostname: address,
          port: options.config.port,
          // An event stream is quiet by design; the 15-second comment keeps it
          // below this idle limit.
          idleTimeout: 30,
          // Room for an upload plus its framing; a JSON body is held to its own limit in `readBody`.
          maxRequestBodySize: Math.max(MAX_UPLOAD_BYTES, options.uploadLimitBytes ?? 0) * 2,
          fetch: (request: Request, bound?: { requestIP?(from: Request): { address: string } | null }) =>
            handler(request, peerAddress(bound?.requestIP?.(request)?.address)),
          error: (error) => {
            onLog(`http: ${messageOf(error)}`);
            return errorResponse(500, "internal", "the request failed");
          },
        });
      } catch (error) {
        throw new Error(
          `http: cannot listen on ${address} port ${options.config.port}: ${messageOf(error)}`,
          { cause: error },
        );
      }
      servers.push({ address, server });
    }
  } catch (error) {
    clearInterval(tokenCheck);
    clearInterval(uploadSweep);
    hub.stop();
    streams.closeAll();
    // An address this start already bound and could not release is still held
    // by this process. A retry would run against it, so report that first.
    const unreleased = await stopAll();
    if (unreleased.length > 0) throw new HttpStopError(unreleased);
    throw error;
  }

  const urls = servers.map(({ address, server }) =>
    urlFor(address, server.port ?? options.config.port),
  );
  for (const url of urls) options.onListen?.(url);

  const firstPort = servers[0]?.server.port ?? options.config.port;
  return {
    urls,
    port: firstPort,
    async stop() {
      clearInterval(tokenCheck);
      clearInterval(uploadSweep);
      hub.stop();
      streams.closeAll();
      const unreleased = await stopAll();
      await requests.drain(stopTimeoutMs);
      if (unreleased.length > 0) throw new HttpStopError(unreleased);
    },
  };
}
