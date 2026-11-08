import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_HTTP_TOKEN_LABEL,
  DEFAULT_KEEP_ALIVE_MS,
  FilePluginStore,
  MemoryPluginStore,
  createViews,
  listenAddressKind,
  loadPluginRegistry,
  openConfigLog,
  readConfig,
  readHttpToken,
  rotateHttpToken,
  startHttpServer,
  storeRootOf,
  validateListenAddresses,
  type HttpServerHandle,
  type LogBackend,
  type PluginRegistry,
  type ViewEvent,
  type Views,
} from "../../src/index.ts";
import { EventHub, eventResponse } from "../../src/http/server.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const pluginPath = fileURLToPath(
  new URL("../fixtures/plugins/http.ts", import.meta.url),
);

interface Harness {
  readonly root: string;
  readonly home: string;
  readonly storeRoot: string;
  readonly store: MemoryPluginStore | FilePluginStore;
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  readonly views: Views;
  readonly server: HttpServerHandle;
  readonly base: string;
  readonly token: string;
  close(): Promise<void>;
}

interface HarnessOptions {
  readonly memory?: boolean;
  readonly maxEventIds?: number;
  readonly keepAliveMs?: number;
  readonly tokenCheckMs?: number;
  readonly loadTimeoutMs?: number;
  /** Written to `<home>/keys.json` before the plugins load. */
  readonly userKeys?: Record<string, string>;
}

async function freePort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(""),
  });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error("the free-port probe bound no port");
  return port;
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [pluginPath],
      store: { backend: "jsonl", path: join(root, "store") },
      http: { enabled: true, port: 0, listen: ["127.0.0.1"] },
    }),
  );
  if (options.userKeys !== undefined) {
    writeFileSync(join(home, "keys.json"), JSON.stringify(options.userKeys));
  }
  const config = await readConfig(home);
  const storeRoot = storeRootOf(config);
  const store =
    options.memory === false
      ? new FilePluginStore({ root: join(storeRoot, "plugins") })
      : new MemoryPluginStore({ root: storeRoot });
  const log = openConfigLog(config);
  const registry = await loadPluginRegistry({ home, store });
  const views = createViews({
    registry,
    store,
    log,
    loadTimeoutMs: options.loadTimeoutMs ?? 200,
    onLog: () => undefined,
  });
  const port = await freePort();
  const server = await startHttpServer({
    home,
    config: { enabled: true, port, listen: ["127.0.0.1"] },
    views,
    log,
    registry,
    ...(options.maxEventIds === undefined
      ? {}
      : { maxEventIds: options.maxEventIds }),
    ...(options.keepAliveMs === undefined
      ? {}
      : { keepAliveMs: options.keepAliveMs }),
    ...(options.tokenCheckMs === undefined
      ? {}
      : { tokenCheckMs: options.tokenCheckMs }),
    onLog: () => undefined,
  });
  const token = await readHttpToken(home);
  if (token === undefined) throw new Error("the server created no token");

  return {
    root,
    home,
    storeRoot,
    store,
    log,
    registry,
    views,
    server,
    base: server.urls[0] ?? `http://127.0.0.1:${port}`,
    token: token.token,
    async close() {
      await server.stop();
      views.close();
      await log.close();
    },
  };
}

function authHeaders(
  h: Harness,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { authorization: `Bearer ${h.token}`, ...extra };
}

