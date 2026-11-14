import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  createViews,
  endRunDirectly,
  openLog,
  readHttpToken,
  startHttpServer,
  type LogBackend,
} from "@operad-io/engine";
import { chatRef, createChat, createChatPlugin, MESSAGE_FACT, newMessageId } from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../../../engine/test/plugin/support.ts";
import { fakeHarness, type Script } from "../support.ts";

afterAll(cleanupTempRoots);

interface Rig {
  readonly chat: string;
  readonly log: LogBackend;
  readonly store: MemoryPluginStore;
  readonly registry: PluginRegistry;
  readonly root: string;
  /** Reads `GET /v1/objects/chat:<id>`. */
  object(id?: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

async function rig(script: Script): Promise<Rig> {
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
    log,
    store,
    registry,
    root,
    async object(id = chat) {
      const response = await fetch(`${base}/v1/objects/chat:${id}`, {
        headers: { authorization: `Bearer ${token.token}` },
      });
      expect(response.status).toBe(200);
      return (await response.json()) as Record<string, unknown>;
    },
    async close() {
      await server.stop();
      views.close();
      await log.close();
    },
  };
}

/** Records a user message and runs the chat's reply to its end. */
async function reply(r: Rig): Promise<void> {
  await r.store.append({
    type: MESSAGE_FACT,
    object: chatRef(r.chat),
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
  const info = await r.log.startRun("chat:reply", `chat:${r.chat}`);
  const found = r.registry.flow("chat:reply");
  if (found === undefined) throw new Error("no chat flow");
  await new Runner({
    log: r.log,
    flow: found.flow,
    runId: info.runId,
    registry: r.registry,
    lockRoot: join(r.root, "locks"),
    object: { type: "chat", id: r.chat },
  }).run();
}

describe("how an object's last run ended, over HTTP", () => {
  test("an object with no run has no lastRun", async () => {
    const r = await rig(() => ({ result: "done", data: { finalMessage: "hi" } }));
    try {
      expect("lastRun" in (await r.object())).toBe(false);
    } finally {
      await r.close();
    }
  });

  test("a reply that ends shows outcome done and when", async () => {
    const r = await rig(() => ({ result: "done", data: { finalMessage: "hi" } }));
    try {
      const before = Date.now();
      await reply(r);
      const last = (await r.object()).lastRun as Record<string, unknown>;
      expect(last.outcome).toBe("done");
      expect("reason" in last).toBe(false);
      expect(typeof last.endedAt).toBe("number");
      expect(last.endedAt as number).toBeGreaterThanOrEqual(before);
    } finally {
      await r.close();
    }
  });

  test("a reply that fails shows outcome failed", async () => {
    const r = await rig(() => ({ result: "failed", data: { message: "boom" } }));
    try {
      await reply(r);
      const last = (await r.object()).lastRun as Record<string, unknown>;
      expect(last.outcome).toBe("failed");
      expect(last.reason).toBe("boom");
      expect(typeof last.endedAt).toBe("number");
    } finally {
      await r.close();
    }
  });

  test("a reply that is cancelled shows outcome cancelled", async () => {
    const r = await rig(() => ({ result: "interrupted", data: {} }));
    try {
      await reply(r);
      const last = (await r.object()).lastRun as Record<string, unknown>;
      expect(last.outcome).toBe("cancelled");
    } finally {
      await r.close();
    }
  });

  test("a run ended with a reason carries the reason line", async () => {
    const r = await rig(() => ({ result: "done", data: { finalMessage: "hi" } }));
    try {
      const info = await r.log.startRun("chat:reply", `chat:${r.chat}`);
      await endRunDirectly(r.log, info.runId, "failed", "the worker was lost");
      const last = (await r.object()).lastRun as Record<string, unknown>;
      expect(last.outcome).toBe("failed");
      expect(last.reason).toBe("the worker was lost");
    } finally {
      await r.close();
    }
  });

  test("a newer run that is still going hides the earlier ending", async () => {
    const r = await rig(() => ({ result: "done", data: { finalMessage: "hi" } }));
    try {
      await reply(r);
      expect((await r.object()).lastRun).toBeDefined();
      await r.log.startRun("chat:reply", `chat:${r.chat}`);
      expect("lastRun" in (await r.object())).toBe(false);
    } finally {
      await r.close();
    }
  });
});
