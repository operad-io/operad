import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  createViews,
  definePlugin,
  listPending,
  openLog,
} from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const CLOSED = "Cannot use a closed database";

/** A gate a test opens when it wants the slow work to go on. */
function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe("a reload or a stop waits for work on the old store (T-0787)", () => {
  test("standing work in flight is waited for and its items are right", async () => {
    const root = await tempRoot();
    const release = gate();
    const started = gate();
    const slow = definePlugin({
      name: "slow",
      kind: "domain",
      version: "0.0.1",
      standing: async () => {
        started.open();
        await release.wait;
        return [{ id: "disk", prompt: "disk is full" }];
      },
    });
    const logs: string[] = [];
    const registry = new PluginRegistry([slow], {
      store: new MemoryPluginStore({ root: join(root, "plugins") }),
      onLog: (message) => logs.push(message),
    });
    const log = openLog({ path: join(root, "store", "log.sqlite") });

    const pending = listPending(log, registry);
    await started.wait;
    let drained = false;
    const drain = registry.drain(5000).then(() => {
      drained = true;
    });
    // Let every queued callback run: a drain that waits is still pending.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    release.open();
    await drain;
    expect(await pending).toMatchObject([{ runId: "slow:disk", prompt: "disk is full" }]);
    expect(logs).toEqual([]);
    await log.close();
  });

  test("after the drain no standing work starts", async () => {
    const root = await tempRoot();
    let calls = 0;
    const counting = definePlugin({
      name: "counting",
      kind: "domain",
      version: "0.0.1",
      standing: () => {
        calls += 1;
        return [{ id: "x", prompt: "x" }];
      },
    });
    const registry = new PluginRegistry([counting], {
      store: new MemoryPluginStore({ root: join(root, "plugins") }),
    });
    await registry.drain(1000);
    expect(await registry.standing()).toEqual([]);
    expect(calls).toBe(0);
  });

  test("work that ends after the wait, on a closed store, is dropped without a log line", async () => {
    const root = await tempRoot();
    const release = gate();
    const started = gate();
    const slow = definePlugin({
      name: "bot",
      kind: "domain",
      version: "0.0.1",
      standing: async () => {
        started.open();
        await release.wait;
        throw new Error(CLOSED);
      },
    });
    const logs: string[] = [];
    const registry = new PluginRegistry([slow], {
      store: new MemoryPluginStore({ root: join(root, "plugins") }),
      onLog: (message) => logs.push(message),
    });
    const late = registry.standing();
    await started.wait;
    await registry.drain(10);
    release.open();
    expect(await late).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("a late failure keeps the items earlier plugins already gave", async () => {
    const root = await tempRoot();
    const release = gate();
    const started = gate();
    const first = definePlugin({
      name: "first",
      kind: "domain",
      version: "0.0.1",
      standing: () => [{ id: "a", prompt: "a" }],
    });
    const second = definePlugin({
      name: "second",
      kind: "domain",
      version: "0.0.1",
      standing: async () => {
        started.open();
        await release.wait;
        throw new Error(CLOSED);
      },
    });
    const logs: string[] = [];
    const registry = new PluginRegistry([first, second], {
      store: new MemoryPluginStore({ root: join(root, "plugins") }),
      onLog: (message) => logs.push(message),
    });
    const late = registry.standing();
    await started.wait;
    await registry.drain(10);
    release.open();
    expect(await late).toMatchObject([{ plugin: "first", id: "a" }]);
    expect(logs).toEqual([]);
  });

  test("a resolve in flight is waited for, and a late one is dropped without a log line", async () => {
    const root = await tempRoot();
    const release = gate();
    const started = gate();
    const view = {
      row: (object: { readonly id: string }) => ({ id: object.id, title: "", state: "new" }),
      sections: () => [],
      load: () => ({ markdown: "" }),
    };
    const resolving = definePlugin({
      name: "dev",
      kind: "domain",
      version: "0.0.1",
      objects: [
        {
          name: "task",
          resolve: async () => {
            started.open();
            await release.wait;
            throw new Error(CLOSED);
          },
        },
      ],
      views: { task: view },
    });
    const logs: string[] = [];
    const store = new MemoryPluginStore({ root: join(root, "plugins") });
    const registry = new PluginRegistry([resolving], { store, onLog: (m) => logs.push(m) });
    const log = openLog({ path: join(root, "store", "log.sqlite") });
    const views = createViews({
      registry,
      store,
      log,
      cwd: root,
      clock: () => 0,
      home: root,
      onLog: (message) => logs.push(message),
    });
    const found = views.get("TK-1").catch(() => undefined);
    await started.wait;
    await views.drain(10);
    release.open();
    await found;
    expect(logs).toEqual([]);
    views.close();
    await log.close();
  });
});
