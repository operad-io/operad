import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { defineFlow, SqlitePluginStore, PluginRegistry } from "../../src/index.ts";
import { cleanupTempRoots, def, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

function generated(variant = 0): ReturnType<typeof defineFlow> {
  return defineFlow({
    name: "generated",
    entry: "one",
    steps: [
      {
        id: "one",
        kind: "plugin",
        params: { use: "p/step", params: { variant } },
        replay: "safe",
        next: { ok: "end_done" },
      },
      {
        id: "end_done",
        kind: "end",
        params: { status: "done" },
        replay: "safe",
      },
    ],
  });
}

test("a tick declares a generated flow by name", async () => {
  const registry = new PluginRegistry([
    def({
      name: "p",
      steps: [{ name: "step", results: ["ok"], run: async () => ({ result: "ok" }) }],
      onTick: (ctx) => {
        ctx.declareFlow(generated());
      },
    }),
  ]);
  expect(registry.flow("generated")).toBeUndefined();
  await registry.tick();
  expect(registry.flow("generated")?.flow.name).toBe("generated");
  expect(registry.flows().some((item) => item.flow.name === "generated")).toBe(true);
  // A second declaration of the same graph is a no-op.
  await registry.tick();
  expect(registry.flow("generated")?.flow.name).toBe("generated");
});

test("a name already used keeps the graph it got first", async () => {
  const logs: string[] = [];
  let variant = 0;
  const registry = new PluginRegistry(
    [
      def({
        name: "p",
        steps: [{ name: "step", results: ["ok"], run: async () => ({ result: "ok" }) }],
        onTick: (ctx) => {
          ctx.declareFlow(generated(variant));
        },
      }),
    ],
    { onLog: (line) => logs.push(line) },
  );
  await registry.tick();
  const first = registry.flow("generated")?.flow;
  variant = 1;
  await registry.tick();
  expect(registry.flow("generated")?.flow).toBe(first);
  expect(logs.some((line) => line.includes('flow "generated": already declared'))).toBe(true);
});

test("a declaration is found by a later process from the same store", async () => {
  const root = await tempRoot();
  const storeRoot = join(root, "store");
  const steps = [
    { name: "step", results: ["ok"], run: async () => ({ result: "ok" }) },
  ];
  const make = () =>
    def({
      name: "p",
      steps,
      onTick: (ctx) => {
        ctx.declareFlow(generated());
      },
    });
  const first = new PluginRegistry([make()], {
    home: root,
    storeRoot,
    store: new SqlitePluginStore({ root: storeRoot }),
  });
  await first.tick();
  expect(first.flow("generated")?.flow.name).toBe("generated");

  // A run's own process is built after the tick that declared the flow.
  const second = new PluginRegistry([make()], {
    home: root,
    storeRoot,
    store: new SqlitePluginStore({ root: storeRoot }),
  });
  expect(second.flow("generated")?.flow.name).toBe("generated");
  expect(second.flows().some((item) => item.flow.name === "generated")).toBe(true);
});
