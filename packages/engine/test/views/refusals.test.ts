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

const ACTOR = { via: "test", id: "tester" } as const;

/** A plugin whose `seal` action refuses, or has nothing to do, by the object's state. */
const sealing = definePlugin({
  name: "sealing",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "box" }, { name: "lid" }],
  views: {
    box: {
      row: (object) => ({ id: object.id, title: object.id, state: String(object.data.state) }),
      sections: () => [],
      load: () => ({ markdown: "" }),
    },
    lid: {
      row: (object) => ({ id: object.id, title: object.id, state: "open" }),
      sections: () => [],
      load: () => ({ markdown: "" }),
    },
  },
  actions: [
    {
      name: "seal",
      on: "box",
      when: (state) => state.state === "open",
      settled: (object) => (object.data.state === "sealed" ? `${object.id} is already sealed; nothing to do` : undefined),
      // The check reads the store: a lid must exist for the box.
      why: async (object, env) =>
        (await env.store.get("lid", object.id)) === undefined
          ? `${object.id} has no lid; seal works once it has one`
          : `${object.id} is ${String(object.data.state)}; seal works once it is open`,
      run: async (ctx) => {
        await ctx.store.put("box", ctx.object.id, { state: "sealed" }, "seal");
        return "sealed";
      },
    },
    { name: "plain", on: "box", when: () => false, run: () => undefined },
    { name: "close", on: "lid", when: () => true, run: () => undefined },
  ],
});

async function open() {
  const root = await tempRoot();
  const store = new MemoryPluginStore({ root: join(root, "plugins") });
  store.put("box", "b1", { state: "open" }, "seed");
  store.put("box", "b2", { state: "sealed" }, "seed");
  store.put("box", "b3", { state: "broken" }, "seed");
  store.put("box", "b4", { state: "broken" }, "seed");
  store.put("lid", "b3", {}, "seed");
  store.put("lid", "l1", {}, "seed");
  const registry = new PluginRegistry([sealing], { store, storeRoot: store.root });
  const log = openLog({ backend: "jsonl", path: join(root, "store") });
  const views = createViews({ registry, store, log });
  return { views, store, log };
}

describe("an action that cannot run", () => {
  test("a result that is already true succeeds with the plugin's line and runs nothing", async () => {
    const { views, store, log } = await open();
    const run = await views.act("sealing:seal", "box:b2", { actor: ACTOR });
    expect(run.value).toBe("b2 is already sealed; nothing to do");
    expect(run.settled).toBe(true);
    expect(store.get("box", "b2")?.data.state).toBe("sealed");
    // An action that ran is not settled.
    const ran = await views.act("sealing:seal", "box:b1", { actor: ACTOR });
    expect(ran.value).toBe("sealed");
    expect(ran.settled).toBeUndefined();
    views.close();
    await log.close();
  });

  test("a refusal is the plugin's line, and its check can read the store", async () => {
    const { views, log } = await open();
    await expect(views.act("sealing:seal", "box:b3", { actor: ACTOR })).rejects.toThrow(
      "b3 is broken; seal works once it is open",
    );
    await expect(views.act("sealing:seal", "box:b4", { actor: ACTOR })).rejects.toThrow(
      "b4 has no lid; seal works once it has one",
    );
    await expect(views.act("sealing:plain", "box:b1", { actor: ACTOR })).rejects.toThrow(
      "b1 cannot sealing:plain now",
    );
    views.close();
    await log.close();
  });

  test("the kernel's own refusals have the same shape: the object first, then what to do", async () => {
    const { views, log } = await open();
    await expect(views.act("sealing:nope", "box:b1", { actor: ACTOR })).rejects.toThrow(
      'b1 has no action "sealing:nope"',
    );
    await expect(views.act("close", "box:b1", { actor: ACTOR })).rejects.toThrow(
      "b1 is a box; close works on lid",
    );
    await expect(views.act("sealing:close", "box:b1", { actor: ACTOR })).rejects.toThrow(
      "b1 is a box; sealing:close works on lid",
    );
    for (const name of ["sealing:nope", "close"]) {
      await views.act(name, "box:b1", { actor: ACTOR }).catch((error: unknown) => {
        const text = String(error instanceof Error ? error.message : error);
        expect(text).not.toMatch(/\b(plugin|declares|object of type|not loaded)\b/);
      });
    }
    views.close();
    await log.close();
  });

  test("an action is offered only when it can run now", async () => {
    const { views, log } = await open();
    const names = async (id: string) => (await views.get(id)).actions.map((a) => a.name);
    expect(await names("box:b1")).toEqual(["sealing:seal"]);
    expect(await names("box:b2")).toEqual([]);
    views.close();
    await log.close();
  });
});
