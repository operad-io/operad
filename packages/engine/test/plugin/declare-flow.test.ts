import { expect, test } from "bun:test";
import { defineFlow, PluginRegistry } from "../../src/index.ts";
import { def } from "./support.ts";

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
