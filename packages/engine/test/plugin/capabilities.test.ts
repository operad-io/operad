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
    for (const capabilities of [{ loadsSkills: "yes" }, { doesEverything: true }]) {
      try {
        registryOf(
          definePlugin({
            name: "a",
            kind: "harness",
            version: "0.0.1",
            // The test checks the validator's message for a value it does not know.
            capabilities: capabilities as unknown as { loadsSkills?: boolean },
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
