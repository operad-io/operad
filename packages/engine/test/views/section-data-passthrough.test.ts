import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createViews,
  definePlugin,
  MemoryPluginStore,
  openLog,
  PluginRegistry,
} from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const data = { replies: [{ runId: "run-1", process: [] }] };

const plugin = definePlugin({
  name: "sections",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "thing" }],
  views: {
    thing: {
      row: (object) => ({ id: object.id, title: object.id, state: "open" }),
      sections: () => [{ id: "main", title: "Main" }],
      load: (_ctx, _object, _section, options) => ({
        markdown: options.after === undefined ? "whole" : "delta",
        mark: "p",
        ...(options.after === undefined ? {} : { delta: true }),
        data,
      }),
    },
  },
});

describe("structured data beside a section", () => {
  test("a read carries the plugin's data, and so does a read after a mark", async () => {
    const root = await tempRoot();
    const store = new MemoryPluginStore({ root: join(root, "plugins") });
    store.put("thing", "one", {}, "seed");
    const registry = new PluginRegistry([plugin], { store, storeRoot: store.root });
    const log = openLog({ backend: "sqlite", path: join(root, "store", "log.sqlite") });
    const views = createViews({ registry, store, log });
    try {
      const whole = await views.section("thing:one", "main", undefined, {});
      expect(whole.data).toEqual(data);
      const delta = await views.section("thing:one", "main", undefined, { after: whole.mark });
      expect(delta.markdown).toBe("delta");
      expect(delta.delta).toBe(true);
      expect(delta.data).toEqual(data);
    } finally {
      views.close();
      await log.close();
    }
  });
});
