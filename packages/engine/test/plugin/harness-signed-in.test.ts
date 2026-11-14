import { describe, expect, test } from "bun:test";
import { PluginRegistry, definePlugin, MemoryPluginStore } from "../../src/index.ts";

function harness(signedIn: unknown, kind: "harness" | "domain" = "harness") {
  return definePlugin({
    name: "h",
    kind,
    version: "0.0.0",
    settings: {
      type: "object",
      properties: { mode: { type: "string", default: "off" } },
    },
    signedIn: signedIn as never,
    steps: [{ name: "agent", results: ["done"], run: () => ({ result: "done" }) }],
  });
}

function load(
  plugin: ReturnType<typeof harness>,
  settings: Readonly<Record<string, unknown>> = { mode: "on" },
) {
  return new PluginRegistry([plugin], {
    home: "/tmp/none",
    cwd: "/tmp",
    store: new MemoryPluginStore({ root: "/tmp/none-store" }),
    settings: { h: settings },
    onLog: () => undefined,
  });
}

describe("a harness plugin's signedIn", () => {
  test("passes true and false through, and gives undefined when it cannot tell", async () => {
    expect(await load(harness(() => true)).signedInFor("h")).toBe(true);
    expect(await load(harness(() => false)).signedInFor("h")).toBe(false);
    expect(await load(harness(() => undefined)).signedInFor("h")).toBeUndefined();
  });

  test("reads the plugin's settings each time", async () => {
    let calls = 0;
    let received: unknown;
    const registry = load(
      harness((settings: Record<string, unknown>) => {
        calls += 1;
        received = settings;
        return settings.mode === "on";
      }),
    );
    expect(await registry.signedInFor("h")).toBe(true);
    expect(received).toBe(registry.settingsFor("h"));
    expect(await registry.signedInFor("h")).toBe(true);
    expect(calls).toBe(2);
  });

  test("is absent for a plugin that declares none, a missing plugin, or a broken answer", async () => {
    const plugin = definePlugin({
      name: "h",
      kind: "harness",
      version: "0.0.0",
      steps: [{ name: "agent", results: ["done"], run: () => ({ result: "done" }) }],
    });
    const registry = new PluginRegistry([plugin], {
      home: "/tmp/none",
      cwd: "/tmp",
      store: new MemoryPluginStore({ root: "/tmp/none-store" }),
      onLog: () => undefined,
    });
    expect(await registry.signedInFor("h")).toBeUndefined();
    expect(await registry.signedInFor("missing")).toBeUndefined();
    expect(await load(harness(() => "yes")).signedInFor("h")).toBeUndefined();
  });

  test("only a harness plugin declares it", () => {
    expect(() => load(harness(() => true, "domain"))).toThrow(/only a harness/);
  });
});
