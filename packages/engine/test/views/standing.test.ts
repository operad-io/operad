import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginError,
  PluginRegistry,
  definePlugin,
  listPending,
  openLog,
} from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

let problem: string | undefined = "disk is full";

const noticing = definePlugin({
  name: "noticing",
  kind: "domain",
  version: "0.0.1",
  standing: (ctx) =>
    problem === undefined
      ? []
      : [{ id: "disk", prompt: `${problem} (${ctx.loaded.join(",")})` }],
});

const broken = definePlugin({
  name: "broken",
  kind: "domain",
  version: "0.0.1",
  standing: () => {
    throw new Error("cannot look");
  },
});

describe("standing pending items", () => {
  test("a plugin's items join the pending view, wait on no run and go when the plugin stops reporting them", async () => {
    const root = await tempRoot();
    const logs: string[] = [];
    const registry = new PluginRegistry([noticing, broken], {
      store: new MemoryPluginStore({ root: join(root, "plugins") }),
      onLog: (message) => logs.push(message),
    });
    const log = openLog({ backend: "jsonl", path: join(root, "store") });

    const items = await listPending(log, registry);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      runId: "noticing:disk",
      flow: "noticing",
      kind: "standing",
      prompt: "disk is full (noticing,broken)",
      choices: [],
      actions: [],
    });
    // The plugin that cannot look is logged and hides nothing else.
    expect(logs.some((line) => line.includes('"broken": standing failed: cannot look'))).toBe(true);

    problem = undefined;
    expect(await listPending(log, registry)).toEqual([]);
    problem = "disk is full";
  });

  test("a standing hook that is not a function is refused", () => {
    expect(
      () =>
        new PluginRegistry(
          [{ ...noticing, standing: "nope" } as unknown as typeof noticing],
          { store: new MemoryPluginStore({ root: "/tmp/x" }) },
        ),
    ).toThrow(PluginError);
  });
});
