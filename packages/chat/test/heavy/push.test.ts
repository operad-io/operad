import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  createViews,
  openLog,
  readHttpToken,
  startHttpServer,
  type HttpServerHandle,
  type LogBackend,
} from "@operad-io/engine";
import { chatRef, createChat, createChatPlugin, MESSAGE_FACT, newMessageId } from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../../../engine/test/plugin/support.ts";
import { fakeHarness, reply, type Script } from "../support.ts";

afterAll(cleanupTempRoots);

interface Rig {
  readonly chat: string;
  readonly store: MemoryPluginStore;
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  readonly root: string;
  readonly server: HttpServerHandle;
  readonly base: string;
  readonly token: string;
  /** Starts the reply run and returns its promise, so a test can read the stream meanwhile. */
  run(): Promise<void>;
  close(): Promise<void>;
}

async function makeRig(script: Script): Promise<Rig> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const store = new MemoryPluginStore({ root: join(root, "store") });
  const log = openLog({ backend: "sqlite", path: join(root, "store", "log.sqlite") });
  const registry = new PluginRegistry([createChatPlugin(), fakeHarness("fake", script, [])], {
    home,
    cwd: root,
    store,
    onLog: () => undefined,
  });
  const views = createViews({ registry, store, log, home, onLog: () => undefined });
  const server = await startHttpServer({
    home,
    config: { enabled: true, port: 0, listen: ["127.0.0.1"] },
    views,
    log,
    registry,
    onLog: () => undefined,
  });
  const token = await readHttpToken(home);
  const base = server.urls[0];
  if (token === undefined || base === undefined) throw new Error("the server is not reachable");
  const chat = await createChat(store, { harness: "fake", cwd: root, title: "Chat" }, "test");
  return {
    chat,
    store,
    log,
    registry,
    root,
    server,
    base,
    token: token.token,
    async run() {
      await store.append({
        type: MESSAGE_FACT,
        object: chatRef(chat),
        cause: "test",
        data: {
          id: newMessageId(),
          role: "user",
          from: { via: "cli", id: "tester" },
          text: "hello",
          attachments: [],
          source: { kind: "cli", ref: null },
        },
      });
      const info = await log.startRun("chat:reply", `chat:${chat}`);
      const found = registry.flow("chat:reply");
      if (found === undefined) throw new Error("no chat flow");
      await new Runner({
        log,
        flow: found.flow,
        runId: info.runId,
        registry,
        lockRoot: join(root, "locks"),
        object: { type: "chat", id: chat },
      }).run();
    },
    async close() {
      await server.stop();
      views.close();
      await log.close();
    },
  };
}

interface SseEvent {
  readonly event: string;
  readonly id: string | undefined;
  readonly data: string;
}

