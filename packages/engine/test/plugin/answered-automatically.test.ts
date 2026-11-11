import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  definePlugin,
  listPending,
  openLog,
} from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

function plugin(hook: unknown) {
  return definePlugin({
    name: "autos",
    kind: "domain",
    version: "0.0.1",
    objects: [
      {
        name: "item",
        answeredAutomatically: hook as () => boolean,
      },
    ],
  });
}

async function fixture(hook: unknown) {
  const root = await tempRoot();
  const store = new MemoryPluginStore({ root: join(root, "store") });
  const logs: string[] = [];
  const registry = new PluginRegistry([plugin(hook)], {
    storeRoot: join(root, "store"),
    store,
    onLog: (message) => logs.push(message),
  });
  await store.put("item", "1", { auto: true }, "test");
  const log = openLog({ backend: "jsonl", path: join(root, "log") });
  const run = await log.startRun("demo", "item:1");
  await log.append(run.runId, 0, [
    {
      kind: "waiting_for_person",
      payload: {
        waitId: "w:1",
        step: "ask",
        prompt: "Merge?",
        choices: ["yes"],
        waitKind: "step",
        effectId: null,
      },
      cause: "test",
    },
  ]);
  return { registry, log, logs, run };
}

describe("answeredAutomatically", () => {
  test("a hook that throws counts as no and is logged", async () => {
    const e = await fixture(() => {
      throw new Error("hook exploded");
    });
    expect(await e.registry.answeredAutomatically({ type: "item", id: "1" })).toBe(false);
    expect(e.logs.join("\n")).toContain("hook exploded");
  });

  test("a hook that is not a function is refused", () => {
    expect(() => new PluginRegistry([plugin("yes")], { storeRoot: "/tmp/unused" })).toThrow(/answeredAutomatically: must be a function/);
  });

  test("pending leaves out an automatic wait unless asked for it", async () => {
    const e = await fixture((data: { auto?: boolean }) => data.auto === true);
    const hidden = await listPending(e.log, e.registry);
    expect(hidden).toEqual([]);
    const shown = await listPending(e.log, e.registry, undefined, undefined, { withAuto: true });
    expect(shown.map((item) => [item.runId, item.auto])).toEqual([[e.run.runId, true]]);
  });
});
