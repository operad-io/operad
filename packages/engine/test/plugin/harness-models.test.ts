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
  test("a bare string list still loads, and is offered to actions by plugin name", () => {
    const registry = load(harness({ list: ["a", "b"], default: "a" }));
    expect(registry.actionEnv().models).toEqual({ h: { list: ["a", "b"], default: "a" } });
  });

  test("a model may describe its id, name, provider, window and capabilities", () => {
    const registry = load(
      harness({
        list: [
          { id: "sonnet", name: "Sonnet", provider: "anthropic", window: 200_000, capabilities: ["vision", "reasoning", "tools"] },
          "plain",
        ],
        default: "sonnet",
      }),
    );
    expect(registry.loadedModels()).toEqual({
      h: {
        list: ["sonnet", "plain"],
        default: "sonnet",
        windows: { sonnet: 200_000 },
        info: {
          sonnet: {
            id: "sonnet",
            name: "Sonnet",
            provider: "anthropic",
            window: 200_000,
            capabilities: ["vision", "reasoning", "tools"],
          },
        },
      },
    });
  });

  test("descriptions may sit in info by id, and a capability object is the same as its list", () => {
    const registry = load(
      harness({
        list: ["a"],
        default: null,
        info: { a: { name: "A", provider: "p", vision: true, reasoning: true } },
      }),
    );
    expect(registry.loadedModels().h?.info).toEqual({
      a: { id: "a", name: "A", provider: "p", capabilities: ["vision", "reasoning"] },
    });
  });

  test("an unknown capability, or a description of a model not in the list, is refused", () => {
    expect(() =>
      load(harness({ list: [{ id: "a", capabilities: ["sound"] }], default: null })),
    ).toThrow(/capabilities/);
    expect(() => load(harness({ list: ["a"], default: null, info: { b: { id: "b" } } }))).toThrow(
      /must be one of the models in the list/,
    );
  });

  test("a default outside the list is refused", () => {
    expect(() => load(harness({ list: ["a"], default: "z" }))).toThrow(/models\.default/);
  });

  test("only a harness declares them", () => {
    expect(() => load(harness({ list: [], default: null }, "domain"))).toThrow(/only a harness/);
  });

  test("a model's context window is offered beside the list, and an unknown one is left out", () => {
    const registry = load(
      harness({ list: ["a", "b"], default: "a", windows: { a: 200_000 } }),
    );
    expect(registry.loadedModels()).toEqual({
      h: { list: ["a", "b"], default: "a", windows: { a: 200_000 } },
    });
  });

  test("a window for a model not in the list, or not a positive whole number, is refused", () => {
    expect(() => load(harness({ list: ["a"], default: null, windows: { b: 1 } }))).toThrow(
      /models\.windows\.b: must be one of the models in the list/,
    );
    expect(() => load(harness({ list: ["a"], default: null, windows: { a: 0 } }))).toThrow(
      /models\.windows\.a: must be a positive whole number/,
    );
    expect(() => load(harness({ list: ["a"], default: null, windows: { a: 1.5 } }))).toThrow(
      /models\.windows\.a: must be a positive whole number/,
    );
  });

  test("a function is called with the plugin's settings each time the list is read", () => {
    let calls = 0;
    let received: unknown;
    const registry = load(
      harness((settings: Record<string, unknown>) => {
        calls += 1;
        received = settings;
        return { list: ["a"], default: null };
      }),
    );
    expect(registry.loadedModels()).toEqual({ h: { list: ["a"], default: null } });
    expect(received).toBe(registry.settingsFor("h"));
    registry.loadedModels();
    expect(calls).toBe(2);
  });
});