/** One SSE stream, read event by event; comments keep it open but yield nothing. */
async function openSse(r: Rig): Promise<{
  next(): Promise<SseEvent>;
  cancel(): Promise<void>;
}> {
  const controller = new AbortController();
  const response = await fetch(`${r.base}/v1/events`, {
    headers: { authorization: `Bearer ${r.token}` },
    signal: controller.signal,
  });
  if (!response.ok) throw new Error(`the event stream answered ${response.status}`);
  const body = response.body;
  if (body === null) throw new Error("the event stream has no body");
  const reader = body.getReader();
  let buffer = "";
  const decoder = new TextDecoder();

  const next = async (): Promise<SseEvent> => {
    for (;;) {
      for (;;) {
        const at = buffer.indexOf("\n\n");
        if (at < 0) break;
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        let event = "message";
        let id: string | undefined;
        let data = "";
        let field = false;
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          if (colon < 0) continue;
          field = true;
          const name = line.slice(0, colon);
          const value = line.slice(colon + 1).replace(/^ /, "");
          if (name === "event") event = value;
          else if (name === "id") id = value;
          else if (name === "data") data = data.length === 0 ? value : `${data}\n${value}`;
        }
        if (field) return { event, id, data };
      }
      const read = await reader.read();
      if (read.done) throw new Error("the event stream ended");
      buffer += decoder.decode(read.value, { stream: true });
    }
  };

  return {
    next,
    async cancel() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

/** Hands the script and the test one value at a time, without polling. */
function channel<T>(): { push(value: T): void; next(): Promise<T> } {
  const values: T[] = [];
  const waiters: ((value: T) => void)[] = [];
  return {
    push(value) {
      const waiter = waiters.shift();
      if (waiter === undefined) values.push(value);
      else waiter(value);
    },
    next() {
      const value = values.shift();
      if (value !== undefined) return Promise.resolve(value);
      return new Promise<T>((resolve) => waiters.push(resolve));
    },
  };
}

function gates(): {
  hold(name: string): Promise<void>;
  release(name: string): void;
} {
  const releases = new Map<string, () => void>();
  return {
    hold(name) {
      return new Promise<void>((resolve) => releases.set(name, resolve));
    },
    release(name) {
      const release = releases.get(name);
      releases.delete(name);
      release?.();
    },
  };
}

function bodyOf(event: SseEvent): Record<string, unknown> {
  return JSON.parse(event.data) as Record<string, unknown>;
}

/** One text line of the reply, written in two parts so a second append is the measured one. */
const first = { type: "text_delta", text: "first " };
const second = { type: "text_delta", text: "second" };

/** How long one way takes to receive the line, and how many section reads it made. */
async function measure(push: boolean): Promise<{ readonly elapsed: number; readonly rereads: number }> {
  const arrived = channel<number>();
  const gate = gates();
  const script: Script = async (ctx) => {
    arrived.push(-1);
    await gate.hold("write");
    await ctx.logger.write(JSON.stringify(first));
    await ctx.logger.write(JSON.stringify(second));
    arrived.push(performance.now());
    await gate.hold("finish");
    return reply("done");
  };
  const r = await makeRig(script);
  let events: Awaited<ReturnType<typeof openSse>> | undefined;
  try {
    const running = r.run();
    // The run fact is recorded before the agent step; open the stream after
    // it, so only the line's own event is seen.
    const beforeWrite = await arrived.next();
    expect(beforeWrite).toBe(-1);
    events = await openSse(r);
    const reader = events;
    let rereads = 0;
    const received = new Promise<number>((resolve, reject) => {
      void (async () => {
        try {
          for (;;) {
            const event = await reader.next();
            if (event.event === "tail") {
              if (!push) continue;
              const body = bodyOf(event);
              if (body.id !== r.chat) continue;
              if (typeof body.tail === "string" && body.tail.includes("second")) {
                resolve(performance.now());
                return;
              }
              continue;
            }
            if (event.event !== "message" || push) continue;
            const body = bodyOf(event);
            if (body.id !== r.chat) continue;
            rereads += 1;
            const response = await fetch(
              `${r.base}/v1/objects/chat:${r.chat}/sections/transcript`,
              { headers: { authorization: `Bearer ${r.token}` } },
            );
            const section = (await response.json()) as Record<string, unknown>;
            if (typeof section.tail === "string" && section.tail.includes("second")) {
              resolve(performance.now());
              return;
            }
          }
        } catch (error) {
          reject(error);
        }
      })();
    });
    gate.release("write");
    const at = await arrived.next();
    const heard = await received;
    gate.release("finish");
    await running;
    return { elapsed: heard - at, rereads };
  } finally {
    await events?.cancel();
    await r.close();
  }
}

describe("a running reply is pushed over the event stream", () => {
  test("a client re-reading the tail receives the line from the fake harness", async () => {
    const reread = await measure(false);
    // The number is in this test's output, so a run records what the way costs.
    console.log(`tail re-read: ${reread.elapsed.toFixed(1)} ms (${reread.rereads} section reads)`);
    expect(reread.elapsed).toBeGreaterThan(0);
    expect(reread.rereads).toBeGreaterThan(0);
  }, 30_000);

  test("a client using the push receives the line from the fake harness", async () => {
    const pushed = await measure(true);
    // The number is in this test's output, so a run records what the way costs.
    console.log(`push: ${pushed.elapsed.toFixed(1)} ms (${pushed.rereads} section reads)`);
    expect(pushed.elapsed).toBeGreaterThan(0);
    expect(pushed.rereads).toBe(0);
  }, 30_000);
});
