import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  MemoryPluginStore,
  openLog,
  PluginRegistry,
  Runner,
  type FlowDefinition,
  type LogBackend,
} from "../../src/index.ts";
import { cleanupTempRoots, def, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const plainFlow: FlowDefinition = {
  name: "plain",
  entry: "work",
  steps: [
    {
      id: "work",
      kind: "plugin",
      params: { use: "p/plain", params: {} },
      replay: "safe",
      next: { ok: "end" },
    },
  ],
};

const guardedFlow: FlowDefinition = {
  name: "guarded",
  entry: "guard",
  steps: [
    {
      id: "guard",
      kind: "plugin",
      params: { use: "p/guarded", params: {} },
      replay: "safe",
      next: { ok: "again" },
    },
    {
      id: "again",
      kind: "plugin",
      params: { use: "p/plain", params: {} },
      replay: "safe",
      next: { ok: "end" },
    },
  ],
};

function plugin() {
  const seen: unknown[] = [];
  const definition = def({
    name: "p",
    flows: [plainFlow, guardedFlow],
    steps: [
      {
        name: "plain",
        results: ["ok"],
        run(ctx) {
          seen.push(ctx.access);
          return { result: "ok" };
        },
      },
      {
        name: "guarded",
        results: ["ok"],
        enforces: ["network", "cwd"],
        run(ctx) {
          seen.push(ctx.access);
          return { result: "ok" };
        },
      },
    ],
  });
  return { definition, seen };
}

async function setup(): Promise<{
  readonly root: string;
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  readonly seen: unknown[];
  close(): Promise<void>;
}> {
  const root = await tempRoot();
  const storeRoot = join(root, "store");
  const log = openLog({ backend: "jsonl", path: storeRoot });
  const { definition, seen } = plugin();
  const registry = new PluginRegistry([definition], {
    home: root,
    storeRoot,
    store: new MemoryPluginStore({ root: storeRoot }),
    onLog: () => undefined,
  });
  return {
    root,
    log,
    registry,
    seen,
    close: async () => {
      await log.close();
    },
  };
}

describe("run access profile", () => {
  test("refuses a field no step of the flow enforces, naming the field and step", async () => {
    const run = await setup();
    try {
      const flow = run.registry.flow("plain")?.flow;
      if (flow === undefined) throw new Error("missing flow");
      const info = await run.log.startRun("plain", "job:1", null, { network: "all" });
      const runner = new Runner({
        log: run.log,
        flow,
        runId: info.runId,
        registry: run.registry,
        access: { network: "all" },
      });
      let message = "";
      try {
        await runner.run();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("access.network");
      expect(message).toContain("work");
      expect(message).toContain("p/plain");
    } finally {
      await run.close();
    }
  });

  test("accepts a field one step of the flow enforces and gives it to every step", async () => {
    const run = await setup();
    try {
      const flow = run.registry.flow("guarded")?.flow;
      if (flow === undefined) throw new Error("missing flow");
      const access = { network: "all", cwd: "/tmp/work" };
      const info = await run.log.startRun("guarded", "job:1", null, access);
      await new Runner({
        log: run.log,
        flow,
        runId: info.runId,
        registry: run.registry,
        access,
      }).run();
      expect(run.seen).toEqual([access, access]);
    } finally {
      await run.close();
    }
  });

  test("a runner without the option sees the profile recorded at the run start", async () => {
    const run = await setup();
    try {
      const flow = run.registry.flow("guarded")?.flow;
      if (flow === undefined) throw new Error("missing flow");
      const access = { network: "all" };
      const info = await run.log.startRun("guarded", "job:1", null, access);
      await new Runner({
        log: run.log,
        flow,
        runId: info.runId,
        registry: run.registry,
      }).run();
      expect(run.seen[0]).toEqual(access);
    } finally {
      await run.close();
    }
  });

  test("refuses a null profile, which is not an access object", async () => {
    const run = await setup();
    try {
      const flow = run.registry.flow("guarded")?.flow;
      if (flow === undefined) throw new Error("missing flow");
      const info = await run.log.startRun("guarded", "job:1");
      let message = "";
      try {
        await new Runner({
          log: run.log,
          flow,
          runId: info.runId,
          registry: run.registry,
          access: null,
        }).run();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("access: must be an object");
    } finally {
      await run.close();
    }
  });
});
