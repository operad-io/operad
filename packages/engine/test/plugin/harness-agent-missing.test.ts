import { describe, expect, test } from "bun:test";
import { PluginRegistry, definePlugin, MemoryPluginStore } from "../../src/index.ts";

const SENTENCE = "the agent is not on PATH; install it";

function harness(
  name: string,
  agentMissing: unknown,
  calls: string[] = [],
) {
  return definePlugin({
    name,
    kind: "harness",
    version: "0.0.0",
    agentMissing: agentMissing as never,
    models: () => {
      calls.push("models");
      return { list: ["m"], default: "m" };
    },
    signedIn: () => {
      calls.push("signedIn");
      return false;
    },
    check: () => {
      calls.push("check");
      throw new Error("not found");
    },
    steps: [{ name: "agent", results: ["done"], run: () => ({ result: "done" }) }],
  });
}

function load(plugins: readonly ReturnType<typeof harness>[]) {
  return new PluginRegistry(plugins, {
    home: "/tmp/none",
    cwd: "/tmp",
    store: new MemoryPluginStore({ root: "/tmp/none-store" }),
    onLog: () => undefined,
  });
}

describe("a harness plugin whose agent is missing", () => {
  test("is not offered as an agent, though its step stays loaded", () => {
    const registry = load([harness("gone", () => SENTENCE), harness("here", () => undefined)]);
    expect(registry.loadedHarnesses()).toEqual(["here"]);
    expect(registry.actionEnv().harnesses).toEqual(["here"]);
    expect(registry.stepLoaded("gone/agent")).toBe(true);
    expect(registry.missingAgents()).toEqual([{ name: "gone", description: SENTENCE }]);
  });

  test("is found again once the agent is there", () => {
    let there = false;
    const registry = load([harness("h", () => (there ? undefined : SENTENCE))]);
    expect(registry.loadedHarnesses()).toEqual([]);
    there = true;
    expect(registry.loadedHarnesses()).toEqual(["h"]);
  });

  test("is seen by a source that is already running once the agent is there", async () => {
    let there = false;
    let seen: () => readonly string[] | undefined = () => undefined;
    const source = definePlugin({
      name: "watcher",
      kind: "domain",
      version: "0.0.0",
      start(ctx) {
        seen = () => ctx.harnesses;
        return { stop: () => undefined };
      },
    });
    const registry = load([harness("h", () => (there ? undefined : SENTENCE)), source as never]);
    const running = await registry.startSources({
      rules: [],
      clock: () => 0,
      client: {} as never,
      emit: async () => undefined,
    });
    expect(seen()).toEqual([]);
    there = true;
    expect(seen()).toEqual(["h"]);
    for (const item of running) await item.handle.stop();
  });

  test("is named to an action with how to set it up", () => {
    const registry = load([harness("gone", () => SENTENCE)]);
    expect(registry.actionEnv().missingAgents).toEqual({ gone: SENTENCE });
  });

  test("is not asked for its sign-in or its models", async () => {
    const calls: string[] = [];
    const registry = load([harness("h", () => SENTENCE, calls)]);
    expect(await registry.signedInFor("h")).toBeUndefined();
    expect(registry.loadedModels()).toEqual({});
    expect(await registry.loadedModelsReady()).toEqual({});
    expect(calls).toEqual([]);
  });

  test("passes its check as not set up, and the plugin's own check does not run", async () => {
    const calls: string[] = [];
    const registry = load([harness("h", () => SENTENCE, calls)]);
    expect(await registry.checks()).toEqual([
      {
        plugin: "h",
        ok: true,
        message: `not set up: ${SENTENCE}`,
        missing: [{ name: "agent", description: SENTENCE }],
      },
    ]);
    expect(calls).toEqual([]);
  });

  test("counts as there when the answer is not a sentence", async () => {
    const registry = load([harness("h", () => true)]);
    expect(registry.loadedHarnesses()).toEqual(["h"]);
    expect((await registry.checks())[0]?.ok).toBe(false);
  });

  test("only a harness plugin declares it", () => {
    const domain = definePlugin({ name: "h", kind: "domain", version: "0.0.0", agentMissing: () => undefined });
    expect(() => load([domain as never])).toThrow(/agentMissing: only a harness/);
  });
});
