/**
 * An action that targets no object: the kernel refuses a file argument it
 * cannot store, says plainly when its `when` is false, and refuses a duplicate
 * name at load.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginError,
  PluginRegistry,
  createViews,
  definePlugin,
  openLog,
} from "../../src/index.ts";
import { cleanupTempRoots, def, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const ACTOR = { via: "test", id: "tester" } as const;

const targetless = definePlugin({
  name: "targetless",
  kind: "domain",
  version: "0.0.1",
  actions: [
    { name: "wait", when: () => false, run: () => undefined },
    {
      name: "attach",
      args: {
        type: "object",
        properties: { file: { type: "string", format: "file" } },
        required: ["file"],
      },
      when: () => true,
      run: () => undefined,
    },
  ],
});

async function open() {
  const root = await tempRoot();
  const store = new MemoryPluginStore({ root: join(root, "plugins") });
  const registry = new PluginRegistry([targetless], { store, storeRoot: store.root });
  const log = openLog({ path: join(root, "store", "log.sqlite") });
  const views = createViews({ registry, store, log });
  return { views, log };
}

describe("an action that targets no object", () => {
  test("refuses a file argument, because there is no object to store it under", async () => {
    const { views, log } = await open();
    await expect(
      views.act("targetless:attach", undefined, {
        actor: ACTOR,
        args: { file: "upload-1" },
      }),
    ).rejects.toThrow('action "targetless:attach" targets no object, so it takes no file');
    views.close();
    await log.close();
  });

  test("says it cannot run now when its when is false", async () => {
    const { views, log } = await open();
    await expect(views.act("targetless:wait", undefined, { actor: ACTOR })).rejects.toThrow(
      "targetless:wait cannot run now",
    );
    views.close();
    await log.close();
  });
});

describe("loading targetless actions", () => {
  test("refuses two actions with one name that both target no object", () => {
    let caught: unknown;
    try {
      new PluginRegistry([
        def({
          name: "targetless",
          actions: [
            { name: "take", when: () => true, run: () => undefined },
            { name: "take", when: () => true, run: () => undefined },
          ],
        }),
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PluginError);
    expect(String(caught)).toContain('duplicate action "take" that targets no object');
  });
});
