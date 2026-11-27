import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createViews,
  definePlugin,
  Kernel,
  MemoryPluginStore,
  openLog,
  PluginRegistry,
  type SourceContext,
} from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "./support.ts";

afterEach(cleanupTempRoots);

function harness(name: string, interactiveCommand: unknown, kind: "harness" | "domain" = "harness") {
  return definePlugin({
    name,
    kind,
    version: "0.0.0",
    settings: { type: "object", properties: { command: { type: "string" } } },
    interactiveCommand: interactiveCommand as never,
    steps: [{ name: "agent", results: ["done"], run: () => ({ result: "done" }) }],
  });
}

describe("a harness plugin's interactiveCommand", () => {
  test("is asked with the plugin's settings and the home", async () => {
    const registry = new PluginRegistry(
      [
        harness("h", (settings: { command?: string }, context: { home: string }) =>
          `${settings.command ?? "none"} in ${context.home}`,
        ),
      ],
      { home: "/tmp/none", store: new MemoryPluginStore({ root: "/tmp/none-store" }), settings: { h: { command: "x" } } },
    );
    expect(await registry.interactiveCommandFor("h")).toBe("x in /tmp/none");
  });

  test("is absent without one, for a missing plugin and for a broken answer", async () => {
    const registry = new PluginRegistry(
      [
        harness("quiet", undefined),
        harness("empty", () => ""),
        harness("broken", () => {
          throw new Error("no agent");
        }),
      ],
      { home: "/tmp/none", store: new MemoryPluginStore({ root: "/tmp/none-store" }) },
    );
    for (const name of ["quiet", "empty", "broken", "gone"]) {
      expect(await registry.interactiveCommandFor(name)).toBeUndefined();
    }
  });

  test("only a harness plugin declares one", () => {
    const store = new MemoryPluginStore({ root: "/tmp/none-store" });
    expect(() => new PluginRegistry([harness("d", () => "d", "domain")], { store })).toThrow(
      "interactiveCommand: only a harness plugin declares interactiveCommand",
    );
  });
});

describe("serve without trigger rules", () => {
  test("starts only the plugins that say they need none, which can ask for a harness's command", async () => {
    const root = await tempRoot();
    const started: string[] = [];
    let context: SourceContext | undefined;
    const source = (name: string, startsWithoutRules: boolean) =>
      definePlugin({
        name,
        kind: "domain",
        version: "0.0.0",
        startsWithoutRules,
        start(ctx) {
          started.push(name);
          context = ctx;
          return { stop: () => undefined };
        },
      });
    const store = new MemoryPluginStore({ root: join(root, "plugins") });
    const registry = new PluginRegistry(
      [source("serves", true), source("listens", false), harness("h", () => "h --here")],
      { home: root, store },
    );
    const log = openLog({ path: join(root, "log.sqlite") });
    const views = createViews({ registry, store, log });
    const kernel = new Kernel({ log, registry, home: root, storeRoot: root, rules: [], client: views });
    await kernel.startSources({ rulesLoaded: false });
    expect(started).toEqual(["serves"]);
    expect(await context?.harnessCommand?.("h")).toBe("h --here");
    await kernel.stopSources();
    await kernel.startSources();
    expect(started).toEqual(["serves", "serves", "listens"]);
    await kernel.stopSources();
    views.close();
    await log.close();
  });
});
