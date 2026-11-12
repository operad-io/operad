import { describe, expect, test } from "bun:test";
import { PluginRegistry, definePlugin, MemoryPluginStore } from "../../src/index.ts";

function harness(efforts: unknown, kind: "harness" | "domain" = "harness") {
  return definePlugin({
    name: "h",
    kind,
    version: "0.0.0",
    efforts: efforts as never,
    steps: [{ name: "agent", results: ["done"], run: () => ({ result: "done" }) }],
  });
}

function load(plugin: ReturnType<typeof harness>) {
  return new PluginRegistry([plugin], {
    home: "/tmp/none",
    cwd: "/tmp",
    store: new MemoryPluginStore({ root: "/tmp/none-store" }),
    onLog: () => undefined,
  });
}

describe("a harness plugin's efforts", () => {
  test("are offered to actions by plugin name, with their flag", () => {
    const registry = load(harness({ list: ["low", "high"], default: "low", flag: "--thinking" }));
    expect(registry.actionEnv().efforts).toEqual({
      h: { list: ["low", "high"], default: "low", flag: "--thinking" },
    });
  });

  test("a default outside the list is refused", () => {
    expect(() => load(harness({ list: ["low"], default: "extreme" }))).toThrow(/efforts\.default/);
  });

  test("a flag that is not a non-empty string is refused", () => {
    expect(() => load(harness({ list: ["low"], default: "low", flag: "" }))).toThrow(/efforts\.flag/);
  });

  test("only a harness declares them", () => {
    expect(() => load(harness({ list: [], default: null }, "domain"))).toThrow(/only a harness/);
  });
});
