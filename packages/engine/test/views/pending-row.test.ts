import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  createViews,
  definePlugin,
  listPending,
  openLog,
  type LogBackend,
  type TriggerCandidate,
  type Views,
} from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const opened: Views[] = [];
afterEach(() => {
  for (const views of opened.splice(0)) views.close();
});

const calls = { rows: 0 };

const plugin = definePlugin({
  name: "rows",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "item", index: ["state"] }],
  views: {
    item: {
      row(object) {
        calls.rows += 1;
        if (object.data.mode === "throws") throw new Error("the row is broken");
        return {
          id: object.id,
          title: String(object.data.title ?? ""),
          state: String(object.data.state ?? "new"),
          ...(typeof object.data.note === "string" ? { note: object.data.note } : {}),
        };
      },
      sections() {
        return [];
      },
      load() {
        return { markdown: "" };
      },
    },
  },
});

interface Env {
  readonly store: MemoryPluginStore;
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  readonly views: Views;
  readonly logs: string[];
}

async function env(): Promise<Env> {
  const root = await tempRoot();
  const store = new MemoryPluginStore({ root: join(root, "plugins") });
  const logs: string[] = [];
  const registry = new PluginRegistry([plugin], {
    store,
    onLog: (message) => logs.push(message),
  });
  const log = openLog({ backend: "sqlite", path: join(root, "store", "log.sqlite") });
  const views = createViews({ registry, store, log });
  opened.push(views);
  calls.rows = 0;
  return { store, log, registry, views, logs };
}

async function waitOn(log: LogBackend, object: string): Promise<void> {
  const run = await log.startRun("demo-flow", object);
  await log.append(run.runId, 0, [
    {
      kind: "waiting_for_person",
      payload: {
        waitId: "wait:1",
        step: "ask",
        prompt: "Approve?",
        choices: ["yes"],
        waitKind: "step",
        effectId: null,
      },
      cause: "test",
    },
  ]);
}

describe("pending items carry their object's row", () => {
  test("the row is the one the list shows, with the run flags", async () => {
    const e = await env();
    e.store.put("item", "one", { title: "First", state: "open", note: "n" }, "seed");
    await waitOn(e.log, "item:one");

    const items = await listPending(e.log, e.registry, undefined, e.views);
    const list = await e.views.list("item");

    expect(items).toHaveLength(1);
    expect(items[0]?.row).toEqual(list.rows[0]);
    expect(items[0]?.row).toMatchObject({
      id: "one",
      title: "First",
      state: "open",
      note: "n",
      waiting: true,
    });
  });

  test("without views the item has no row", async () => {
    const e = await env();
    e.store.put("item", "one", { title: "First" }, "seed");
    await waitOn(e.log, "item:one");

    const items = await listPending(e.log, e.registry);
    expect(items[0]).not.toHaveProperty("row");
  });

  test("a candidate has no row", async () => {
    const e = await env();
    e.store.put("item", "one", { title: "First" }, "seed");
    const candidate: TriggerCandidate = {
      pendingId: "pending:1",
      inputId: "input:1",
      flow: "demo-flow",
      object: "item:one",
      event: { source: "test", key: "k", type: "t", hops: 0 },
      status: "pending",
      at: 0,
    };

    const items = await listPending(
      e.log,
      e.registry,
      { candidates: () => [candidate] },
      e.views,
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("candidate");
    expect(items[0]).not.toHaveProperty("row");
    expect(calls.rows).toBe(0);
  });

  test("an object deleted after the run started gets an error row, and the rest are listed", async () => {
    const e = await env();
    e.store.put("item", "one", { title: "First" }, "seed");
    await waitOn(e.log, "item:gone");
    await waitOn(e.log, "item:one");

    const items = await listPending(e.log, e.registry, undefined, e.views);

    expect(items).toHaveLength(2);
    const gone = items.find((item) => item.object === "item:gone");
    expect(gone?.row).toMatchObject({
      id: "gone",
      state: "error",
      error: 'no object "item:gone"',
      waiting: false,
    });
    expect(items.find((item) => item.object === "item:one")?.row).toMatchObject({
      title: "First",
      waiting: true,
    });
  });

  test("a plugin whose row throws gives the list's error row, not a failed list", async () => {
    const e = await env();
    e.store.put("item", "bad", { mode: "throws" }, "seed");
    e.store.put("item", "ok", { title: "Fine" }, "seed");
    await waitOn(e.log, "item:bad");
    await waitOn(e.log, "item:ok");

    const items = await listPending(e.log, e.registry, undefined, e.views);
    const list = await e.views.list("item");

    const bad = items.find((item) => item.object === "item:bad");
    expect(bad?.row).toMatchObject({ state: "error", error: "the row is broken" });
    expect(bad?.row).toEqual(list.rows.find((row) => row.id === "bad"));
    expect(items.find((item) => item.object === "item:ok")?.row?.title).toBe("Fine");
  });

  test("many items build one row each", async () => {
    const e = await env();
    for (let index = 0; index < 25; index += 1) {
      e.store.put("item", `n${index}`, { title: `Item ${index}` }, "seed");
      await waitOn(e.log, `item:n${index}`);
    }
    calls.rows = 0;

    const items = await listPending(e.log, e.registry, undefined, e.views);

    expect(items).toHaveLength(25);
    expect(calls.rows).toBe(25);
    expect(items.every((item) => item.row !== undefined)).toBe(true);
  });
});
