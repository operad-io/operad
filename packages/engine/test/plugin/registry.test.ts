import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineFlow,
  definePlugin,
  loadPluginRegistry,
  MemoryPluginStore,
  PluginRegistry,
} from "../../src/index.ts";
import notes from "../fixtures/plugins/notes.ts";
import { cleanupTempRoots, def, tempRoot } from "./support.ts";

const notesPlugin = fileURLToPath(
  new URL("../fixtures/plugins/notes.ts", import.meta.url),
);
const usesNotes = fileURLToPath(
  new URL("../fixtures/flows/uses-notes.ts", import.meta.url),
);
const usesMissing = fileURLToPath(
  new URL("../fixtures/flows/uses-missing.ts", import.meta.url),
);

afterAll(cleanupTempRoots);

function path(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected a path");
  return value;
}

describe("plugin registry", () => {
  test("loads a plugin from the operad home config", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    const configPath = join(home, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        plugins: [relative(home, notesPlugin)],
        // The registry reads the plugins and the store the kernel opens.
        store: { backend: "jsonl", path: join(root, "store") },
      }),
    );
    const store = new MemoryPluginStore({ root: join(root, "store") });
    const registry = await loadPluginRegistry({ home, configPath, store });

    expect(registry.names()).toEqual(["notes"]);
    expect(registry.stepTypes()).toEqual([
      { name: "notes/write", results: ["ok", "failed"] },
    ]);
    expect(registry.flows()).toEqual([]);
  });

  test("runs the test plugin's step, command and action end to end", async () => {
    const root = await tempRoot();
    const store = new MemoryPluginStore({ root: join(root, "store") });
    const logs: string[] = [];
    const registry = new PluginRegistry([notes], {
      store,
      onLog: (message) => logs.push(message),
    });

    const outcome = await registry.runStep(
      "notes/write",
      { text: "hello" },
      {
        runId: "run-1",
        object: { type: "note", id: "n1", data: {} },
        cwd: root,
      },
    );
    expect(outcome.result).toBe("ok");
    const logPath = path(outcome.data?.path);
    expect(logPath.startsWith(join(root, "store", "logs"))).toBe(true);
    expect(await readFile(logPath, "utf8")).toContain("run-1: hello");

    const written = store.facts().find((fact) => fact.type === "note.written");
    expect(written?.cause).toBe("step:notes/write");
    expect(written?.data.path).toBe(logPath);
    expect(written?.data.cwd).toBe(root);
    expect(written?.data.plugin).toBe("notes");
    expect(written?.object).toEqual({ type: "note", id: "n1" });

    const note = store.get("note", "n1");
    expect(note?.version).toBe(1);
    expect(note?.data.text).toBe("hello");
    expect(note?.data.path).toBe(logPath);
    expect(store.list("note").objects.map((item) => item.id)).toEqual(["n1"]);
    expect(
      store.facts().some(
        (fact) => fact.type === "note" && fact.cause === "step run-1",
      ),
    ).toBe(true);

    expect(registry.resolveCommand(["notes", "add", "hi"])).toEqual({
      plugin: "notes",
      command: "add",
      argv: ["hi"],
    });
    expect(registry.resolveCommand(["add", "hi"])).toEqual({
      plugin: "notes",
      command: "add",
      argv: ["hi"],
    });
    const command = await registry.runCommand(["add", "second"]);
    expect(command?.value).toMatchObject({
      type: "note",
      id: "n1",
      data: { text: "second" },
    });
    expect(store.get("note", "n1")?.data.text).toBe("second");

    const pending = await registry.pending([
      {
        runId: "run-2",
        object: { type: "note", id: "n1" },
        prompt: "Continue?",
        choices: ["yes"],
      },
    ]);
    const entry = pending[0];
    if (entry === undefined) throw new Error("expected a pending entry");
    expect(entry.prompt).toBe("Continue?");
    expect(entry.choices).toEqual(["yes"]);
    expect(entry.actions).toEqual([{ plugin: "notes", action: "archive" }]);

    const action = await registry.runAction("notes/archive", {}, {
      object: entry.object,
      runId: "run-2",
      actor: { via: "test", id: "tester" },
    });
    expect(action).toEqual({
      plugin: "notes",
      action: "archive",
      value: undefined,
    });
    expect(store.get("note", "n1")?.data.archived).toBe(true);
    expect(
      store.facts().some((fact) => fact.type === "note.archived"),
    ).toBe(true);

    const after = await registry.pending([
      { runId: "run-2", object: { type: "note", id: "n1" } },
    ]);
    expect(after[0]?.actions).toEqual([]);
    expect(logs).toEqual([]);
  });

  test("an action receives the person's actor", async () => {
    const root = await tempRoot();
    const store = new MemoryPluginStore({ root: join(root, "store") });
    const registry = new PluginRegistry(
      [
        def({
          name: "a",
          objects: [{ name: "note" }],
          actions: [
            {
              name: "who",
              on: "note",
              when: () => true,
              async run(ctx) {
                await ctx.store.put(
                  "note",
                  ctx.object.id,
                  { actor: ctx.actor },
                  "who",
                );
              },
            },
          ],
        }),
      ],
      { store },
    );
    await store.put("note", "n1", { text: "one" }, "seed");

    await registry.runAction("who", {}, {
      object: { type: "note", id: "n1", data: {} },
      actor: { via: "telegram", id: "owner" },
    });
    expect(store.get("note", "n1")?.data.actor).toEqual({
      via: "telegram",
      id: "owner",
    });
  });

  test("records who asked in the action's fact", async () => {
    const root = await tempRoot();
    const store = new MemoryPluginStore({ root: join(root, "store") });
    const registry = new PluginRegistry([notes], { store });
    await store.put("note", "n1", { text: "one" }, "seed");

    await registry.runAction("notes/archive", {}, {
      object: (await store.get("note", "n1")) ?? {
        type: "note",
        id: "n1",
        data: {},
        version: 1,
        cause: "seed",
        at: 0,
      },
      actor: { via: "ios", id: "owner" },
    });

    const fact = store
      .facts()
      .find((entry) => entry.type === "action_invoked");
    expect(fact?.data).toMatchObject({
      action: "notes/archive",
      actor: { via: "ios", id: "owner" },
    });
  });

  test("passes the cancel signal to a step", async () => {
    const root = await tempRoot();
    const registry = new PluginRegistry([notes], {
      storeRoot: join(root, "store"),
    });
    const controller = new AbortController();
    controller.abort();

    const outcome = await registry.runStep(
      "notes/write",
      { text: "ignored" },
      { runId: "run-1", signal: controller.signal },
    );
    expect(outcome.result).toBe("failed");
    expect(outcome.data?.reason).toBe("aborted");
  });

  test("gives the flow loader the loaded step types", async () => {
    const root = await tempRoot();
    const registry = new PluginRegistry([notes], {
      storeRoot: join(root, "store"),
    });

    const flow = await registry.loadFlow(usesNotes);
    expect(flow.name).toBe("write-note");
    expect(flow.steps[0]?.params).toEqual({
      use: "notes/write",
      params: { text: "hello" },
    });

    await expect(registry.loadFlow(usesMissing)).rejects.toThrow(
      /unknown plugin step type "ghost\/write"/,
    );
    await expect(registry.loadFlow(usesMissing)).rejects.toThrow(usesMissing);
  });

  test("lets onTick ask for a run of one of the plugin's flows", async () => {
    const root = await tempRoot();
    const plugin = defineTickPlugin();
    const logs: string[] = [];
    const registry = new PluginRegistry([plugin], {
      storeRoot: join(root, "store"),
      onLog: (message) => logs.push(message),
    });

    await registry.tick();
    expect(registry.startedRuns).toEqual([
      { plugin: "clock", flow: "every-hour", object: { type: "tick", id: "1" } },
    ]);
    expect(logs).toEqual([]);
  });

  test("logs an onTick failure instead of raising it", async () => {
    const root = await tempRoot();
    const logs: string[] = [];
    const registry = new PluginRegistry(
      [
        {
          ...defineTickPlugin(),
          onTick: () => {
            throw new Error("tick exploded");
          },
        },
      ],
      {
        storeRoot: join(root, "store"),
        onLog: (message) => logs.push(message),
      },
    );

    await registry.tick();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("tick exploded");
    expect(registry.startedRuns).toEqual([]);
  });
});

function defineTickPlugin() {
  return definePlugin({
    name: "clock",
    kind: "source",
    version: "0.0.1",
    objects: [{ name: "tick" }],
    flows: [
      defineFlow({
        name: "every-hour",
        entry: "done",
        steps: [
          {
            id: "done",
            kind: "end",
            params: { status: "done" },
            replay: "safe",
          },
        ],
      }),
    ],
    onTick: async (ctx) => {
      await ctx.start("every-hour", { type: "tick", id: "1" });
    },
  });
}
