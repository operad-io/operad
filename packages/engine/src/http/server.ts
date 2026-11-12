/**
 * The HTTP face of the presentation kernel: the same list, get, section,
 * events and act a local client calls, behind one bearer token. Only `serve`
 * starts this; no other command opens the port.
 */

import { randomBytes } from "node:crypto";
import type { HttpConfig } from "../config/config.ts";
import type { LogBackend } from "../log/types.ts";
import { messageOf } from "../plugin/errors.ts";
import { typeFilters } from "../plugin/filters.ts";
import type { PluginRegistry } from "../plugin/registry.ts";
import type { Actor } from "../plugin/types.ts";
import type { Kernel } from "../trigger/kernel.ts";
import { listPending } from "../views/pending.ts";
import {
  DEFAULT_MAX_EVENT_IDS,
  ViewError,
  type ViewEvent,
  type Views,
} from "../views/presentation.ts";
import { listRunning } from "../views/running.ts";
import { validateListenAddresses } from "./address.ts";
import {
  ensureHttpToken,
  readHttpToken,
  tokensEqual,
  type HttpToken,
} from "./token.ts";
import { isRecord } from "../util.ts";

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

/** The largest request body `serve` accepts, in bytes. */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

export interface HttpServerOptions {
  readonly home: string;
  readonly config: HttpConfig;
  readonly views: Views;
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  readonly kernel?: Kernel | undefined;
  readonly onLog?: ((message: string) => void) | undefined;
  /** Called once per address with the URL it listens on. */
  readonly onListen?: ((url: string) => void) | undefined;
  readonly maxEventIds?: number | undefined;
  readonly keepAliveMs?: number | undefined;
  readonly tokenCheckMs?: number | undefined;
  readonly clock?: (() => number) | undefined;
  /** How long `stop` waits for the addresses to release; default 5 seconds. */
  readonly stopTimeoutMs?: number | undefined;
  /** Waits `ms`; tests inject it instead of a timer. */
  readonly wait?: ((ms: number) => Promise<void>) | undefined;
  /** Starts one listener; tests replace it to fake a listener that will not stop. */
  readonly listener?: typeof Bun.serve | undefined;
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
  /** The URLs the server listens on, one per configured address. */
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

/** The bounded stream of ids every event client resumes from. */
export class EventHub {
  private readonly entries: EventEntry[] = [];
  private readonly max: number;
  private readonly listeners = new Set<(entry: EventEntry) => void>();
  private readonly iterator: AsyncIterator<ViewEvent>;
  /** Random once per process: an id from another boot never resumes here. */
  private readonly bootId = randomBytes(8).toString("hex");
  private seq = 0;
  private stopped = false;

  constructor(
    events: AsyncIterable<ViewEvent>,
    max: number,
    onLog: (message: string) => void,
  ) {
    this.max = Math.max(1, max);
    this.iterator = events[Symbol.asyncIterator]();
    void this.pump(onLog);
  }

