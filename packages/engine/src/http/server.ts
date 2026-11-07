/**
 * The HTTP face of the presentation kernel: the same list, get, section,
 * events and act a local client calls, behind one bearer token. Only `serve`
 * starts this; no other command opens the port.
 */

import type { HttpConfig } from "../config/config.ts";
import type { LogBackend } from "../log/types.ts";
import { messageOf } from "../plugin/errors.ts";
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

/** How long an idle event stream waits before a keep-alive comment. */
export const DEFAULT_KEEP_ALIVE_MS = 15_000;

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
  readonly clock?: (() => number) | undefined;
}

export interface HttpServerHandle {
  /** The URLs the server listens on, one per configured address. */
  readonly urls: readonly string[];
  readonly port: number;
  stop(): Promise<void>;
}

interface EventEntry {
  readonly seq: number;
  readonly id: string;
}

/** The bounded stream of ids every event client resumes from. */
class EventHub {
  private readonly entries: EventEntry[] = [];
  private readonly max: number;
  private readonly listeners = new Set<(entry: EventEntry) => void>();
  private readonly iterator: AsyncIterator<ViewEvent>;
  private seq = 0;
  private stopped = false;

  constructor(
    views: Views,
    max: number,
    onLog: (message: string) => void,
  ) {
    this.max = Math.max(1, max);
    this.iterator = views.events()[Symbol.asyncIterator]();
    void this.pump(onLog);
  }

  private async pump(onLog: (message: string) => void): Promise<void> {
    try {
      while (!this.stopped) {
        const next = await this.iterator.next();
        if (next.done) break;
        this.seq += 1;
        const entry: EventEntry = { seq: this.seq, id: next.value.id };
        this.entries.push(entry);
        if (this.entries.length > this.max) this.entries.shift();
        for (const listener of [...this.listeners]) listener(entry);
      }
    } catch (error) {
      if (!this.stopped) onLog(`http events: ${messageOf(error)}`);
    }
  }

  snapshot(lastId: number | undefined): {
    readonly reset: boolean;
    readonly replay: readonly EventEntry[];
  } {
    if (lastId === undefined) return { reset: false, replay: [] };
    const oldest = this.entries[0]?.seq;
    const latest = this.entries.at(-1)?.seq;
    if (oldest === undefined || latest === undefined) {
      return { reset: true, replay: [] };
    }
    if (lastId < oldest - 1 || lastId > latest) {
      return { reset: true, replay: [] };
    }
    return { reset: false, replay: this.entries.filter((entry) => entry.seq > lastId) };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function lastEventId(value: string | null): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(text)) return -1;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : -1;
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
  return `id: ${entry.seq}\ndata: ${JSON.stringify({ id: entry.id })}\n\n`;
}

const RESET_EVENT = "event: reset\ndata: {}\n\n";

function eventResponse(
  request: Request,
  hub: EventHub,
  keepAliveMs: number,
): Response {
  const resumeFrom = lastEventId(request.headers.get("last-event-id"));
  const encoder = new TextEncoder();
  const queue: string[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;

  const push = (text: string): void => {
    if (closed) return;
    queue.push(text);
    const resume = wake;
    wake = undefined;
    resume?.();
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    if (keepAlive !== undefined) clearInterval(keepAlive);
    keepAlive = undefined;
    const resume = wake;
    wake = undefined;
    resume?.();
  };

  const stream = new ReadableStream<Uint8Array>({
    start() {
      // `start` is synchronous, so no event can land between the snapshot and
      // the subscription.
      const snapshot = hub.snapshot(resumeFrom);
      if (snapshot.reset) push(RESET_EVENT);
      else for (const entry of snapshot.replay) push(formatEvent(entry));
      unsubscribe = hub.subscribe((entry) => push(formatEvent(entry)));
      // An immediate comment flushes the response headers; the client then has
      // a stream even when nothing changes for a while.
      push(": keep-alive\n\n");
      keepAlive = setInterval(() => push(": keep-alive\n\n"), keepAliveMs);
      (keepAlive as { unref?: () => void }).unref?.();
      request.signal.addEventListener("abort", close, { once: true });
    },
    async pull(controller) {
      while (!closed && queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const chunk = queue.shift();
      if (chunk !== undefined) {
        controller.enqueue(encoder.encode(chunk));
        return;
      }
      controller.close();
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
  onLog: (message: string) => void,
): (request: Request) => Promise<Response> {
  const keepAliveMs = options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS;

  const handle = async (
    request: Request,
    token: HttpToken,
  ): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (method === "GET" && path === "/v1/events") {
      return eventResponse(request, hub, keepAliveMs);
    }

    if (method === "GET" && path === "/v1/types") {
      const seen = new Set<string>();
      const types: { type: string; title: string }[] = [];
      for (const entry of options.registry.objectTypes()) {
        if (seen.has(entry.type)) continue;
        if (options.registry.viewsFor(entry.type) === undefined) continue;
        seen.add(entry.type);
        types.push({ type: entry.type, title: displayNameOf(entry.type) });
      }
      return json({ types });
    }

    if (method === "GET" && path === "/v1/objects") {
      const type = url.searchParams.get("type");
      if (type === null || type.trim().length === 0) {
        return errorResponse(400, "args", "the query needs a type");
      }
      const cursor = url.searchParams.get("cursor") ?? undefined;
      return json(
        await options.views.list(
          type,
          cursor === undefined ? {} : { cursor },
        ),
      );
    }

    if (method === "GET" && path === "/v1/pending") {
      return json(
        await listPending(options.log, options.registry, options.kernel),
      );
    }

    if (method === "GET" && path === "/v1/running") {
      return json(await listRunning(options.log, options.clock));
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
      const id = body.id;
      if (typeof id !== "string" || id.length === 0) {
        return errorResponse(400, "args", "the body needs an id");
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
      const actor: Actor = { via: "http", id: token.label };
      try {
        const result = await options.views.act(action, id, {
          args,
          ...(note === undefined ? {} : { note }),
          yes: confirmed === true,
          actor,
        });
        return json(result);
      } catch (error) {
        if (error instanceof ViewError) throw error;
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
  await ensureHttpToken(options.home);

  const onLog = options.onLog ?? (() => undefined);
  const hub = new EventHub(
    options.views,
    options.maxEventIds ?? DEFAULT_MAX_EVENT_IDS,
    onLog,
  );
  const handler = createHandler(options, hub, onLog);
  const servers: { readonly address: string; readonly server: ReturnType<typeof Bun.serve> }[] = [];

  try {
    for (const address of options.config.listen) {
      const server = Bun.serve({
        hostname: address,
        port: options.config.port,
        // An event stream is quiet by design; the 15-second comment keeps it
        // below this idle limit.
        idleTimeout: 30,
        fetch: handler,
        error: (error) => {
          onLog(`http: ${messageOf(error)}`);
          return errorResponse(500, "internal", "the request failed");
        },
      });
      servers.push({ address, server });
    }
  } catch (error) {
    hub.stop();
    for (const { server } of servers) {
      await server.stop(true).catch(() => undefined);
    }
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
      hub.stop();
      for (const { server } of servers) {
        await server.stop(true).catch(() => undefined);
      }
    },
  };
}