function api(
  h: Harness,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${h.base}${path}`, {
    ...init,
    headers: authHeaders(h, (init.headers as Record<string, string>) ?? {}),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

interface SseEvent {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
}

function parseSseBlock(block: string): SseEvent | undefined {
  if (block.trimStart().startsWith(":")) return undefined;
  let id: string | undefined;
  let event: string | undefined;
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data = data.length === 0 ? value : `${data}\n${value}`;
  }
  return id === undefined && event === undefined && data === ""
    ? undefined
    : {
        ...(id === undefined ? {} : { id }),
        ...(event === undefined ? {} : { event }),
        data,
      };
}

interface SseReader {
  next(count?: number): Promise<SseEvent[]>;
  cancel(): Promise<void>;
}

/** One reader over one event stream, so a test can read only what it wants. */
function openSse(response: Response, timeoutMs = 5_000): SseReader {
  const body = response.body;
  if (body === null) throw new Error("the event stream has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const timer = setTimeout(() => {
    void reader.cancel();
  }, timeoutMs);

  const next = async (count = 1): Promise<SseEvent[]> => {
    const events: SseEvent[] = [];
    while (events.length < count) {
      for (;;) {
        const at = buffer.indexOf("\n\n");
        if (at < 0) break;
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const event = parseSseBlock(block);
        if (event !== undefined) events.push(event);
      }
      if (events.length >= count) break;
      const read = await reader.read();
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
    }
    if (events.length < count) {
      throw new Error(`expected ${count} events, saw ${events.length}`);
    }
    return events;
  };

  return {
    next,
    async cancel() {
      clearTimeout(timer);
      await reader.cancel().catch(() => undefined);
    },
  };
}

async function readSse(
  response: Response,
  count: number,
  timeoutMs = 5_000,
): Promise<SseEvent[]> {
  const reader = openSse(response, timeoutMs);
  try {
    return await reader.next(count);
  } finally {
    await reader.cancel();
  }
}

async function readKeepAlive(response: Response, timeoutMs = 5_000): Promise<boolean> {
  const body = response.body;
  if (body === null) throw new Error("the event stream has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const timer = setTimeout(() => {
    void reader.cancel();
  }, timeoutMs);
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) return false;
      if (decoder.decode(read.value, { stream: true }).includes(": keep-alive")) {
        return true;
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
  }
}

function openStream(
  h: Harness,
  headers: Record<string, string> = {},
  base = h.base,
): { readonly response: Promise<Response>; readonly abort: () => void } {
  const controller = new AbortController();
  return {
    response: fetch(`${base}/v1/events`, {
      headers: authHeaders(h, headers),
      signal: controller.signal,
    }),
    abort: () => controller.abort(),
  };
}

/** Reads until the stream ends; false when it stayed open past the timeout. */
async function readUntilDone(
  response: Response,
  timeoutMs = 5_000,
): Promise<boolean> {
  const body = response.body;
  if (body === null) throw new Error("the event stream has no body");
  const reader = body.getReader();
  const timer = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(false), timeoutMs);
  });
  const drained = (async (): Promise<boolean> => {
    for (;;) {
      const read = await reader.read();
      if (read.done) return true;
    }
  })();
  const ended = await Promise.race([drained, timer]);
  if (!ended) await reader.cancel().catch(() => undefined);
  return ended;
}

function seed(h: Harness, id: string, data: Record<string, unknown>): void {
  h.store.put("item", id, data, "seed");
}

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

describe("http server", () => {
  test("GET /v1/keys lists the plugin defaults and the person's overrides", async () => {
    const plain = await makeHarness();
    try {
      const response = await api(plain, "/v1/keys");
      expect(response.status).toBe(200);
      expect(await json(response)).toEqual({
        keys: [{ key: "m", action: "webtest:approve", source: "plugin" }],
      });
    } finally {
      await plain.close();
    }
    const custom = await makeHarness({ userKeys: { m: "webtest:drop", x: "webtest:approve" } });
    try {
      const body = await json(await api(custom, "/v1/keys"));
      expect(body.keys).toEqual([
        { key: "m", action: "webtest:drop", source: "user" },
        { key: "x", action: "webtest:approve", source: "user" },
      ]);
    } finally {
      await custom.close();
    }
  });

  test("refuses a missing, a wrong and a rotated token", async () => {
    const h = await makeHarness();
    try {
      const missing = await fetch(`${h.base}/v1/types`);
      expect(missing.status).toBe(401);

      const wrong = await fetch(`${h.base}/v1/types`, {
        headers: { authorization: "Bearer not-the-token" },
      });
      expect(wrong.status).toBe(401);

      const good = await api(h, "/v1/types");
      expect(good.status).toBe(200);

      await rotateHttpToken(h.home);
      const old = await api(h, "/v1/types");
      expect(old.status).toBe(401);

      const fresh = await readHttpToken(h.home);
      expect(fresh).toBeDefined();
      if (fresh === undefined) return;
      const next = await fetch(`${h.base}/v1/types`, {
        headers: { authorization: `Bearer ${fresh.token}` },
      });
      expect(next.status).toBe(200);
      expect(fresh.token).not.toBe(h.token);

      const secrets = join(h.home, "secrets");
      expect(statSync(secrets).mode & 0o777).toBe(0o700);
      expect(statSync(join(secrets, "http.json")).mode & 0o777).toBe(0o600);
    } finally {
      await h.close();
    }
  });

  test("classifies every listen address class and refuses a wildcard", () => {
    for (const address of [
      "127.0.0.1",
      "127.10.20.30",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.10.2",
      "100.64.0.1",
      "100.127.255.255",
      "::1",
      "fe80::1",
      "fd7a:115c:a1e0::1",
    ]) {
      expect(listenAddressKind(address)).toBeDefined();
    }
    for (const address of [
      "8.8.8.8",
      "172.32.0.1",
      "100.128.0.1",
      "192.169.0.1",
      "fc00::1",
      "fd7a:115c:a1e1::1",
      "2001:db8::1",
    ]) {
      expect(listenAddressKind(address)).toBeUndefined();
    }

    expect(() => validateListenAddresses([])).toThrow(/at least one/);
    expect(() => validateListenAddresses(["not-an-ip"])).toThrow(/not-an-ip/);
    expect(() => validateListenAddresses(["10.0.0.1", "8.8.8.8"])).toThrow(
      /8\.8\.8\.8/,
    );
    expect(() => validateListenAddresses(["0.0.0.0"])).toThrow(/wildcard/);
    expect(() => validateListenAddresses(["0.0.0.0"])).toThrow(/0\.0\.0\.0/);
    expect(() => validateListenAddresses(["::"])).toThrow(/wildcard/);
    expect(() => validateListenAddresses(["::"])).toThrow(/::/);
  });

  test("lists types and objects, gets one object, and pages a section", async () => {
    const h = await makeHarness();
    try {
      seed(h, "one", { title: "First", state: "new", note: "$1" });
      seed(h, "two", { title: "Second", state: "open" });

      const types = await api(h, "/v1/types");
      expect(types.status).toBe(200);
      expect(await json(types)).toEqual({
        types: [{ type: "item", title: "Item" }],
      });

      const list = await api(h, "/v1/objects?type=item");
      expect(list.status).toBe(200);
      const page = await json(list);
      const rows = page.rows as { id: string; title: string; note?: string }[];
      expect(rows.map((row) => row.id)).toEqual(["one", "two"]);
      expect(rows[0]?.note).toBe("$1");

      const unknown = await api(h, "/v1/objects?type=absent");
      expect(unknown.status).toBe(404);
      expect((await json(unknown)).error).toMatchObject({ kind: "no-views" });

      const one = await api(h, "/v1/objects/one");
      expect(one.status).toBe(200);
      const object = await json(one);
      expect(object.type).toBe("item");
      const sections = object.sections as { id: string }[];
      expect(sections.map((section) => section.id)).toContain("info");
      expect(sections.at(-1)?.id).toBe("history");
      const actions = object.actions as {
        name: string;
        confirm: boolean;
        args?: unknown;
      }[];
      const approve = actions.find((action) => action.name === "webtest:approve");
      expect(approve?.confirm).toBe(false);
      expect(approve?.args).toBeDefined();
      const drop = actions.find((action) => action.name === "webtest:drop");
      expect(drop?.confirm).toBe(true);
      expect(actions.some((action) => action.name === "webtest:hidden")).toBe(
        false,
      );

      const first = await api(h, "/v1/objects/one/sections/pages");
      expect(first.status).toBe(200);
      expect(await json(first)).toEqual({ markdown: "page one", next: "two" });

      const second = await api(
        h,
        "/v1/objects/one/sections/pages?cursor=two",
      );
      expect(await json(second)).toEqual({ markdown: "page two" });

      const info = await api(h, "/v1/objects/one/sections/info?full=true");
      expect((await json(info)).markdown).toBe("# Item\n\nSome **text**.");

      const history = await api(h, "/v1/objects/one/sections/history");
      expect(history.status).toBe(200);
      expect(String((await json(history)).markdown)).toContain("No history");

      const missing = await api(h, "/v1/objects/missing");
      expect(missing.status).toBe(404);

      const missingSection = await api(h, "/v1/objects/one/sections/absent");
      expect(missingSection.status).toBe(404);
      expect((await json(missingSection)).error).toMatchObject({
        kind: "section",
      });

      const slow = await makeHarness({ loadTimeoutMs: 20 });
      try {
        seed(slow, "one", { title: "First", state: "new" });
        const hang = await api(slow, "/v1/objects/one/sections/hang");
        expect(hang.status).toBe(504);
        expect((await json(hang)).error).toMatchObject({ kind: "timeout" });
      } finally {
        await slow.close();
      }

      const badCursor = await api(h, "/v1/objects?type=item&cursor=nope");
      expect(badCursor.status).toBe(400);
    } finally {
      await h.close();
    }
  });

  test("acts with a note, refuses without one, and needs confirmed for a confirm action", async () => {
    const h = await makeHarness();
    try {
      seed(h, "one", { title: "First", state: "new" });

      const noNote = await api(h, "/v1/act", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "webtest:approve", id: "item:one" }),
      });
      expect(noNote.status).toBe(400);
      expect((await json(noNote)).error).toMatchObject({ kind: "note" });

      const approve = await api(h, "/v1/act", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "webtest:approve",
          id: "item:one",
          note: "looks good",
        }),
      });
      expect(approve.status).toBe(200);
      const run = await json(approve);
      expect(run.name).toBe("webtest:approve");
      expect(h.store.get("item", "one")?.data.approvedNote).toBe("looks good");
      expect(h.store.get("item", "one")?.data.approvedBy).toBe(
        DEFAULT_HTTP_TOKEN_LABEL,
      );

      const actor = h.store
        .facts()
        .find((fact) => fact.type === "action_invoked");
      expect(actor?.data.actor).toEqual({
        via: "http",
        id: DEFAULT_HTTP_TOKEN_LABEL,
      });

      const again = await api(h, "/v1/act", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "webtest:approve",
          id: "item:one",
          note: "again",
        }),
      });
      expect(again.status).toBe(409);
      expect((await json(again)).error).toMatchObject({
        kind: "not-available",
      });

      const hidden = await api(h, "/v1/act", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "webtest:hidden", id: "item:one" }),
      });
      expect(hidden.status).toBe(409);

      const refused = await api(h, "/v1/act", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "webtest:fail", id: "item:one" }),
      });
      expect(refused.status).toBe(422);
      expect((await json(refused)).error).toMatchObject({
        kind: "refused",
        message: "the plugin refused",
      });

      const unknown = await api(h, "/v1/act", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "nobody:nothing", id: "item:one" }),
      });
      expect(unknown.status).toBe(404);
      expect((await json(unknown)).error).toMatchObject({ kind: "action" });

      const badJson = await api(h, "/v1/act", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      expect(badJson.status).toBe(400);

      const dropRefused = await api(h, "/v1/act", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "webtest:drop", id: "item:one" }),
      });
      expect(dropRefused.status).toBe(409);
      const confirmError = (await json(dropRefused)).error as {
        kind: string;
        message: string;
      };
      expect(confirmError.kind).toBe("confirm");
      expect(confirmError.message).toContain("webtest:drop");
      expect(confirmError.message).toContain('"confirmed": true');
      expect(confirmError.message).not.toContain("--yes");

      const drop = await api(h, "/v1/act", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "webtest:drop",
          id: "item:one",
          confirmed: true,
        }),
      });
      expect(drop.status).toBe(200);
      expect(h.store.get("item", "one")?.data.dropped).toBe(true);
    } finally {
      await h.close();
    }
  });

  test("accepts an act body without an id and lets the views name the missing object", async () => {
    const h = await makeHarness();
    try {
      seed(h, "one", { title: "First", state: "new" });

      const missing = await api(h, "/v1/act", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "webtest:approve" }),
      });
      expect(missing.status).toBe(404);
      const missingError = (await json(missing)).error as {
        kind: string;
        message: string;
      };
      expect(missingError.kind).toBe("not-found");
      expect(missingError.message).toContain("object id");
      expect(h.store.get("item", "one")?.data.approved).toBeUndefined();

      const unknown = await api(h, "/v1/act", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "nobody:nothing" }),
      });
      expect(unknown.status).toBe(404);
      expect((await json(unknown)).error).toMatchObject({ kind: "action" });
    } finally {
      await h.close();
    }
  });

  test("streams changes, resumes from Last-Event-ID and resets an old id", async () => {
    const h = await makeHarness();
    try {
      const first = openStream(h);
      const stream = await first.response;
      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      seed(h, "alpha", { title: "Alpha", state: "new" });
      const [event] = await readSse(stream, 1);
      const firstId = event?.id;
      expect(firstId).toMatch(/^[0-9a-f]+-1$/);
      expect(event?.data).toBe(JSON.stringify({ id: "alpha" }));
      first.abort();
      if (firstId === undefined) return;

      // The next two changes happen while no client is attached.
      seed(h, "beta", { title: "Beta", state: "new" });
      seed(h, "gamma", { title: "Gamma", state: "new" });

      const second = openStream(h, { "last-event-id": firstId });
      const missed = await readSse(await second.response, 2);
      expect(missed.map((item) => item.data)).toEqual([
        JSON.stringify({ id: "beta" }),
        JSON.stringify({ id: "gamma" }),
      ]);
      second.abort();

      const small = await makeHarness({ maxEventIds: 2 });
      try {
        const window = openStream(small);
        const events = openSse(await window.response);
        const ids: string[] = [];
        for (const id of ["a", "b", "c", "d"]) {
          seed(small, id, { title: id, state: "new" });
          const [seen] = await events.next();
          if (seen?.id !== undefined) ids.push(seen.id);
        }
        expect(ids.map((id) => id.split("-")[1])).toEqual([
          "1",
          "2",
          "3",
          "4",
        ]);
        await events.cancel();
        window.abort();

        const oldId = ids[0];
        expect(oldId).toBeDefined();
        if (oldId === undefined) return;
        const reset = openStream(small, { "last-event-id": oldId });
        const [resetEvent] = await readSse(await reset.response, 1);
        expect(resetEvent?.event).toBe("reset");
        expect(resetEvent?.data).toBe("{}");
        reset.abort();
      } finally {
        await small.close();
      }
    } finally {
      await h.close();
    }
  });

  test("a Last-Event-ID from an earlier serve gets one reset", async () => {
    const h = await makeHarness();
    let restarted: HttpServerHandle | undefined;
    try {
      const first = openStream(h);
      const firstResponse = await first.response;
      seed(h, "alpha", { title: "Alpha", state: "new" });
      const [event] = await readSse(firstResponse, 1);
      first.abort();
      const oldId = event?.id;
      expect(oldId).toBeDefined();
      if (oldId === undefined) return;

      await h.server.stop();
      const port = await freePort();
      restarted = await startHttpServer({
        home: h.home,
        config: { enabled: true, port, listen: ["127.0.0.1"] },
        views: h.views,
        log: h.log,
        registry: h.registry,
        tokenCheckMs: 20,
        onLog: () => undefined,
      });
      const base = restarted.urls[0];
      if (base === undefined) throw new Error("the restarted server bound no port");

      // The new process has events of its own, so a numeric resume would look
      // valid and silently skip everything from the first process.
      const probe = openStream(h, {}, base);
      const probeSse = openSse(await probe.response);
      seed(h, "beta", { title: "Beta", state: "new" });
      seed(h, "gamma", { title: "Gamma", state: "new" });
      await probeSse.next(2);
      await probeSse.cancel();
      probe.abort();

      const resume = openStream(h, { "last-event-id": oldId }, base);
      const [reset] = await readSse(await resume.response, 1);
      expect(reset?.event).toBe("reset");
      expect(reset?.data).toBe("{}");
      resume.abort();
    } finally {
      if (restarted !== undefined) await restarted.stop();
      await h.close();
    }
  });

  test("ends a client that stops reading instead of growing without bound", async () => {
    let pushed = (): void => undefined;
    const allPushed = new Promise<void>((resolve) => {
      pushed = resolve;
    });
    async function* feed(): AsyncGenerator<ViewEvent> {
      for (let index = 0; index < 5; index += 1) {
        yield { id: `e${index}` };
      }
      pushed();
    }
    const hub = new EventHub(feed(), 2, () => undefined);
    try {
      const response = eventResponse(
        new Request("http://localhost/v1/events"),
        hub,
        DEFAULT_KEEP_ALIVE_MS,
        3,
        "a-token",
        () => () => undefined,
      );
      // No reader until the queue has overflowed and the stream has closed.
      await allPushed;
      expect(await readUntilDone(response)).toBe(true);
    } finally {
      hub.stop();
    }
  });

  test("rotating the token ends the event streams opened with the old one", async () => {
    const h = await makeHarness({ tokenCheckMs: 10 });
    try {
      const stream = openStream(h);
      const response = await stream.response;
      await rotateHttpToken(h.home);
      expect(await readUntilDone(response)).toBe(true);
      stream.abort();
    } finally {
      await h.close();
    }
  });

  test("refuses a request body larger than one mebibyte", async () => {
    const h = await makeHarness();
    try {
      const body = JSON.stringify({
        action: "webtest:approve",
        id: "item:one",
        note: "x".repeat(1024 * 1024 + 1),
      });
      const response = await api(h, "/v1/act", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(413);
    } finally {
      await h.close();
    }
  });

  test("an object carries its link, URL-encoded, and so does its pending item", async () => {
    const h = await makeHarness();
    try {
      const id = "a b/c#1?x=%";
      seed(h, id, { title: "Odd id", state: "new" });
      const link = `operad://objects/item%3A${encodeURIComponent(id)}`;
      expect(link).toBe("operad://objects/item%3Aa%20b%2Fc%231%3Fx%3D%25");

      const got = await api(h, `/v1/objects/${encodeURIComponent(id)}`);
      expect(got.status).toBe(200);
      const body = (await got.json()) as { id: string; link: string };
      expect(body.id).toBe(id);
      expect(body.link).toBe(link);

      // The link is the id as `get` takes it: following it finds the object.
      const path = link.slice("operad://objects/".length);
      const again = await api(h, `/v1/objects/${path}`);
      expect(again.status).toBe(200);
      expect(((await again.json()) as { id: string }).id).toBe(id);

      const run = await h.log.startRun("demo-flow", `item:${id}`);
      await h.log.append(run.runId, 0, [
        {
          kind: "waiting_for_person",
          payload: {
            waitId: "wait:1",
            step: "ask",
            prompt: "Approve?",
            choices: ["yes"],
            waitKind: "step",
            effectId: null,
          },
          cause: "test",
        },
      ]);
      const pending = (await (await api(h, "/v1/pending")).json()) as { link?: string }[];
      expect(pending[0]?.link).toBe(link);
    } finally {
      await h.close();
    }
  });

  test("lists pending and running runs with their actions", async () => {
    const h = await makeHarness();
    try {
      seed(h, "one", { title: "First", state: "new" });
      seed(h, "two", { title: "Second", state: "new" });

      const waiting = await h.log.startRun("demo-flow", "item:one");
      await h.log.append(waiting.runId, 0, [
        {
          kind: "waiting_for_person",
          payload: {
            waitId: "wait:1",
            step: "ask",
            prompt: "Approve?",
            choices: ["yes"],
            waitKind: "step",
            effectId: null,
          },
          cause: "test",
        },
      ]);
      await h.log.startRun("demo-flow", "item:two");

      const pending = await api(h, "/v1/pending");
      expect(pending.status).toBe(200);
      const pendingItems = (await pending.json()) as {
        runId: string;
        prompt: string;
        choices: string[];
        actions: { plugin: string; action: string }[];
      }[];
      expect(pendingItems).toHaveLength(1);
      expect(pendingItems[0]?.runId).toBe(waiting.runId);
      expect(pendingItems[0]).toMatchObject({
        object: "item:one",
        link: "operad://objects/item%3Aone",
      });
      expect(pendingItems[0]?.prompt).toBe("Approve?");
      expect(pendingItems[0]?.choices).toEqual(["yes"]);
      expect(pendingItems[0]?.actions).toContainEqual({
        plugin: "webtest",
        action: "approve",
      });
      expect(pendingItems[0]?.actions).toContainEqual({
        plugin: "webtest",
        action: "drop",
      });

      const running = await api(h, "/v1/running");
      expect(running.status).toBe(200);
      const runningItems = (await running.json()) as {
        runId: string;
        flow: string;
        elapsedMs: number;
      }[];
      expect(runningItems).toHaveLength(1);
      expect(runningItems[0]?.flow).toBe("demo-flow");
      expect(runningItems[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
    } finally {
      await h.close();
    }
  });

  test("sends a keep-alive comment when the stream is idle", async () => {
    const h = await makeHarness({ keepAliveMs: 10 });
    try {
      const stream = openStream(h);
      const response = await stream.response;
      expect(await readKeepAlive(response)).toBe(true);
      stream.abort();
    } finally {
      await h.close();
    }
  });

  test("never writes the token to the store, its facts or history", async () => {
    const h = await makeHarness({ memory: false });
    try {
      seed(h, "one", { title: "First", state: "new" });
      const response = await api(h, "/v1/act", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "webtest:approve",
          id: "item:one",
          note: "a note",
        }),
      });
      expect(response.status).toBe(200);

      const token = h.token;
      for (const file of walk(h.storeRoot)) {
        expect(readFileSync(file, "utf8")).not.toContain(token);
      }
      const facts = JSON.stringify(h.store.facts());
      expect(facts).not.toContain(token);
      const history = await h.views.section("item:one", "history");
      expect(history.markdown).not.toContain(token);
    } finally {
      await h.close();
    }
  });
});
