import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MemoryPluginStore,
  createViews,
  loadPluginRegistry,
  openConfigLog,
  readConfig,
  readHttpToken,
  startHttpServer,
  storeRootOf,
  type HttpServerHandle,
  type LogBackend,
  type PluginRegistry,
  type Views,
} from "@operad-io/engine";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";

export { cleanupTempRoots, tempRoot };

const pluginPath = fileURLToPath(
  new URL("./fixtures/plugin.ts", import.meta.url),
);

export interface TuiHarness {
  readonly root: string;
  readonly home: string;
  readonly store: MemoryPluginStore;
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  readonly views: Views;
  readonly server: HttpServerHandle;
  readonly base: string;
  readonly token: string;
  close(): Promise<void>;
}

export interface TuiHarnessOptions {
  readonly loadTimeoutMs?: number | undefined;
  readonly maxEventIds?: number | undefined;
}

export async function freePort(): Promise<number> {
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

export async function makeHarness(
  options: TuiHarnessOptions = {},
): Promise<TuiHarness> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const port = await freePort();
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [pluginPath],
      store: { backend: "jsonl", path: join(root, "store") },
      http: { enabled: true, port, listen: ["127.0.0.1"] },
    }),
  );
  const config = await readConfig(home);
  const storeRoot = storeRootOf(config);
  const store = new MemoryPluginStore({ root: storeRoot });
  const log = openConfigLog(config);
  const registry = await loadPluginRegistry({ home, store });
  const views = createViews({
    registry,
    store,
    log,
    loadTimeoutMs: options.loadTimeoutMs ?? 50,
    onLog: () => undefined,
  });
  const server = await startHttpServer({
    home,
    config: { enabled: true, port, listen: ["127.0.0.1"] },
    views,
    log,
    registry,
    ...(options.maxEventIds === undefined
      ? {}
      : { maxEventIds: options.maxEventIds }),
    onLog: () => undefined,
  });
  const token = await readHttpToken(home);
  if (token === undefined) throw new Error("the server created no token");
  const base = server.urls[0] ?? `http://127.0.0.1:${port}`;

  return {
    root,
    home,
    store,
    log,
    registry,
    views,
    server,
    base,
    token: token.token,
    async close() {
      await server.stop();
      views.close();
      await log.close();
    },
  };
}
