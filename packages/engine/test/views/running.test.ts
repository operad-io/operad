import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  createViews,
  definePlugin,
  listRunning,
  openLog,
  type LogBackend,
  type Views,
} from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const opened: Views[] = [];
afterEach(() => {
  for (const views of opened.splice(0)) views.close();
});

const counts = { rows: 0 };

const plugin = definePlugin({
  name: "rows",
  kind: "domain",
  version: "0.0.1",
  objects: [{ name: "item", index: ["state"] }],
  views: {
    item: {
      row(object) {
        counts.rows += 1;
        if (object.data.mode === "throws") throw new Error("the row is broken");
        return {
          id: object.id,
          title: String(object.data.title ?? ""),
          state: "open",
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

let now = 1_000_000;

async function env(): Promise<{
  store: MemoryPluginStore;
  log: LogBackend;
  views: Views;
}> {
  const root = await tempRoot();
  const store = new MemoryPluginStore({ root: join(root, "plugins") });
  const registry = new PluginRegistry([plugin], { store });
  const log = openLog({ backend: "jsonl", path: join(root, "store"), clock: () => now });
  const views = createViews({ registry, store, log });
  opened.push(views);
  counts.rows = 0;
  return { store, log, views };
}

let seq = new Map<string, number>();

async function add(
  log: LogBackend,
  runId: string,
  facts: { kind: string; payload: Record<string, unknown> }[],
): Promise<void> {
  const from = seq.get(runId) ?? 0;
  await log.append(
    runId,
    from,
    facts.map((fact) => ({
      kind: fact.kind,
      payload: fact.payload as never,
      cause: "test",
    })),
  );
  seq.set(runId, from + facts.length);
}

const enter = (step: string, visit = 1) => ({
  kind: "step_entered",
  payload: { step, visit, kind: "plugin" },
});
const request = (step: string, effectId: string, recovery = false) => ({
  kind: "effect_requested",
  payload: {
    effectId,
    effect: "run_plugin_step",
    step,
    replay: "safe",
    recovery,
    use: "x/y",
    params: {},
    check: null,
    due: null,
  },
});

describe("the running view names the object and times the step", () => {
  test("object, title and step time; the run age stays", async () => {
    seq = new Map();
    const e = await env();
    e.store.put("item", "one", { title: "First" }, "seed");
    now = 1_000_000;
    const run = await e.log.startRun("flow", "item:one");
    now = 1_060_000;
    await add(e.log, run.runId, [enter("work"), request("work", "work:1")]);

    const [item] = await listRunning(e.log, () => 1_100_000, e.views);
    expect(item).toMatchObject({
      runId: run.runId,
      object: "one",
      title: "First",
      stepStartedAt: 1_060_000,
      stepElapsedMs: 40_000,
      startedAt: 1_000_000,
      elapsedMs: 100_000,
    });
  });

  test("a run without an object has no object or title", async () => {
    seq = new Map();
    const e = await env();
    now = 1_000_000;
    const run = await e.log.startRun("flow", "flow:rows/flow");
    await add(e.log, run.runId, [enter("work")]);
    const [item] = await listRunning(e.log, () => 1_000_500, e.views);
    expect(item).toMatchObject({ object: null, title: null });
  });

  test("a throwing row leaves the title null", async () => {
    seq = new Map();
    const e = await env();
    e.store.put("item", "bad", { mode: "throws", title: "x" }, "seed");
    const run = await e.log.startRun("flow", "item:bad");
    await add(e.log, run.runId, [enter("work")]);
    const [item] = await listRunning(e.log, () => now, e.views);
    expect(item?.title).toBeNull();
    expect(item?.object).toBe("bad");
  });

  test("a views object that throws leaves the title null", async () => {
    seq = new Map();
    const e = await env();
    const run = await e.log.startRun("flow", "item:one");
    await add(e.log, run.runId, [enter("work")]);
    const broken = {
      rowsOf: () => Promise.reject(new Error("down")),
    } as unknown as Views;
    const [item] = await listRunning(e.log, () => now, broken);
    expect(item?.title).toBeNull();
  });

  test("step time resets on a new step and on a new attempt", async () => {
    seq = new Map();
    const e = await env();
    e.store.put("item", "one", { title: "First" }, "seed");
    now = 1_000_000;
    const run = await e.log.startRun("flow", "item:one");
    now = 1_010_000;
    await add(e.log, run.runId, [enter("a"), request("a", "a:1")]);
    expect((await listRunning(e.log, () => 1_050_000))[0]?.stepStartedAt).toBe(1_010_000);

    now = 1_030_000;
    await add(e.log, run.runId, [enter("b"), request("b", "b:1")]);
    const second = (await listRunning(e.log, () => 1_050_000))[0];
    expect(second?.stepStartedAt).toBe(1_030_000);
    expect(second?.stepElapsedMs).toBe(20_000);

    now = 1_045_000;
    await add(e.log, run.runId, [
      { kind: "step_interrupted", payload: { effectId: "b:1" } },
      request("b", "b:1", true),
    ]);
    const third = (await listRunning(e.log, () => 1_050_000))[0];
    expect(third?.stepStartedAt).toBe(1_045_000);
    expect(third?.stepElapsedMs).toBe(5_000);
    expect(third?.elapsedMs).toBe(50_000);
  });

  test("titles come from one rowsOf call, one read per object", async () => {
    seq = new Map();
    const e = await env();
    for (let at = 0; at < 10; at += 1) {
      e.store.put("item", `o${at}`, { title: `T${at}` }, "seed");
      const run = await e.log.startRun("flow", `item:o${at}`);
      await add(e.log, run.runId, [enter("work")]);
    }
    counts.rows = 0;
    const items = await listRunning(e.log, () => now, e.views);
    expect(items.map((item) => item.title).sort()).toEqual(
      Array.from({ length: 10 }, (_, at) => `T${at}`).sort(),
    );
    expect(counts.rows).toBe(10);
  });
});
