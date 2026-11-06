import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createViews,
  defineFlow,
  definePlugin,
  MemoryPluginStore,
  openLog,
  PluginRegistry,
  ViewError,
  type LogBackend,
} from "../../src/index.ts";
import demo from "../fixtures/plugins/presentation.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

interface Fixture {
  readonly root: string;
  readonly store: MemoryPluginStore;
  readonly registry: PluginRegistry;
  readonly log: LogBackend;
  readonly logs: string[];
}

async function fixture(): Promise<Fixture> {
  const root = await tempRoot();
  const store = new MemoryPluginStore({ root: join(root, "plugins") });
  store.put("item", "one", { title: "First", state: "new", note: "$1" }, "seed");
  store.put("item", "two", { title: "Second", state: "open" }, "seed");
  const logs: string[] = [];
  const registry = new PluginRegistry([demo], {
    store,
    onLog: (message) => logs.push(message),
  });
  const log = openLog({ backend: "jsonl", path: join(root, "store") });
  return { root, store, registry, log, logs };
}

async function waitFact(
  log: LogBackend,
  object: string,
  kind: string,
  payload: object,
): Promise<string> {
  const info = await log.startRun("demo-flow", object);
  await log.append(info.runId, 0, [
    { kind, payload: payload as never, cause: "test" },
  ]);
  return info.runId;
}

