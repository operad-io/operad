import { describe, expect, test } from "bun:test";
import { PluginRegistry, definePlugin, MemoryPluginStore } from "../../src/index.ts";

function harness(models: unknown, kind: "harness" | "domain" = "harness") {
  return definePlugin({
    name: "h",
    kind,
    version: "0.0.0",
    models: models as never,
    steps: [{ name: "agent", results: ["done"], run: () => ({ result: "done" }) }],
  });
}

function load(plugin: ReturnType<typeof harness>) {
  return new PluginRegistry([plugin], { home: "/tmp/none", cwd: "/tmp", store: new MemoryPluginStore({ root: "/tmp/none-store" }), onLog: () => undefined });
}

describe("a harness plugin's models", () => {
  test("are offered to actions by plugin name", () => {
    const registry = load(harness({ list: ["a", "b"], default: "a" }));
    expect(registry.actionEnv().models).toEqual({ h: { list: ["a", "b"], default: "a" } });
  });

  test("a default outside the list is refused", () => {
    expect(() => load(harness({ list: ["a"], default: "z" }))).toThrow(/models\.default/);
  });

  test("only a harness declares them", () => {
    expect(() => load(harness({ list: [], default: null }, "domain"))).toThrow(/only a harness/);
  });
});
