import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  createViews,
  definePlugin,
  listPending,
  openLog,
} from "@operad-io/engine";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";
import { closeServeContext } from "../src/serve-close.ts";

afterAll(cleanupTempRoots);

test("a serve context waits for standing work in flight before it closes the stores (T-0787)", async () => {
  const root = await tempRoot();
  let storeClosed = false;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => undefined;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const bot = definePlugin({
    name: "bot",
    kind: "domain",
    version: "0.0.1",
    standing: async () => {
      started();
      await gate;
      if (storeClosed) throw new Error("Cannot use a closed database");
      return [{ id: "ready", prompt: "bot is ready" }];
    },
  });
  const logs: string[] = [];
  const store = new MemoryPluginStore({ root: join(root, "plugins") });
  const registry = new PluginRegistry([bot], { store, onLog: (m) => logs.push(m) });
  const log = openLog({ path: join(root, "store", "log.sqlite") });
  const views = createViews({ registry, store, log, onLog: (m) => logs.push(m) });

  const pending = listPending(log, registry);
  await begun;
  const ending = closeServeContext({ views, registry, log }, () => {
    storeClosed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(storeClosed).toBe(false);
  release();
  await ending;
  expect(storeClosed).toBe(true);
  expect(await pending).toMatchObject([{ runId: "bot:ready" }]);
  expect(logs).toEqual([]);
});
