// A plugin that starts after the HTTP server answers (ADR 0029 D4).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createViews,
  definePlugin,
  Kernel,
  MemoryPluginStore,
  openLog,
  PluginRegistry,
  readHttpToken,
  startHttpServer,
  type PluginHttp,
  type PluginStreamEvent,
} from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await cleanupTempRoots();
});

/** A source plugin whose start ends only once the test releases it. */
function gated(
  name: string,
  options: { readonly fails?: boolean; readonly withoutRules?: boolean; readonly http?: Partial<PluginHttp> } = {},
) {
  let release: () => void = () => undefined;
  let gate = Promise.resolve();
  const hold = (): void => {
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  hold();
  const readers = new Set<(event: PluginStreamEvent) => void>();
  const send = (event: string, data: unknown): void => {
    for (const reader of [...readers]) reader({ name: event, data });
  };
  const plugin = definePlugin({
    name,
    kind: "domain",
    version: "0.0.0",
    startsWithoutRules: options.withoutRules === true,
    async start() {
      await gate;
      if (options.fails === true) throw new Error("no");
      const http: PluginHttp = {
        request: () => ({ status: 200, body: { items: [] } }),
        stream: () => ({
          open(reader) {
            readers.add(reader);
            reader({ name: "joined", data: 0 });
            return () => {
              readers.delete(reader);
            };
          },
        }),
        ...options.http,
      };
      return {
        stop() {
          send("stopping", 0);
          hold();
        },
        http,
      };
    },
  });
  return { plugin, release: () => release(), send, readers };
}

/** A server and a kernel put together as `serve` does, with no source started yet. */
async function serveWith(plugins: readonly ReturnType<typeof gated>[]) {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const store = new MemoryPluginStore({ root: join(root, "plugins") });
  const logs: string[] = [];
  const onLog = (message: string): void => {
    logs.push(message);
  };
  const registry = new PluginRegistry(
    plugins.map((item) => item.plugin),
    { home, store, onLog },
  );
  const log = openLog({ path: join(root, "log.sqlite") });
  const views = createViews({ registry, store, log });
  const kernel = new Kernel({ log, registry, home, storeRoot: root, rules: [], client: views, onLog });
  const server = await startHttpServer({
    home,
    config: { enabled: true, port: 0, listen: ["127.0.0.1"] },
    views,
    log,
    registry,
    kernel,
    pluginHttp: (name) => kernel.pluginHttp(name),
    pluginStarting: (name) => kernel.pluginStarting(name),
    watchPlugins: (watcher) => kernel.watchPlugins(watcher),
    onLog,
  });
  closers.push(async () => {
    await server.stop();
    await kernel.stopSources();
    views.close();
    await log.close();
  });
  const token = (await readHttpToken(home))?.token ?? "";
  const call = (path: string) =>
    fetch(`${server.urls[0] ?? ""}${path}`, { headers: { authorization: `Bearer ${token}` } });

  /** An event stream and everything read from it so far. */
  const stream = async (query: string) => {
    const response = await call(`/v1/events?${query}`);
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    /** Reads until the text holds `needle`; to the end of the stream without one. */
    const read = async (needle?: string): Promise<string> => {
      while (needle === undefined || !text.includes(needle)) {
        const chunk = await reader?.read();
        if (chunk === undefined || chunk.done) {
          if (needle !== undefined) throw new Error(`the stream ended without ${needle}: ${text}`);
          break;
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text;
    };
    return { status: response.status, read };
  };
  return { kernel, call, stream, logs };
}

/** The event names of a stream's text, in order. */
const names = (text: string): string[] =>
  [...text.matchAll(/^event: (.*)$/gm)].map((match) => match[1] ?? "");

describe("a stream opened before a plugin starts", () => {
  test("gets a reset and then the plugin's events once it runs", async () => {
    const clock = gated("clock");
    const served = await serveWith([clock]);
    const starting = served.kernel.startSources();
    const stream = await served.stream("clock=1");
    expect(stream.status).toBe(200);
    clock.release();
    await starting;
    clock.send("tick", 1);
    expect(names(await stream.read("clock.tick"))).toEqual(["reset", "clock.joined", "clock.tick"]);
  });

  test("leaves a plugin that stops and joins it again when it starts", async () => {
    const clock = gated("clock");
    const served = await serveWith([clock]);
    clock.release();
    await served.kernel.startSources();
    const stream = await served.stream("clock=1");
    await served.kernel.stopSources();
    // What it said while stopping was heard, and then the stream left it.
    await stream.read("clock.stopping");
    expect(clock.readers.size).toBe(0);
    const starting = served.kernel.startSources();
    clock.release();
    await starting;
    clock.send("tick", 2);
    expect(names(await stream.read("clock.tick"))).toEqual([
      "clock.joined",
      "clock.stopping",
      "reset",
      "clock.joined",
      "clock.tick",
    ]);
  });

  test("does not wait for a slower plugin, and joins only the plugins it names", async () => {
    const quick = gated("quick");
    const slow = gated("slow");
    const served = await serveWith([quick, slow]);
    const starting = served.kernel.startSources();
    const both = await served.stream("quick=1&slow=1");
    const one = await served.stream("slow=1");
    quick.release();
    // `slow` is still starting.
    await both.read("quick.joined");
    expect((await served.call("/v1/quick")).status).toBe(200);
    expect((await served.call("/v1/slow")).status).toBe(503);
    slow.release();
    await starting;
    await both.read("slow.joined");
    expect(names(await one.read("slow.joined"))).toEqual(["reset", "slow.joined"]);
  });

  test("ends when the plugin refuses its part, so the next one is told why", async () => {
    const guarded = gated("guarded", {
      http: { stream: () => ({ status: 403, body: { error: "no" } }) },
    });
    const served = await serveWith([guarded]);
    const starting = served.kernel.startSources();
    const stream = await served.stream("guarded=1");
    guarded.release();
    await starting;
    expect(names(await stream.read())).toEqual([]);
    expect((await served.stream("guarded=1")).status).toBe(403);
  });

  test("ends when the plugin's part cannot be opened, and the other plugins still start", async () => {
    const broken = gated("broken", {
      http: {
        stream: () => ({
          open() {
            throw new Error("cannot open");
          },
        }),
      },
    });
    const other = gated("other");
    const served = await serveWith([broken, other]);
    const starting = served.kernel.startSources();
    const stream = await served.stream("broken=1");
    broken.release();
    other.release();
    await starting;
    await stream.read();
    expect(served.logs).toContain('plugin "broken": cannot open');
    expect((await served.call("/v1/other")).status).toBe(200);
  });
});

describe("the routes of a plugin that is not running", () => {
  test("say it is starting, with when to ask again, until it runs", async () => {
    const clock = gated("clock");
    const served = await serveWith([clock]);
    const ask = async () => {
      const response = await served.call("/v1/clock");
      return {
        status: response.status,
        retry: response.headers.get("retry-after"),
        body: await response.json(),
      };
    };
    const waiting = {
      status: 503,
      retry: "1",
      body: { error: { kind: "unavailable", message: 'plugin "clock" is starting; try again' } },
    };
    // Before the sources are started, and while this one starts.
    expect(await ask()).toEqual(waiting);
    const starting = served.kernel.startSources();
    expect(await ask()).toEqual(waiting);
    clock.release();
    await starting;
    expect(await ask()).toEqual({ status: 200, retry: null, body: { items: [] } });
    expect((await served.call("/v1/nobody")).status).toBe(404);
  });

  test("are not found when its start failed or is not tried", async () => {
    const failing = gated("failing", { fails: true });
    const served = await serveWith([failing]);
    failing.release();
    await served.kernel.startSources();
    expect((await served.call("/v1/failing")).status).toBe(404);

    // Without the trigger rules a plugin that needs them is not started.
    const skipped = await serveWith([gated("skipped")]);
    await skipped.kernel.startSources({ rulesLoaded: false });
    expect((await skipped.call("/v1/skipped")).status).toBe(404);
  });

  test("are not found when it is not tried, while an earlier plugin is still starting", async () => {
    const first = gated("first", { withoutRules: true });
    const served = await serveWith([first, gated("later")]);
    const starting = served.kernel.startSources({ rulesLoaded: false });
    expect((await served.call("/v1/later")).status).toBe(404);
    expect((await served.call("/v1/first")).status).toBe(503);
    first.release();
    await starting;
  });
});
