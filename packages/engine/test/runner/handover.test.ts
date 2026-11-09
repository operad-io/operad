import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  defineFlow,
  historyEntries,
  openLog,
  readState,
  type Fact,
  type LogBackend,
} from "../../src/index.ts";
import plugin from "../fixtures/plugins/runner.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const twice = defineFlow({
  name: "twice",
  entry: "first",
  steps: [
    {
      id: "first",
      kind: "plugin",
      params: { use: "test/echo", params: { text: "one" } },
      replay: "safe",
      next: { ok: "second", failed: "failed" },
    },
    {
      id: "second",
      kind: "plugin",
      params: { use: "test/echo", params: { text: "two" } },
      replay: "safe",
      next: { ok: "done", failed: "failed" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
    { id: "failed", kind: "end", params: { status: "failed" }, replay: "safe" },
  ],
});

async function facts(log: LogBackend, runId: string): Promise<Fact[]> {
  const list: Fact[] = [];
  for await (const fact of log.read(runId)) list.push(fact);
  return list;
}

async function setup() {
  const root = await tempRoot();
  const storeRoot = join(root, "store");
  const log = openLog({ backend: "jsonl", path: storeRoot });
  const registry = new PluginRegistry([plugin], {
    home: root,
    storeRoot,
    store: new MemoryPluginStore({ root: storeRoot }),
  });
  const info = await log.startRun("twice", "job:1");
  const runner = (handover?: () => Promise<string | undefined>): Runner =>
    new Runner({
      log,
      flow: twice,
      runId: info.runId,
      registry,
      lockRoot: storeRoot,
      object: { type: "job", id: "1" },
      handover,
    });
  return { log, runId: info.runId, runner };
}

describe("a run's process between steps", () => {
  test("hands over after a step, says so in history, and a fresh process finishes without repeating it", async () => {
    const run = await setup();
    try {
      const asked: string[] = [];
      const outcome = await run
        .runner(async () => {
          const list = await facts(run.log, run.runId);
          asked.push(list[list.length - 1]?.kind ?? "");
          return "plugin x: a.ts";
        })
        .run();
      expect(outcome).toBe("handover");
      // Asked once, after the first step's result and never while it ran.
      expect(asked).toHaveLength(1);
      expect(asked[0]).not.toBe("step_started");
      expect((await readState(run.log, run.runId)).status).toBe("running");
      expect((await run.log.runs({ active: true })).length).toBe(1);

      const lines: string[] = [];
      for await (const entry of historyEntries(run.log.read(run.runId))) {
        lines.push(`${entry.what}: ${entry.why}`);
      }
      expect(lines.filter((line) => line.startsWith("continuing on updated code"))).toEqual([
        "continuing on updated code: plugin x: a.ts",
      ]);

      expect(await run.runner().run()).toBe("ended");
      const kinds = (await facts(run.log, run.runId)).map((fact) => fact.kind);
      expect(kinds.filter((kind) => kind === "step_started")).toHaveLength(2);
      expect(kinds.filter((kind) => kind === "process_replaced")).toHaveLength(1);
    } finally {
      await run.log.close();
    }
  });

  test("goes on when nothing asks for a hand-over", async () => {
    const run = await setup();
    try {
      let asks = 0;
      const outcome = await run
        .runner(async () => {
          asks += 1;
          return undefined;
        })
        .run();
      expect(outcome).toBe("ended");
      expect(asks).toBe(1);
      const kinds = (await facts(run.log, run.runId)).map((fact) => fact.kind);
      expect(kinds).not.toContain("process_replaced");
    } finally {
      await run.log.close();
    }
  });
});
