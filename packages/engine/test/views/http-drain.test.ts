import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  StoreClosedError,
  createViews,
  openLog,
  readHttpToken,
  startHttpServer,
} from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

test("a stop waits for a request in flight, and a request that meets the closed store is answered, not logged (T-0787)", async () => {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: () => void = () => undefined;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  const logs: string[] = [];
  const store = new MemoryPluginStore({ root: join(root, "plugins") });
  const registry = new PluginRegistry([], { store, onLog: (m) => logs.push(m) });
  const log = openLog({ path: join(root, "store", "log.sqlite") });
  const real = createViews({ registry, store, log, onLog: (m) => logs.push(m) });
  // Every read of the views meets the store after it was closed.
  const views = new Proxy(real, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property !== "list" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async () => {
        started();
        await wait;
        throw new StoreClosedError();
      };
    },
  });
  const server = await startHttpServer({
    home,
    config: { enabled: true, port: 0, listen: ["127.0.0.1"] },
    views,
    log,
    registry,
    onLog: (m) => logs.push(m),
  });
  const token = (await readHttpToken(home))?.token ?? "";
  const request = fetch(`${server.urls[0] ?? ""}/v1/objects?type=note`, {
    headers: { authorization: `Bearer ${token}` },
  }).then(
    (response) => response.status,
    () => "dropped",
  );
  await begun;
  let stopped = false;
  const stopping = server.stop().then(() => {
    stopped = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(stopped).toBe(false);
  release();
  await stopping;
  // The listener closed the connection, so the client may see no answer.
  expect([503, "dropped"]).toContain(await request);
  expect(logs.filter((line) => line.includes("closed"))).toEqual([]);
  real.close();
  await log.close();
});
