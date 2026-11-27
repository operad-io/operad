import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createViews,
  isLocalRequest,
  MAX_PLUGIN_STREAM_BYTES,
  MemoryPluginStore,
  openLog,
  PluginRegistry,
  readHttpToken,
  startHttpServer,
  type PluginHttp,
  type PluginHttpRequest,
  type PluginStreamEvent,
} from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await cleanupTempRoots();
});

async function serveWith(plugins: Record<string, PluginHttp>) {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const store = new MemoryPluginStore({ root: join(root, "plugins") });
  const registry = new PluginRegistry([], { store });
  const log = openLog({ path: join(root, "store", "log.sqlite") });
  const views = createViews({ registry, store, log });
  const server = await startHttpServer({
    home,
    config: { enabled: true, port: 0, listen: ["127.0.0.1"] },
    views,
    log,
    registry,
    pluginHttp: (name) => plugins[name],
  });
  closers.push(async () => {
    await server.stop();
    views.close();
    await log.close();
  });
  const token = (await readHttpToken(home))?.token ?? "";
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${server.urls[0] ?? ""}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
    });
  return { call, url: server.urls[0] ?? "" };
}

/** Reads a response until its text holds `needle`, or it ends. */
async function readUntil(response: Response, needle: string): Promise<string> {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (reader !== undefined && !text.includes(needle)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

describe("a running plugin's routes", () => {
  test("are answered under its name, with the decoded path, the body and where it came from", async () => {
    const seen: unknown[] = [];
    const served = await serveWith({
      echo: {
        async request(request: PluginHttpRequest) {
          if (request.path[0] !== "say") return undefined;
          seen.push([request.method, request.path, request.local, await request.body()]);
          return { status: 201, body: { ok: true } };
        },
      },
    });
    const answer = await served.call("/v1/echo/say/a%20b", { method: "POST", body: '{"x":1}' });
    expect(answer.status).toBe(201);
    expect(await answer.json()).toEqual({ ok: true });
    await served.call("/v1/echo/say", { method: "POST", body: "2", headers: { "x-real-ip": "10.0.0.2" } });
    expect(seen).toEqual([
      ["POST", ["say", "a b"], true, { x: 1 }],
      ["POST", ["say"], false, 2],
    ]);
    expect((await served.call("/v1/echo/other")).status).toBe(404);
    expect((await served.call("/v1/nobody")).status).toBe(404);
    expect((await fetch(`${served.url}/v1/echo/say`, { method: "POST" })).status).toBe(401);
  });

  test("never answer a built-in endpoint", async () => {
    let asked = 0;
    const taker: PluginHttp = {
      request() {
        asked += 1;
        return { status: 200, body: {} };
      },
    };
    const served = await serveWith({ types: taker, flows: taker });
    expect((await served.call("/v1/types", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await served.call("/v1/flows/other")).status).toBe(404);
    expect(asked).toBe(0);
  });
});

describe("a running plugin's events", () => {
  test("join a stream that names the plugin, and stop when the client goes", async () => {
    let closed: () => void = () => undefined;
    const gone = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const values: unknown[] = [];
    const served = await serveWith({
      clock: {
        request: () => undefined,
        stream(request) {
          values.push([request.values, request.local]);
          if (request.values.includes("no")) return { status: 403, body: { error: "no" } };
          return {
            open(send) {
              send({ name: "tick", data: { n: 1 } });
              return () => closed();
            },
          };
        },
      },
    });
    const abort = new AbortController();
    const stream = await served.call("/v1/events?clock=a&clock=b&unknown=1", { signal: abort.signal });
    expect(await readUntil(stream, '"n":1')).toContain('event: clock.tick\ndata: {"n":1}\n\n');
    abort.abort();
    await gone;
    const refused = await served.call("/v1/events?clock=no");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "no" });
    expect(values).toEqual([
      [["a", "b"], true],
      [["no"], true],
    ]);
  });

  test("a stream holds more events than the change window, up to a byte limit", async () => {
    let send: (event: PluginStreamEvent) => void = () => undefined;
    let closed = false;
    const served = await serveWith({
      flood: {
        request: () => undefined,
        stream: () => ({
          open(open) {
            send = open;
            // Far more events than the kernel's own queue takes, before any is read.
            for (let n = 0; n < 5_000; n += 1) send({ name: "n", data: n });
            send({ name: "end", data: 0 });
            return () => {
              closed = true;
            };
          },
        }),
      },
    });
    const stream = await served.call("/v1/events?flood=1");
    expect(await readUntil(stream, "flood.end")).toContain("data: 4999\n");
    expect(closed).toBe(false);
    const half = "x".repeat(MAX_PLUGIN_STREAM_BYTES / 2);
    send({ name: "big", data: half });
    send({ name: "big", data: half });
    send({ name: "big", data: half });
    expect(closed).toBe(true);
  });
});

describe("what a reader is given on joining", () => {
  test("is held whatever its size, and does not count toward the byte limit", async () => {
    let send: (event: PluginStreamEvent) => void = () => undefined;
    let closed = false;
    const served = await serveWith({
      screens: {
        request: () => undefined,
        stream: () => ({
          open(open) {
            send = open;
            const large = "x".repeat(MAX_PLUGIN_STREAM_BYTES);
            // None is read yet.
            send({ name: "screen", data: large, snapshot: true });
            send({ name: "screen", data: large, snapshot: true });
            send({ name: "end", data: 0 });
            return () => {
              closed = true;
            };
          },
        }),
      },
    });
    const stream = await served.call("/v1/events?screens=1");
    const text = await readUntil(stream, "screens.end");
    expect(text.length).toBeGreaterThan(2 * MAX_PLUGIN_STREAM_BYTES);
    expect(closed).toBe(false);
    send({ name: "big", data: "x".repeat(MAX_PLUGIN_STREAM_BYTES) });
    expect(closed).toBe(true);
  }, 30_000);
});

describe("a request from this machine", () => {
  const request = (headers: Record<string, string> = {}, host = "127.0.0.1:8765") =>
    new Request(`http://${host}/v1/x`, { headers });

  test("comes from a loopback peer to a loopback host", () => {
    for (const peer of ["127.0.0.1", "127.8.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect({ peer, local: isLocalRequest(peer, request()) }).toEqual({ peer, local: true });
    }
    for (const host of ["localhost:8765", "[::1]:8765"]) {
      expect(isLocalRequest("::1", request({}, host))).toBe(true);
    }
  });

  test("is not one from another address, to another name, or through a proxy", () => {
    for (const peer of [undefined, "192.168.1.20", "100.64.0.9", "::ffff:10.0.0.1", "fe80::1", "localhost"]) {
      expect({ peer, local: isLocalRequest(peer, request()) }).toEqual({ peer, local: false });
    }
    for (const host of ["mac.tail1234.ts.net", "192.168.1.5:8765", "127.0.0.1.example.com"]) {
      expect({ host, local: isLocalRequest("127.0.0.1", request({}, host)) }).toEqual({ host, local: false });
    }
    for (const header of [
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-real-ip",
      "x-client-ip",
      "true-client-ip",
      "fastly-client-ip",
      "x-envoy-external-address",
      "via",
      "cf-connecting-ip",
      "tailscale-user-login",
    ]) {
      expect({ header, local: isLocalRequest("127.0.0.1", request({ [header]: "a" })) }).toEqual({
        header,
        local: false,
      });
    }
  });
});
