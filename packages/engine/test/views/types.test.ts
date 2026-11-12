import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createViews,
  listTypes,
  MemoryPluginStore,
  openConfigLog,
  PluginRegistry,
  readConfig,
  readHttpToken,
  startHttpServer,
  type HttpServerHandle,
} from "../../src/index.ts";
import tree from "../fixtures/plugins/tree.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const opened: ReturnType<typeof createViews>[] = [];
afterEach(() => {
  for (const views of opened.splice(0)) views.close();
});

function registryOf(options: { readonly underSettings?: boolean } = {}): {
  readonly store: MemoryPluginStore;
  readonly registry: PluginRegistry;
} {
  const store = new MemoryPluginStore({ root: "unused" });
  const plugin = options.underSettings === true
    ? { ...tree, objectsUnderSettings: true }
    : tree;
  const registry = new PluginRegistry([plugin], { store });
  const views = createViews({ registry, store, onLog: () => undefined });
  opened.push(views);
  return { store, registry };
}

describe("the types listing", () => {
  test("a plugin whose objects belong under settings marks every one of its types", () => {
    const settings = listTypes(registryOf({ underSettings: true }).registry);
    expect(settings.map((entry) => [entry.type, entry.settings])).toEqual([
      ["group", true],
      ["leaf", true],
    ]);
    const tabbed = listTypes(registryOf().registry);
    expect(tabbed.map((entry) => [entry.type, entry.settings])).toEqual([
      ["group", undefined],
      ["leaf", undefined],
    ]);
  });

  test("GET /v1/types carries the settings flag, its filters and its parents", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ store: { backend: "sqlite", path: join(root, "store", "log.sqlite") } }),
    );
    const log = openConfigLog(await readConfig(home));
    const { store, registry } = registryOf({ underSettings: true });
    const views = createViews({ registry, store, log, onLog: () => undefined });
    opened.push(views);
    let server: HttpServerHandle | undefined;
    try {
      server = await startHttpServer({
        home,
        config: { enabled: true, port: 0, listen: ["127.0.0.1"] },
        views,
        log,
        registry,
        onLog: () => undefined,
      });
      const token = (await readHttpToken(home))?.token ?? "";
      const response = await fetch(`${server.urls[0] ?? ""}/v1/types`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        types: readonly { type: string; settings?: boolean; defaultFilter?: string }[];
      };
      expect(body.types.map((entry) => [entry.type, entry.settings])).toEqual([
        ["group", true],
        ["leaf", true],
      ]);
      const leaf = body.types.find((entry) => entry.type === "leaf");
      expect(leaf?.defaultFilter).toBe("active");
    } finally {
      await server?.stop();
    }
  });
});
