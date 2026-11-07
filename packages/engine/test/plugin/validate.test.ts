import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  defineFlow,
  MemoryPluginStore,
  PluginError,
  PluginRegistry,
} from "../../src/index.ts";
import { cleanupTempRoots, def, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

function errorOf(run: () => unknown): PluginError {
  try {
    run();
  } catch (error) {
    if (error instanceof PluginError) return error;
    throw error;
  }
  throw new Error("expected a PluginError");
}

const command = { name: "run", args: "", run: () => undefined };

describe("plugin registry validation", () => {
  test("rejects two plugins with the same name", () => {
    const error = errorOf(
      () => new PluginRegistry([def({ name: "same" }), def({ name: "same" })]),
    );
    expect(error.message).toContain('plugin "same"');
    expect(error.message).toContain("duplicate plugin name");
  });

  test("rejects a plugin with an unsupported API version", () => {
    const error = errorOf(
      () =>
        new PluginRegistry([
          { operadPlugin: 2, name: "old", kind: "domain", version: "0.0.1" },
        ]),
    );
    expect(error.message).toContain('plugin "old"');
    expect(error.message).toContain("operadPlugin");
    expect(error.message).toContain("expected 1");
    expect(error.message).toContain("got 2");
  });

  test("rejects an unknown plugin kind", () => {
    const error = errorOf(
      () =>
        new PluginRegistry([
          {
            operadPlugin: 1,
            name: "odd",
            kind: "robot",
            version: "0.0.1",
          },
        ]),
    );
    expect(error.message).toContain('plugin "odd"');
    expect(error.message).toContain("kind");
  });

  test("rejects an object type another plugin already owns", () => {
    const error = errorOf(
      () =>
        new PluginRegistry([
          def({ name: "a", objects: [{ name: "task" }] }),
          def({ name: "b", objects: [{ name: "task" }] }),
        ]),
    );
    expect(error.message).toContain('plugin "b"');
    expect(error.message).toContain('object "task"');
    expect(error.message).toContain("another plugin already owns it");
  });

  test("rejects duplicate step result names", () => {
    const error = errorOf(
      () =>
        new PluginRegistry([
          def({
            name: "a",
            steps: [
              {
                name: "step",
                results: ["ok", "ok"],
                run: () => ({ result: "ok" }),
              },
            ],
          }),
        ]),
    );
    expect(error.message).toContain('plugin "a"');
    expect(error.message).toContain('duplicate result "ok"');
  });

  test("rejects an action on an object type no plugin owns", () => {
    const error = errorOf(
      () =>
        new PluginRegistry([
          def({
            name: "a",
            actions: [
              {
                name: "do",
                on: "ghost",
                when: () => true,
                run: () => undefined,
              },
            ],
          }),
        ]),
    );
    expect(error.message).toContain('plugin "a"');
    expect(error.message).toContain('action "do"');
    expect(error.message).toContain('unknown object type "ghost"');
  });

  test("rejects duplicate commands inside one plugin", () => {
    const error = errorOf(
      () =>
        new PluginRegistry([
          def({ name: "a", commands: [command, command] }),
        ]),
    );
    expect(error.message).toContain('plugin "a"');
    expect(error.message).toContain('duplicate command "run"');
  });

  test("rejects two plugins that declare the same short command", () => {
    const error = errorOf(
      () =>
        new PluginRegistry([
          def({ name: "a", commands: [command] }),
          def({ name: "b", commands: [command] }),
        ]),
    );
    expect(error.message).toContain('command "run"');
    expect(error.message).toContain('"a"');
    expect(error.message).toContain('"b"');
  });

  test("rejects a plugin flow that uses a step of a plugin that is not loaded", () => {
    const flow = defineFlow({
      name: "ghost",
      entry: "run",
      steps: [
        {
          id: "run",
          kind: "plugin",
          params: { use: "ghost/step", params: {} },
          replay: "safe",
          next: {},
        },
      ],
    });
    const error = errorOf(
      () => new PluginRegistry([def({ name: "a", flows: [flow] })]),
    );
    expect(error.message).toContain('plugin "a"');
    expect(error.message).toContain('flow "ghost"');
    expect(error.message).toContain('step "run"');
    expect(error.message).toContain(
      'unknown plugin step type "ghost/step"',
    );
  });

  test("rejects a flow whose unsafe step has no interrupted edge", () => {
    const flow = defineFlow({
      name: "stuck",
      entry: "run",
      steps: [
        {
          id: "run",
          kind: "plugin",
          params: { use: "a/step", params: {} },
          replay: "unsafe",
          next: { ok: "end" },
        },
      ],
    });
    const error = errorOf(
      () =>
        new PluginRegistry([
          def({
            name: "a",
            flows: [flow],
            steps: [
              {
                name: "step",
                results: ["ok"],
                run: () => ({ result: "ok" }),
              },
            ],
          }),
        ]),
    );
    expect(error.message).toContain('plugin "a"');
    expect(error.message).toContain('flow "stuck"');
    expect(error.message).toContain('step "run"');
    expect(error.message).toContain('no edge for result "interrupted"');
  });

  test("rejects a step that returns a result it did not declare", async () => {
    const root = await tempRoot();
    const registry = new PluginRegistry(
      [
        def({
          name: "a",
          steps: [
            {
              name: "step",
              results: ["ok"],
              run: () => ({ result: "nope" }),
            },
          ],
        }),
      ],
      { storeRoot: join(root, "store") },
    );
    await expect(registry.runStep("a/step", {}, { runId: "r" })).rejects.toThrow(
      /result "nope" is not one of "ok"/,
    );
  });

  test("rejects an unknown step type", async () => {
    const root = await tempRoot();
    const registry = new PluginRegistry([], {
      storeRoot: join(root, "store"),
    });
    await expect(registry.runStep("ghost/step", {}, { runId: "r" })).rejects.toThrow(
      /no loaded plugin declares it/,
    );
  });

  test("rejects an action args schema with an unknown keyword", () => {
    const error = errorOf(
      () =>
        new PluginRegistry([
          def({
            name: "a",
            objects: [{ name: "note" }],
            actions: [
              {
                name: "go",
                on: "note",
                args: {
                  type: "object",
                  properties: {
                    title: { type: "string", pattern: "^a" },
                  },
                } as never,
                when: () => true,
                run: () => undefined,
              },
            ],
          }),
        ]),
    );
    expect(error.message).toContain('plugin "a"');
    expect(error.message).toContain('unknown keyword "pattern"');
  });

  test("rejects a note property that is not a string", () => {
    const error = errorOf(
      () =>
        new PluginRegistry([
          def({
            name: "a",
            objects: [{ name: "note" }],
            actions: [
              {
                name: "go",
                on: "note",
                args: {
                  type: "object",
                  properties: { reason: { role: "note" } },
                  required: ["reason"],
                } as never,
                when: () => true,
                run: () => undefined,
              },
            ],
          }),
        ]),
    );
    expect(error.message).toContain('a note property must have type "string"');
  });

  test("rejects the old action note field and points at args", () => {
    const error = errorOf(
      () =>
        new PluginRegistry([
          def({
            name: "a",
            objects: [{ name: "note" }],
            actions: [
              {
                name: "go",
                on: "note",
                note: { required: true },
                when: () => true,
                run: () => undefined,
              } as never,
            ],
          }),
        ]),
    );
    expect(error.message).toContain("note: is no longer a field");
    expect(error.message).toContain('role "note"');
  });

  test("rejects an object index that is not a field list", () => {
    const error = errorOf(
      () =>
        new PluginRegistry([
          def({ name: "a", objects: [{ name: "note", index: "tag" } as never] }),
        ]),
    );
    expect(error.message).toContain("index");
    expect(error.message).toContain("array");
  });

  test("hides and logs an action whose when throws", async () => {
    const root = await tempRoot();
    const store = new MemoryPluginStore({ root: join(root, "store") });
    const logs: string[] = [];
    const registry = new PluginRegistry(
      [
        def({
          name: "a",
          objects: [{ name: "note" }],
          actions: [
            {
              name: "boom",
              on: "note",
              when: () => {
                throw new Error("kaboom");
              },
              run: () => undefined,
            },
          ],
        }),
      ],
      { store, onLog: (message) => logs.push(message) },
    );
    store.put("note", "n1", {}, "test");

    const pending = await registry.pending([
      { runId: "r", object: { type: "note", id: "n1" } },
    ]);
    expect(pending[0]?.actions).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('plugin "a"');
    expect(logs[0]).toContain('action "boom"');
    expect(logs[0]).toContain("when failed");
    expect(logs[0]).toContain("kaboom");
  });

  test("keeps the short command behind a kernel verb", () => {
    const registry = new PluginRegistry(
      [def({ name: "a", commands: [command] })],
      { kernelVerbs: ["run"] },
    );
    expect(registry.resolveCommand(["run"])).toBeUndefined();
    expect(registry.resolveCommand(["a", "run"])).toEqual({
      plugin: "a",
      command: "run",
      argv: [],
    });
  });

  test("needs the plugin prefix for an action two plugins declare", async () => {
    const registry = new PluginRegistry([
      def({
        name: "a",
        objects: [{ name: "one" }],
        actions: [
          { name: "go", on: "one", when: () => true, run: () => undefined },
        ],
      }),
      def({
        name: "b",
        objects: [{ name: "two" }],
        actions: [
          { name: "go", on: "two", when: () => true, run: () => undefined },
        ],
      }),
    ]);
    await expect(
      registry.runAction("go", undefined, {
        object: { type: "one", id: "x", data: {} },
        actor: { via: "test", id: "tester" },
      }),
    ).rejects.toThrow(/declared by plugins "a" and "b"/);
  });

  test("runs an action name that is declared for two object types", async () => {
    const seen: string[] = [];
    const registry = new PluginRegistry([
      def({
        name: "a",
        objects: [{ name: "one" }, { name: "two" }],
        actions: [
          {
            name: "go",
            on: "one",
            when: () => true,
            run: () => {
              seen.push("one");
            },
          },
          {
            name: "go",
            on: "two",
            when: () => true,
            run: () => {
              seen.push("two");
            },
          },
        ],
      }),
    ]);
    await registry.runAction("a/go", undefined, {
      object: { type: "one", id: "x", data: {} },
      actor: { via: "test", id: "tester" },
    });
    await registry.runAction("a/go", undefined, {
      object: { type: "two", id: "y", data: {} },
      actor: { via: "test", id: "tester" },
    });
    expect(seen).toEqual(["one", "two"]);
    expect(registry.actionDefinition("a", "go", "two")?.on).toBe("two");
  });

  test("logs an onTick that starts an undeclared flow", async () => {
    const root = await tempRoot();
    const logs: string[] = [];
    const registry = new PluginRegistry(
      [
        def({
          name: "a",
          onTick: (ctx) => ctx.start("missing"),
        }),
      ],
      { storeRoot: join(root, "store"), onLog: (message) => logs.push(message) },
    );
    await registry.tick();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('flow "missing"');
    expect(logs[0]).toContain("not declared");
  });
  describe("step limits", () => {
    const run = () => ({ result: "ok" });
    const declare = (limit: unknown): PluginRegistry =>
      new PluginRegistry([
        def({
          name: "limited",
          steps: [{ name: "agent", results: ["ok"], limit, run } as never],
        }),
      ]);

    test("accepts key and concurrent functions", () => {
      const registry = declare({ key: () => "a", concurrent: () => 2 });
      expect(registry.stepLimit("limited/agent", {})).toEqual({ key: "a", concurrent: 2 });
    });

    test("a key function that returns nothing means no limit for that call", () => {
      const registry = declare({ key: () => undefined, concurrent: () => 2 });
      expect(registry.stepLimit("limited/agent", {})).toBeUndefined();
    });

    test("refuses a declaration of the wrong shape, naming plugin and step type", () => {
      const wrong: [unknown, string][] = [
        ["one", "must be { key, concurrent }"],
        [{ concurrent: () => 1 }, "key: must be a function"],
        [{ key: () => "a" }, "concurrent: must be a function"],
        [{ key: "a", concurrent: () => 1 }, "key: must be a function"],
        [{ key: () => "a", concurrent: 2 }, "concurrent: must be a function"],
        [{ key: () => "a", concurrent: () => 1, extra: 1 }, 'unknown field "extra"'],
      ];
      for (const [limit, reason] of wrong) {
        const error = errorOf(() => declare(limit));
        expect(error.message).toContain('plugin "limited"');
        expect(error.message).toContain('step "agent"');
        expect(error.message).toContain("limit:");
        expect(error.message).toContain(reason);
      }
    });

    test("a key or count that is not usable fails the call, naming the step type", () => {
      const badKey = declare({ key: () => 7, concurrent: () => 1 });
      expect(errorOf(() => badKey.stepLimit("limited/agent", {})).message).toContain(
        'step "limited/agent": limit: key must return a non-empty string or undefined',
      );
      for (const count of [0, 1.5, "2"]) {
        const badCount = declare({ key: () => "a", concurrent: () => count });
        expect(errorOf(() => badCount.stepLimit("limited/agent", {})).message).toContain(
          "concurrent must return a positive integer",
        );
      }
      const throwing = declare({
        key: () => {
          throw new Error("no model");
        },
        concurrent: () => 1,
      });
      expect(errorOf(() => throwing.stepLimit("limited/agent", {})).message).toContain(
        "no model",
      );
    });

    test("the key and count are computed from the params and the plugin's settings", () => {
      const registry = new PluginRegistry(
        [
          def({
            name: "limited",
            settings: { type: "object", properties: { slots: { type: "integer" } } },
            steps: [
              {
                name: "agent",
                results: ["ok"],
                limit: {
                  key: (params: unknown) =>
                    typeof params === "object" && params !== null && "model" in params
                      ? String((params as { model: unknown }).model)
                      : undefined,
                  concurrent: (_params: unknown, settings: Readonly<Record<string, unknown>>) =>
                    Number(settings.slots),
                },
                run,
              } as never,
            ],
          }),
        ],
        { settings: { limited: { slots: 3 } } },
      );
      expect(registry.stepLimit("limited/agent", { model: "m" })).toEqual({ key: "m", concurrent: 3 });
      expect(registry.stepLimit("limited/agent", {})).toBeUndefined();
    });
  });
});
