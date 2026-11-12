import { describe, expect, test } from "bun:test";
import { MemoryPluginStore, PluginRegistry, definePlugin } from "@operad-io/engine";
import { CONCURRENCY_SETTING, flagValue } from "../src/index.ts";

describe("flagValue", () => {
  test("takes the last occurrence of a repeated flag", () => {
    expect(flagValue(["--model", "a", "--model", "b"], "--model")).toBe("b");
  });

  test("accepts --flag=value, and the last of mixed spellings wins", () => {
    expect(flagValue(["--model=a/b"], "--model")).toBe("a/b");
    expect(flagValue(["--model", "x", "--model=y"], "--model")).toBe("y");
    expect(flagValue(["--model=x", "--model", "y"], "--model")).toBe("y");
  });

  test("a flag with no value, or none at all, is undefined", () => {
    expect(flagValue(["--model"], "--model")).toBeUndefined();
    expect(flagValue(["--other", "x"], "--model")).toBeUndefined();
    expect(flagValue(undefined, "--model")).toBeUndefined();
  });
});

describe("the concurrency setting", () => {
  function load(concurrency: unknown): { registry: PluginRegistry; logs: string[] } {
    const logs: string[] = [];
    const registry = new PluginRegistry(
      [
        definePlugin({
          name: "h",
          kind: "harness",
          version: "0.0.0",
          settings: { type: "object", properties: { concurrency: CONCURRENCY_SETTING } },
        }),
      ],
      {
        store: new MemoryPluginStore({ root: "store" }),
        settings: { h: concurrency === undefined ? {} : { concurrency } },
        onLog: (message) => logs.push(message),
      },
    );
    return { registry, logs };
  }

  test("a map of positive integers loads; the default is {}", () => {
    expect(load({ "p/m": 2 }).registry.settingsFor("h").concurrency).toEqual({ "p/m": 2 });
    expect(load(undefined).registry.settingsFor("h").concurrency).toEqual({});
  });

  test("zero, a string, a fraction or a non-object refuse the plugin at load, naming the field", () => {
    for (const bad of [{ m: 0 }, { m: "2" }, { m: 1.5 }, [1], "x"]) {
      const { registry, logs } = load(bad);
      expect(registry.names()).toEqual([]);
      expect(logs.join("\n")).toContain("settings.concurrency");
    }
  });
});