  private async pump(onLog: (message: string) => void): Promise<void> {
    try {
      while (!this.stopped) {
        const next = await this.iterator.next();
        if (next.done) break;
        this.seq += 1;
        const entry: EventEntry = {
          seq: this.seq,
          event: `${this.bootId}-${this.seq}`,
          id: next.value.id,
        };
        this.entries.push(entry);
        if (this.entries.length > this.max) this.entries.shift();
        for (const listener of [...this.listeners]) listener(entry);
      }
    } catch (error) {
      if (!this.stopped) onLog(`http events: ${messageOf(error)}`);
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

  subscribe(listener: (entry: EventEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  stop(): void {
    this.stopped = true;
    void this.iterator.return?.();
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
export function displayNameOf(type: string): string {
  const words = type
    .split(/[-_\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`);
  return words.length === 0 ? type : words.join(" ");
}

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

function formatEvent(entry: EventEntry): string {
  return `id: ${entry.event}\ndata: ${JSON.stringify({ id: entry.id })}\n\n`;
}

const RESET_EVENT = "event: reset\ndata: {}\n\n";

export function eventResponse(
  request: Request,
  hub: EventHub,
  keepAliveMs: number,
  queueLimit: number,
  token: string,
  track: (token: string, close: () => void) => () => void,
): Response {
  const resumeFrom = lastEventId(request.headers.get("last-event-id"));
  const encoder = new TextEncoder();
  const queue: string[] = [];
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

  const push = (text: string): void => {
    if (closed) return;
    if (queue.length >= queueLimit) {
      // The client is not reading. Drop it rather than grow without bound.
      finish();
      return;
    }
    queue.push(text);
    const resume = wake;
    wake = undefined;
    resume?.();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(started) {
      controller = started;
      // `start` is synchronous, so no event can land between the snapshot and
      // the subscription.
      const snapshot = hub.snapshot(resumeFrom);
      if (snapshot.reset) push(RESET_EVENT);
      else for (const entry of snapshot.replay) push(formatEvent(entry));
      unsubscribe = hub.subscribe((entry) => push(formatEvent(entry)));
      untrack = track(token, finish);
      // An immediate comment flushes the response headers; the client then has
      // a stream even when nothing changes for a while.
      push(": keep-alive\n\n");
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
        started.enqueue(encoder.encode(chunk));
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

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ViewError("args", "the request body is not valid JSON");
  }
}

function createHandler(
  options: HttpServerOptions,
  hub: EventHub,
  streams: StreamRegistry,
  onLog: (message: string) => void,
): (request: Request) => Promise<Response> {
  const keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;
  // One slot past the resume window so a full replay plus the greeting fits.
  const queueLimit = Math.max(1, options.maxEventIds ?? DEFAULT_MAX_EVENT_IDS) + 1;

  const handle = async (
    request: Request,
    token: HttpToken,
  ): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (method === "GET" && path === "/v1/events") {
      return eventResponse(
        request,
        hub,
        keepAliveMs,
        queueLimit,
        token.token,
        (value, close) => streams.track(value, close),
      );
    }

    if (method === "GET" && path === "/v1/types") {
      const seen = new Set<string>();
      const types: {
        type: string;
        title: string;
        plugin: string;
        filters?: readonly { name: string; states?: readonly string[] | undefined }[];
        defaultFilter?: string;
        parents?: readonly string[];
      }[] = [];
      for (const entry of options.registry.objectTypes()) {
        if (seen.has(entry.type)) continue;
        if (options.registry.viewsFor(entry.type) === undefined) continue;
        seen.add(entry.type);
        const filters = typeFilters(entry.definition);
        // The types an action that creates this one works on: where a client offers a new one.
        const parents = [
          ...new Set(
            options.registry
              .actions()
              .filter((action) => action.creates === entry.type)
              .map((action) => action.on),
          ),
        ];
        types.push({
          ...(parents.length === 0 ? {} : { parents }),
          type: entry.type,
          title: displayNameOf(entry.type),
          plugin: entry.plugin,
          ...(filters === undefined
            ? {}
            : { filters: filters.filters, defaultFilter: filters.default }),
        });
      }
      return json({ types });
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
      return json(
        await options.views.set(name, body.value, {
          ...(scope === undefined ? {} : { scope }),
          confirmed: confirmed === true,
        }),
      );
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
        return json(
          await options.views.section(id, section, cursor, {
            full: trueValue(url.searchParams.get("full")),
          }),
        );
      }
      if (rest.length === 0) {
        return errorResponse(404, "not-found", "no such object");
      }
      return json(await options.views.get(decodeSegment(rest)));
    }

    if (path.startsWith("/v1/")) {
      return errorResponse(404, "not-found", "no such endpoint");
    }
    return errorResponse(404, "not-found", "no such endpoint");
  };

  return async (request: Request): Promise<Response> => {
    try {
      const token = await authenticate(
        request.headers.get("authorization"),
        options.home,
      );
      if (token === undefined) {
        return errorResponse(401, "unauthorized", "a bearer token is required");
      }
      return await handle(request, token);
    } catch (error) {
      if (error instanceof ViewError) return viewErrorResponse(error);
      onLog(`http: ${messageOf(error)}`);
      return errorResponse(500, "internal", "the request failed");
    }
  };
}

/** Starts one Bun server per `http.listen` address. */
export async function startHttpServer(
  options: HttpServerOptions,
): Promise<HttpServerHandle> {
  validateListenAddresses(options.config.listen);
  const token = await ensureHttpToken(options.home);

  const onLog = options.onLog ?? (() => undefined);
  const hub = new EventHub(
    options.views.events(),
    options.maxEventIds ?? DEFAULT_MAX_EVENT_IDS,
    onLog,
  );
  const streams = new StreamRegistry();
  const handler = createHandler(options, hub, streams, onLog);
  const servers: { readonly address: string; readonly server: ReturnType<typeof Bun.serve> }[] = [];
  const listener = options.listener ?? Bun.serve;
  const wait =
    options.wait ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        // Unref'd: a stop that finished in time must not keep the process up.
        (setTimeout(resolve, ms) as { unref?: () => void }).unref?.();
      }));
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
    for (const address of options.config.listen) {
      const server = listener({
        hostname: address,
        port: options.config.port,
        // An event stream is quiet by design; the 15-second comment keeps it
        // below this idle limit.
        idleTimeout: 30,
        maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
        fetch: handler,
        error: (error) => {
          onLog(`http: ${messageOf(error)}`);
          return errorResponse(500, "internal", "the request failed");
        },
      });
      servers.push({ address, server });
    }
  } catch (error) {
    clearInterval(tokenCheck);
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
      hub.stop();
      streams.closeAll();
      const unreleased = await stopAll();
      if (unreleased.length > 0) throw new HttpStopError(unreleased);
    },
  };
}
