import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createViews,
  definePlugin,
  SqlitePluginStore,
  MemoryPluginStore,
  PluginRegistry,
} from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const opened: ReturnType<typeof createViews>[] = [];
afterEach(() => {
  for (const views of opened.splice(0)) views.close();
});

function setup() {
  const store = new MemoryPluginStore({ root: "unused" });
  let runs = 0;
  const plugin = definePlugin({
    name: "mover",
    kind: "domain",
    version: "0.0.0",
    objects: [
      {
        name: "new",
        prepare: async ({ store: target }) => {
          runs += 1;
          for (const old of (await target.list("old", {})).objects) {
            await target.put("new", old.id, old.data, "test:move");
          }
        },
      },
    ],
    views: {
      new: {
        row: (object) => ({ id: object.id, title: object.id, state: "open" }),
        sections: () => [],
        load: async () => ({ markdown: "" }),
      },
    },
  });
  const registry = new PluginRegistry([plugin], { store });
  const views = createViews({ registry, store, onLog: () => undefined });
  opened.push(views);
  return { store, views, runs: () => runs };
}

describe("object type prepare", () => {
  test("a list and a get see objects the type brings up to date first, once", async () => {
    const { store, views, runs } = setup();
    await store.put("old", "a", {}, "seed");
    expect((await views.list("new")).rows.map((row) => row.id)).toEqual(["a"]);
    expect((await views.get("new:a")).row.id).toBe("a");
    await views.listTree("new", { root: true });
    expect(runs()).toBe(1);
  });

  test("prepare gets the home and the plugin's validated settings", async () => {
    const store = new MemoryPluginStore({ root: "unused" });
    let seen: unknown;
    const plugin = definePlugin({
      name: "owner",
      kind: "domain",
      version: "0.0.0",
      settings: {
        type: "object",
        properties: { size: { type: "integer", default: 3 } },
        additionalProperties: false,
      },
      objects: [
        {
          name: "thing",
          prepare: ({ home, settings }) => {
            seen = { home, settings };
          },
        },
      ],
      views: {
        thing: {
          row: (object) => ({ id: object.id, title: object.id, state: "open" }),
          sections: () => [],
          load: async () => ({ markdown: "" }),
        },
      },
    });
    const registry = new PluginRegistry([plugin], { store, home: "/the/home" });
    const views = createViews({ registry, store, onLog: () => undefined });
    opened.push(views);
    await views.list("thing");
    expect(seen).toEqual({ home: "/the/home", settings: { size: 3 } });
  });

  test("a root list called first sees them too", async () => {
    const { store, views } = setup();
    await store.put("old", "a", {}, "seed");
    expect((await views.listTree(undefined, { root: true })).rows.map((row) => row.id)).toEqual(["a"]);
  });

  test("a one-shot view adds no change listener", async () => {
    const root = await tempRoot();
    let repeats = 0;
    const store = new SqlitePluginStore({
      root: join(root, "plugins"),
      repeat: () => {
        repeats += 1;
        return () => undefined;
      },
    });
    const plugin = definePlugin({
      name: "quiet",
      kind: "domain",
      version: "0.0.0",
      objects: [{ name: "note" }],
    });
    const registry = new PluginRegistry([plugin], {
      store,
      onLog: () => undefined,
    });
    const views = createViews({
      registry,
      store,
      follow: false,
      onLog: () => undefined,
    });
    opened.push(views);
    expect(repeats).toBe(0);
  });

  test("a one-shot command opens its store and plugin without a watch or a timer", async () => {
    const root = await tempRoot();
    let repeats = 0;
    let subscriptions = 0;
    let unsubscribe: (() => void) | undefined;
    const store = new SqlitePluginStore({
      root: join(root, "plugins"),
      follow: false,
      repeat: () => {
        repeats += 1;
        return () => undefined;
      },
    });
    const plugin = definePlugin({
      name: "one-shot",
      kind: "domain",
      version: "0.0.0",
      objects: [
        {
          name: "new",
          prepare: ({ store: target }) => {
            subscriptions += 1;
            unsubscribe = target.subscribe(() => undefined);
          },
        },
      ],
      views: {
        new: {
          row: (object) => ({ id: object.id, title: object.id, state: "open" }),
          sections: () => [],
          load: async () => ({ markdown: "" }),
        },
      },
    });
    const registry = new PluginRegistry([plugin], {
      store,
      onLog: () => undefined,
    });
    const views = createViews({
      registry,
      store,
      follow: false,
      onLog: () => undefined,
    });
    opened.push(views);
    await store.put("new", "a", {}, "seed");

    expect((await views.list("new")).rows.map((row) => row.id)).toEqual(["a"]);
    expect(subscriptions).toBe(1);
    expect(repeats).toBe(0);
    unsubscribe?.();
  });
});
