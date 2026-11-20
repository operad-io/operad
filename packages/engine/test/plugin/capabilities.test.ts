import { afterAll, describe, expect, test } from "bun:test";
import { MemoryPluginStore, PluginError, PluginRegistry, definePlugin } from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

function registryOf(definition: unknown): PluginRegistry {
  return new PluginRegistry([definition], { home: "/tmp", cwd: "/tmp", store: new MemoryPluginStore({ root: "/tmp/operad-capabilities-store" }) });
}

describe("harness capabilities", () => {
  test("a harness declares that it loads skills itself", () => {
    const plugin = definePlugin({
      name: "a",
      kind: "harness",
      version: "0.0.1",
      capabilities: { loadsSkills: true },
    });
    expect(plugin.capabilities).toEqual({ loadsSkills: true });
    expect(() => registryOf(plugin)).not.toThrow();
  });

  test("a harness declares that it takes messages mid-run, and the registry exposes it", () => {
    const plugin = definePlugin({
      name: "a",
      kind: "harness",
      version: "0.0.1",
      capabilities: { takesMessagesMidRun: true },
    });
    expect(plugin.capabilities).toEqual({ takesMessagesMidRun: true });
    expect(registryOf(plugin).loadedCapabilities()).toEqual({ a: { takesMessagesMidRun: true } });
  });

  test("a harness declares its background model, and the registry exposes it", () => {
    const plugin = definePlugin({
      name: "a",
      kind: "harness",
      version: "0.0.1",
      capabilities: { backgroundModel: "haiku" },
    });
    expect(plugin.capabilities).toEqual({ backgroundModel: "haiku" });
    expect(registryOf(plugin).loadedCapabilities()).toEqual({
      a: { backgroundModel: "haiku" },
    });
  });

  test("an empty or non-string background model is refused", () => {
    for (const backgroundModel of ["", 1, true]) {
      try {
        registryOf(
          definePlugin({
            name: "a",
            kind: "harness",
            version: "0.0.1",
            capabilities: { backgroundModel } as unknown as { backgroundModel?: string },
          }),
        );
        throw new Error("expected a PluginError");
      } catch (error) {
        if (!(error instanceof PluginError)) throw error;
        expect(error.message).toContain("capabilities.backgroundModel");
      }
    }
  });

  test("a harness declares the access levels it carries, and an absent list carries none", () => {
    const plugin = definePlugin({
      name: "a",
      kind: "harness",
      version: "0.0.1",
      capabilities: { accessLevels: ["plan", "ask", "edits", "full"] },
    });
    expect(plugin.capabilities).toEqual({ accessLevels: ["plan", "ask", "edits", "full"] });
    expect(registryOf(plugin).loadedCapabilities()).toEqual({
      a: { accessLevels: ["plan", "ask", "edits", "full"] },
    });
    expect(
      definePlugin({ name: "b", kind: "harness", version: "0.0.1", capabilities: {} }).capabilities,
    ).toEqual({});
  });

  test("a capability only a harness has is refused on another kind", () => {
    expect(() =>
      registryOf(
        definePlugin({
          name: "a",
          kind: "domain",
          version: "0.0.1",
          capabilities: { loadsSkills: true },
        }),
      ),
    ).toThrow(/capabilities: only a harness plugin declares capabilities/);
  });

  test("an unknown capability and a non-boolean value are refused", () => {
    for (const capabilities of [
      { loadsSkills: "yes" },
      { takesMessagesMidRun: "yes" },
      { accessLevels: "plan" },
      { accessLevels: [1] },
      { doesEverything: true },
    ]) {
      try {
        registryOf(
          definePlugin({
            name: "a",
            kind: "harness",
            version: "0.0.1",
            // The test checks the validator's message for a value it does not know.
            capabilities: capabilities as unknown as { loadsSkills?: boolean; takesMessagesMidRun?: boolean },
          }),
        );
        throw new Error("expected a PluginError");
      } catch (error) {
        if (!(error instanceof PluginError)) throw error;
        expect(error.message).toContain("capabilities");
      }
    }
  });
});
