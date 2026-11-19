import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createViews, MemoryPluginStore, PluginError, PluginRegistry } from "../../src/index.ts";
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

describe("an action that a chat may run as a command", () => {
  test("its one-line description is in the action list, and an empty one is refused", async () => {
    const registry = new PluginRegistry([
      def({
        name: "a",
        objects: [{ name: "note" }],
        views: {
          note: {
            row: (object) => ({ id: object.id, title: object.id, state: "open" }),
            sections: () => [],
            load: () => ({ markdown: "" }),
          },
        },
        actions: [
          {
            name: "go",
            on: "note",
            command: "Go to the next note.",
            when: () => true,
            run: () => "went",
          },
        ],
      }),
    ]);
    expect(registry.actions().find((info) => info.name === "a:go")).toMatchObject({
      command: "Go to the next note.",
    });
    const store = registry.store;
    await store.put("note", "n1", {}, "test");
    const views = createViews({ registry, store, onLog: () => undefined });
    expect((await views.get("note:n1")).actions.find((info) => info.name === "a:go")).toMatchObject({
      command: "Go to the next note.",
    });
    expect(
      errorOf(() =>
        new PluginRegistry([
          def({
            name: "a",
            objects: [{ name: "note" }],
            actions: [
              {
                name: "go",
                on: "note",
                command: "  ",
                when: () => true,
                run: () => "went",
              },
            ],
          }),
        ]),
      ).message,
    ).toContain("command: must be a boolean or a non-empty string");
  });

  test("command true takes its line from the args description, else the action name", () => {
    const registry = new PluginRegistry([
      def({
        name: "a",
        objects: [{ name: "note" }],
        actions: [
          {
            name: "go",
            on: "note",
            command: true,
            args: { type: "object", description: "Go to the next note." },
            when: () => true,
            run: () => "went",
          },
          {
            name: "bare",
            on: "note",
            command: true,
            when: () => true,
            run: () => "ran",
          },
          {
            name: "quiet",
            on: "note",
            command: false,
            when: () => true,
            run: () => "quiet",
          },
        ],
      }),
    ]);
    expect(registry.actions().find((info) => info.name === "a:go")?.command).toBe("Go to the next note.");
    expect(registry.actions().find((info) => info.name === "a:bare")?.command).toBe("bare");
    expect(registry.actions().find((info) => info.name === "a:quiet")?.command).toBeUndefined();
  });

  test("runActionChecked checks availability, arguments and confirmation before it records anything", async () => {
    const root = await tempRoot();
    const store = new MemoryPluginStore({ root: join(root, "store") });
    const registry = new PluginRegistry(
      [
        def({
          name: "a",
          objects: [{ name: "note" }],
          actions: [
            {
              name: "go",
              on: "note",
              command: "Go.",
              confirm: true,
              args: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
              when: (state) => state.ready === true,
              run: (_ctx, args) => `went ${(args as { readonly value: string }).value}`,
            },
          ],
        }),
      ],
      { store },
    );
    const object = (ready: boolean) => ({
      type: "note",
      id: "n1",
      data: ready ? { ready: true } : {},
    });
    const actor = { via: "test", id: "me" };

    await expect(
      registry.runActionChecked("a/go", { value: "x" }, { object: object(false), actor, yes: true }),
    ).rejects.toThrow(/cannot run now/);
    await expect(
      registry.runActionChecked("a/go", {}, { object: object(true), actor, yes: true }),
    ).rejects.toThrow(/args\.value: is required/);
    await expect(
      registry.runActionChecked("a/go", { value: "x" }, { object: object(true), actor }),
    ).rejects.toThrow(/needs confirmation/);
    expect(store.facts().filter((fact) => fact.type === "action_invoked")).toEqual([]);

    const run = await registry.runActionChecked(
      "a/go",
      { value: "x" },
      { object: object(true), actor, yes: true },
    );
    expect(run.value).toBe("went x");
    expect(store.facts().filter((fact) => fact.type === "action_invoked")).toHaveLength(1);
  });

  test("an action gets the object's actions and can run another one with the same checks", async () => {
    const root = await tempRoot();
    const store = new MemoryPluginStore({ root: join(root, "store") });
    const registry = new PluginRegistry(
      [
        def({
          name: "a",
          objects: [{ name: "note" }],
          actions: [
            {
              name: "go",
              on: "note",
              command: "Go.",
              args: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
              when: () => true,
              run: (_ctx, args) => `went ${(args as { readonly value: string }).value}`,
            },
            {
              name: "forward",
              on: "note",
              when: () => true,
              async run(ctx) {
                const command = ctx.actions?.find((info) => info.command !== undefined);
                if (command === undefined || ctx.act === undefined) return "no command";
                const run = await ctx.act(command.name, { value: "through" });
                return run.value;
              },
            },
          ],
        }),
      ],
      { store },
    );
    const run = await registry.runAction("a/forward", {}, {
      object: { type: "note", id: "n1", data: {} },
      actor: { via: "test", id: "me" },
    });
    expect(run.value).toBe("went through");
  });

  test("a when reads the object it works on, and a refusal prints the why line", async () => {
    const root = await tempRoot();
    const store = new MemoryPluginStore({ root: join(root, "store") });
    const seen: (string | undefined)[] = [];
    const registry = new PluginRegistry(
      [
        def({
          name: "a",
          objects: [{ name: "note" }],
          actions: [
            {
              name: "go",
              on: "note",
              when: (_state, env) => {
                seen.push(env.object === undefined ? undefined : `${env.object.type}:${env.object.id}`);
                return false;
              },
              why: (object) => `${object.id} is not ready yet`,
              run: () => "went",
            },
          ],
        }),
      ],
      { store },
    );
    await store.put("note", "n1", {}, "test");
    const stored = await store.get("note", "n1");
    if (stored === undefined) throw new Error("no note");
    await expect(
      registry.runActionChecked(
        "a/go",
        {},
        { object: { type: "note", id: "n1", data: stored.data }, actor: { via: "test", id: "me" }, yes: true },
      ),
    ).rejects.toThrow("n1 is not ready yet");
    expect(seen).toEqual(["note:n1"]);
  });

  test("a refusal without a why line keeps the plain one", async () => {
    const root = await tempRoot();
    const store = new MemoryPluginStore({ root: join(root, "store") });
    const registry = new PluginRegistry(
      [
        def({
          name: "a",
          objects: [{ name: "note" }],
          actions: [{ name: "go", on: "note", when: () => false, run: () => "went" }],
        }),
      ],
      { store },
    );
    await store.put("note", "n1", {}, "test");
    await expect(
      registry.runActionChecked(
        "a/go",
        {},
        { object: { type: "note", id: "n1", data: {} }, actor: { via: "test", id: "me" }, yes: true },
      ),
    ).rejects.toThrow('action "a:go" cannot run now');
  });

  test("a targetless action's when sees no object", async () => {
    const root = await tempRoot();
    const store = new MemoryPluginStore({ root: join(root, "store") });
    const seen: unknown[] = [];
    const registry = new PluginRegistry(
      [
        def({
          name: "a",
          actions: [
            {
              name: "wait",
              when: (_state, env) => {
                seen.push(env.object);
                return false;
              },
              run: () => undefined,
            },
          ],
        }),
      ],
      { store },
    );
    const views = createViews({ registry, store, onLog: () => undefined });
    await expect(views.act("a:wait", undefined, { actor: { via: "test", id: "me" } })).rejects.toThrow(
      "a:wait cannot run now",
    );
    expect(seen).toEqual([undefined]);
  });
});