describe("presentation views", () => {
  test("lists rows with the kernel's waiting and running flags", async () => {
    const { store, registry, log } = await fixture();
    await waitFact(log, "item:one", "waiting_for_person", {
      waitId: "wait:1",
      step: "ask",
      prompt: "Approve?",
      choices: ["yes"],
      waitKind: "step",
      effectId: null,
    });
    const running = await log.startRun("other", "item:two");
    await log.append(running.runId, 0, [
      { kind: "run_started", payload: { flow: "other" }, cause: "test" },
    ]);

    const views = createViews({ registry, store, log });
    const rows = await views.list("item");
    expect(rows.map((row) => row.id)).toEqual(["one", "two"]);
    expect(rows[0]).toMatchObject({
      title: "First",
      state: "new",
      note: "$1",
      waiting: true,
      running: false,
    });
    expect(rows[1]).toMatchObject({ waiting: false, running: true });
    await log.close();
  });

  test("shows a row, the section directory, the kernel history and actions", async () => {
    const { store, registry, log } = await fixture();
    const runId = await waitFact(log, "item:one", "run_started", {
      flow: "demo-flow",
    });

    const views = createViews({ registry, store, log });
    const object = await views.get("item:one");
    expect(object.row.id).toBe("one");
    expect(object.sections.map((section) => section.id)).toEqual([
      "info",
      "log",
      "pages",
      "hang",
      "big",
      "history",
    ]);
    expect(object.sections.at(-1)?.title).toBe("History");
    expect(object.actions.map((action) => action.name)).toEqual([
      "demo:approve",
      "demo:drop",
    ]);
    const approve = object.actions.find((action) => action.name === "demo:approve");
    expect(approve?.noteRequired).toBe(true);
    expect(approve?.key).toBe("m");
    expect(object.actions.some((action) => action.name === "demo:hidden")).toBe(
      false,
    );

    const history = await views.section("item:one", "history");
    expect(history.markdown).toContain(runId);
    expect(history.markdown).toContain("run started");
    await log.close();
  });

  test("reads sections, pages with next and grows a live section", async () => {
    const { store, registry, log } = await fixture();
    const views = createViews({ registry, store, log });

    const info = await views.section("item:one", "info");
    expect(info.markdown).toContain("```diff");
    expect(info.markdown).toContain("| alpha | 1 |");
    expect(info.markdown).toContain("```mermaid");

    const first = await views.section("item:one", "pages");
    expect(first.markdown).toBe("page one");
    expect(first.next).toBe("two");
    const second = await views.section("item:one", "pages", first.next);
    expect(second.markdown).toBe("page two");
    expect(second.next).toBeUndefined();

    const logOne = await views.section("item:one", "log");
    const logTwo = await views.section("item:one", "log");
    expect(logOne.markdown).toBe("line 1");
    expect(logTwo.markdown).toBe("line 1\nline 2");
    await log.close();
  });

  test("an unknown id and an unloaded plugin's object are clear", async () => {
    const { store, registry, log } = await fixture();
    const views = createViews({ registry, store, log });
    await expect(views.get("item:nope")).rejects.toThrow(/no object/);

    const runId = await waitFact(log, "item:one", "run_started", {
      flow: "demo-flow",
    });
    const empty = new PluginRegistry([], { store });
    const after = createViews({ registry: empty, store, log });
    const object = await after.get("item:one");
    expect(object.unavailable).toContain("not loaded");
    expect(object.sections.map((section) => section.id)).toEqual(["history"]);
    expect(object.actions).toEqual([]);
    expect((await after.section("item:one", "history")).markdown).toContain(
      runId,
    );
    await log.close();
  });

  test("runs actions with a required note and with confirmation", async () => {
    const { store, registry, log } = await fixture();
    const views = createViews({ registry, store, log });

    await expect(views.act("demo:approve", "item:one")).rejects.toMatchObject({
      kind: "note",
    });
    const run = await views.act("demo:approve", "item:one", {
      note: "looks good",
    });
    expect(run.name).toBe("demo:approve");
    expect(store.get("item", "one")?.data.approved).toBe(true);
    expect(store.get("item", "one")?.data.approvedNote).toBe("looks good");

    await expect(views.act("demo:drop", "item:two")).rejects.toMatchObject({
      kind: "confirm",
    });
    await views.act("demo:drop", "item:two", { yes: true });
    expect(store.get("item", "two")?.data.dropped).toBe(true);

    await expect(views.act("demo:hidden", "item:one")).rejects.toMatchObject({
      kind: "action",
    });
    await log.close();
  });

  test("a Promise or a slow row becomes an error row, not a crash", async () => {
    const { store, registry, log, logs } = await fixture();
    store.put("item", "async", { title: "Async", mode: "async" }, "seed");
    store.put("item", "slow", { title: "Slow", mode: "slow" }, "seed");
    const views = createViews({
      registry,
      store,
      log,
      onLog: (message) => logs.push(message),
    });
    const rows = await views.list("item");
    const asyncRow = rows.find((row) => row.id === "async");
    const slowRow = rows.find((row) => row.id === "slow");
    expect(asyncRow?.state).toBe("error");
    expect(asyncRow?.error).toContain("Promise");
    expect(slowRow?.state).toBe("error");
    expect(slowRow?.error).toContain("limit");
    expect(logs.some((line) => line.includes("row failed"))).toBe(true);
    await log.close();
  });

  test("a section over the timeout and over the cap is reported", async () => {
    const { store, registry, log } = await fixture();
    const views = createViews({
      registry,
      store,
      log,
      loadTimeoutMs: 20,
      sectionCapBytes: 1024,
    });

    await expect(views.section("item:one", "hang")).rejects.toMatchObject({
      kind: "timeout",
    });

    const capped = await views.section("item:one", "big");
    expect(capped.markdown).toContain(
      "operad show item:one --section big --full",
    );
    expect(Buffer.byteLength(capped.markdown, "utf8")).toBeLessThanOrEqual(1024);
    const full = await views.section("item:one", "big", undefined, {
      full: true,
    });
    expect(full.markdown.length).toBe(300 * 1024);
    await log.close();
  });

  test("events coalesce a repeated id and stay bounded for a slow consumer", async () => {
    const { store, registry, log } = await fixture();
    const views = createViews({ registry, store, log, maxEventIds: 3 });
    const stream = views.events()[Symbol.asyncIterator]();

    for (let index = 0; index < 5; index += 1) {
      store.put("item", "same", { title: `v${index}` }, "seed");
    }
    const first = await stream.next();
    expect(first.value).toEqual({ id: "same" });

    const second = views.events()[Symbol.asyncIterator]();
    for (const id of ["a", "b", "c", "d", "e"]) {
      store.put("item", id, { title: id }, "seed");
    }
    const seen: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const next = await second.next();
      expect(next.done).toBe(false);
      if (!next.done) seen.push(next.value.id);
    }
    expect(seen).toEqual(["c", "d", "e"]);
    await second.return?.();
    await stream.return?.();
    await log.close();
  });

  test("a key clash drops the later default and the action still runs", async () => {
    const root = await tempRoot();
    const store = new MemoryPluginStore({ root: join(root, "plugins") });
    const viewsPlugin = (name: string, type: string) =>
      definePlugin({
        name,
        kind: "domain",
        version: "0.0.1",
        objects: [{ name: type }],
        actions: [
          {
            name: "go",
            on: type,
            when: () => true,
            run: async (ctx) => {
              await ctx.store.put(type, ctx.object.id, { ran: true }, "go");
            },
          },
        ],
        keys: { m: `${name}:go` },
      });

    const logs: string[] = [];
    const registry = new PluginRegistry(
      [viewsPlugin("one", "thing"), viewsPlugin("two", "other")],
      { store, onLog: (message) => logs.push(message) },
    );
    expect(registry.keyBindings()).toEqual([
      {
        key: "m",
        plugin: "one",
        action: "go",
        name: "one:go",
        source: "plugin",
      },
    ]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('key "m"');

    store.put("other", "1", {}, "seed");
    const views = createViews({ registry, store });
    await views.act("two:go", "other:1");
    expect(store.get("other", "1")?.data.ran).toBe(true);
  });

  test("a user's keys.json override wins", () => {
    const store = new MemoryPluginStore({ root: ".radian/tmp/keys-store" });
    const registry = new PluginRegistry([demo], {
      store,
      keys: { m: "demo:drop" },
    });
    expect(registry.keyBindings()).toEqual([
      {
        key: "m",
        plugin: "demo",
        action: "drop",
        name: "demo:drop",
        source: "user",
      },
    ]);
  });

  test("a plugin may declare only views and no commands", () => {
    expect("commands" in demo).toBe(false);
    const store = new MemoryPluginStore({ root: ".radian/tmp/views-store" });
    const registry = new PluginRegistry([demo], { store });
    expect(registry.names()).toEqual(["demo"]);
  });

  test("a row that throws is an error row", async () => {
    const { store, registry, log } = await fixture();
    const broken = definePlugin({
      ...demo,
      name: "broken",
      objects: [{ name: "broken" }],
      actions: [],
      keys: {},
      views: {
        broken: {
          row() {
            throw new Error("nope");
          },
          sections: () => [],
          load: () => ({ markdown: "" }),
        },
      },
    });
    const brokenRegistry = new PluginRegistry([broken], { store });
    store.put("broken", "1", {}, "seed");
    const views = createViews({ registry: brokenRegistry, store, log });
    const rows = await views.list("broken");
    expect(rows[0]?.state).toBe("error");
    expect(rows[0]?.note).toContain("nope");
    expect(registry.viewsFor("broken")).toBeUndefined();
    await log.close();
  });

  test("an ambiguous bare id asks for the typed form", async () => {
    const { store, registry, log } = await fixture();
    const second = definePlugin({
      name: "other",
      kind: "domain",
      version: "0.0.1",
      objects: [{ name: "note" }],
      views: {
        note: {
          row: (object) => ({ id: object.id, title: "", state: "new" }),
          sections: () => [],
          load: () => ({ markdown: "" }),
        },
      },
    });
    const both = new PluginRegistry([demo, second], { store });
    store.put("note", "one", {}, "seed");
    const views = createViews({ registry: both, store, log });
    await expect(views.get("one")).rejects.toMatchObject({
      kind: "ambiguous",
    });
    expect(registry.names()).toEqual(["demo"]);
    await log.close();
  });
});
