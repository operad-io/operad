import { afterEach, describe, expect, test } from "bun:test";
import {
  createViews,
  definePlugin,
  MemoryPluginStore,
  PluginRegistry,
} from "../../src/index.ts";

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
});
