import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FilePluginStore,
  MemoryPluginStore,
  Runner,
  historyEntries,
  loadPluginRegistry,
  openConfigLog,
  openLog,
  openPluginStore,
  readConfig,
  readState,
  storeRootOf,
  PluginRegistry,
  type Fact,
  type FlowDefinition,
  type LogBackend,
} from "../../src/index.ts";
import plugin from "../fixtures/plugins/runner.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const pluginPath = fileURLToPath(
  new URL("../fixtures/plugins/runner.ts", import.meta.url),
);
const crashChildPath = fileURLToPath(
  new URL("../fixtures/crash-child.ts", import.meta.url),
);

interface Setup {
  readonly root: string;
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  readonly flow: FlowDefinition;
  readonly runId: string;
  close(): Promise<void>;
}

async function setup(flowName: string): Promise<Setup> {
  const root = await tempRoot();
  const storeRoot = join(root, "store");
  const log = openLog({ backend: "jsonl", path: storeRoot });
  const registry = new PluginRegistry([plugin], {
    home: root,
    storeRoot,
    store: new MemoryPluginStore({ root: storeRoot }),
  });
  const found = registry.flow(flowName);
  if (found === undefined) throw new Error(`missing flow ${flowName}`);
  const info = await log.startRun(flowName, "job:1");
  return {
    root,
    log,
    registry,
    flow: found.flow,
    runId: info.runId,
    close: async () => {
      await log.close();
    },
  };
}

async function facts(log: LogBackend, runId: string): Promise<Fact[]> {
  const list: Fact[] = [];
  for await (const fact of log.read(runId)) list.push(fact);
  return list;
}

interface FileSetup {
  readonly root: string;
  readonly home: string;
  readonly storeRoot: string;
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  readonly flow: FlowDefinition;
  readonly runId: string;
  close(): Promise<void>;
}

/** A registry loaded from a config file, so steps can run in a worker. */
async function fileSetup(
  flowName: string,
  backend: "jsonl" | "sqlite" = "jsonl",
): Promise<FileSetup> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const storeRoot = join(root, "store");
  await Bun.write(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [pluginPath],
      store: {
        backend,
        path: backend === "sqlite" ? join(storeRoot, "log.sqlite") : storeRoot,
      },
    }),
  );
  const config = await readConfig(home);
  const log = openConfigLog(config);
  const registry = await loadPluginRegistry({
    home,
    cwd: home,
    store: openPluginStore({ backend, root: storeRoot }),
  });
  const found = registry.flow(flowName);
  if (found === undefined) throw new Error(`missing flow ${flowName}`);
  const info = await log.startRun(flowName, "job:1");
  return {
    root,
    home,
    storeRoot,
    log,
    registry,
    flow: found.flow,
    runId: info.runId,
    close: async () => {
      await log.close();
    },
  };
}

describe("runner", () => {
  test("drives a run to the end, one batch per input", async () => {
    const run = await setup("simple");
    try {
      const runner = new Runner({
        log: run.log,
        flow: run.flow,
        runId: run.runId,
        registry: run.registry,
        lockRoot: join(run.root, "store"),
        object: { type: "job", id: "1" },
      });
      expect(await runner.run()).toBe("ended");
      const state = await readState(run.log, run.runId);
      expect(state.status).toBe("ended");
      expect(state.endedStatus).toBe("done");

      const recorded = await facts(run.log, run.runId);
      expect(recorded.map((fact) => fact.kind)).toEqual([
        "run_started",
        "step_entered",
        "effect_requested",
        "step_started",
        "step_result",
        "edge_taken",
        "step_entered",
        "run_ended",
      ]);
      // Every batch carries at most one step's entry, so each input is one
      // append; the step-start fact is its own append before the result.
      expect(new Set(recorded.map((fact) => fact.seq)).size).toBe(recorded.length);
      expect((await run.log.runs({ active: true })).length).toBe(0);
    } finally {
      await run.close();
    }
  });

  test("a step that never ends becomes a failed result", async () => {
    const run = await setup("timed");
    try {
      const runner = new Runner({
        log: run.log,
        flow: run.flow,
        runId: run.runId,
        registry: run.registry,
        lockRoot: join(run.root, "store"),
        stepTimeoutMs: 20,
      });
      expect(await runner.run()).toBe("ended");
      const state = await readState(run.log, run.runId);
      expect(state.status).toBe("ended");
      expect(state.results[Object.keys(state.results)[0] ?? ""]?.result).toBe(
        "failed",
      );
      const entries = [];
      for await (const entry of historyEntries(run.log.read(run.runId))) {
        entries.push(entry);
      }
      const slow = entries.find((entry) => entry.step === "slow" && entry.what === "slow failed");
      expect(slow?.why).toContain("longer than 20 ms");
    } finally {
      await run.close();
    }
  });

  test("a step's own timeoutSecs replaces the runner's step timeout", async () => {
    const run = await setup("patient");
    try {
      const runner = new Runner({
        log: run.log,
        flow: run.flow,
        runId: run.runId,
        registry: run.registry,
        lockRoot: join(run.root, "store"),
        stepTimeoutMs: 20,
      });
      expect(await runner.run()).toBe("ended");
      const state = await readState(run.log, run.runId);
      expect(state.results[Object.keys(state.results)[0] ?? ""]?.result).toBe(
        "ok",
      );
    } finally {
      await run.close();
    }
  });

  test("a noisy step writes megabytes to its log and history keeps the path", async () => {
    const run = await setup("noisy");
    try {
      const runner = new Runner({
        log: run.log,
        flow: run.flow,
        runId: run.runId,
        registry: run.registry,
        lockRoot: join(run.root, "store"),
      });
      expect(await runner.run()).toBe("ended");
      const entries = [];
      for await (const entry of historyEntries(run.log.read(run.runId))) {
        entries.push(entry);
      }
      const work = entries.find((entry) => entry.what === "work ok");
      expect(work?.why).toContain("log at");
      const path = work?.why.slice(work.why.indexOf("log at ") + "log at ".length);
      expect(path).toBeDefined();
      if (path !== undefined) {
        expect(statSync(path).size).toBeGreaterThanOrEqual(2 * 1024 * 1024);
        expect(readFileSync(path, "utf8").startsWith("x")).toBe(true);
      }
    } finally {
      await run.close();
    }
  });

  test("polls a check with an injected clock until it is ready", async () => {
    const run = await setup("polled");
    try {
      const runner = new Runner({
        log: run.log,
        flow: run.flow,
        runId: run.runId,
        registry: run.registry,
        lockRoot: join(run.root, "store"),
      });
      expect(await runner.run()).toBe("blocked");
      expect((await readState(run.log, run.runId)).status).toBe("waiting");

      writeFileSync(join(run.root, "ready"), "yes");
      expect(await runner.run()).toBe("ended");
      expect((await readState(run.log, run.runId)).endedStatus).toBe("done");
    } finally {
      await run.close();
    }
  });

  test("waits for a time and wakes through the injected clock", async () => {
    const run = await setup("pause");
    try {
      let now = 1_000;
      const runner = new Runner({
        log: run.log,
        flow: run.flow,
        runId: run.runId,
        registry: run.registry,
        lockRoot: join(run.root, "store"),
        clock: () => now,
      });
      expect(await runner.run()).toBe("blocked");
      now += 4_999;
      expect(await runner.run()).toBe("blocked");
      now += 1;
      expect(await runner.run()).toBe("ended");
      expect((await readState(run.log, run.runId)).endedStatus).toBe("done");
    } finally {
      await run.close();
    }
  });

  test("recovers an unsafe step into an interrupted wait", async () => {
    const run = await setup("crash");
    try {
      writeFileSync(join(run.root, "release"), "go");
      const first = new Runner({
        log: run.log,
        flow: run.flow,
        runId: run.runId,
        registry: run.registry,
        lockRoot: join(run.root, "store"),
      });
      expect(await first.run()).toBe("ended");

      // A fresh run that is left mid-step is what a crash looks like.
      const second = await run.log.startRun("crash", "job:2");
      await run.log.append(second.runId, 0, [
        { kind: "run_started", payload: { flow: "crash" }, cause: "test" },
        {
          kind: "step_entered",
          payload: { step: "work", visit: 1, kind: "plugin" },
          cause: 1,
        },
        {
          kind: "effect_requested",
          payload: {
            effectId: "work:1",
            effect: "run_plugin_step",
            step: "work",
            replay: "unsafe",
            recovery: false,
            use: "test/block",
            params: {},
            check: null,
            due: null,
          },
          cause: 2,
        },
      ]);

      const recovering = new Runner({
        log: run.log,
        flow: run.flow,
        runId: second.runId,
        registry: run.registry,
        lockRoot: join(run.root, "store"),
        recover: true,
      });
      expect(await recovering.run()).toBe("waiting");
      const state = await readState(run.log, second.runId);
      expect(state.status).toBe("waiting_person");
      expect(state.wait?.prompt).toContain("interrupted");
    } finally {
      await run.close();
    }
  });

  test("the run lock keeps one runner per run and clears a stale pid", async () => {
    const run = await setup("simple");
    const lockRoot = join(run.root, "store");
    const lockDir = join(lockRoot, "locks", "runs");
    mkdirSync(lockDir, { recursive: true });
    try {
      const lock = new Runner({
        log: run.log,
        flow: run.flow,
        runId: run.runId,
        registry: run.registry,
        lockRoot,
      });
      expect(existsSync(join(lockDir, `${run.runId}.lock`))).toBe(
        false,
      );
      // A live PID that is not ours holds the lock.
      writeFileSync(
        join(lockDir, `${run.runId}.lock`),
        JSON.stringify({ pid: process.pid, at: 0 }),
      );
      await expect(lock.run()).rejects.toThrow(/lock/);

      // A dead PID is stale and is replaced.
      writeFileSync(
        join(lockDir, `${run.runId}.lock`),
        JSON.stringify({ pid: 999_999, at: 0 }),
      );
      expect(await lock.run()).toBe("ended");
    } finally {
      await run.close();
    }
  });

  test("a synchronous step is stopped by the wall time", async () => {
    const run = await fileSetup("hang");
    try {
      const runner = new Runner({
        log: run.log,
        flow: run.flow,
        runId: run.runId,
        registry: run.registry,
        lockRoot: run.storeRoot,
        stepTimeoutMs: 500,
      });
      expect(await runner.run()).toBe("ended");

      const state = await readState(run.log, run.runId);
      expect(state.status).toBe("ended");
      const result = Object.values(state.results)[0];
      expect(result?.result).toBe("failed");

      const entries = [];
      for await (const entry of historyEntries(run.log.read(run.runId))) {
        entries.push(entry);
      }
      const work = entries.find(
        (entry) => entry.step === "work" && entry.what === "work failed",
      );
      expect(work?.why).toContain("longer than 500 ms");
    } finally {
      await run.close();
    }
  });

  test("a worker step writes to the configured sqlite store", async () => {
    const run = await fileSetup("write", "sqlite");
    try {
      const runner = new Runner({
        log: run.log,
        flow: run.flow,
        runId: run.runId,
        registry: run.registry,
        lockRoot: run.storeRoot,
      });
      expect(await runner.run()).toBe("ended");

      const configured = openPluginStore({ backend: "sqlite", root: run.storeRoot });
      expect((await configured.get("job", "1"))?.data.wrote).toBe(true);
      expect(existsSync(join(run.storeRoot, "plugins.sqlite"))).toBe(true);
      expect(existsSync(join(run.storeRoot, "plugins", "facts.jsonl"))).toBe(false);
    } finally {
      await run.close();
    }
  });

  test("a step that throws is not recorded as its success result", async () => {
    const run = await setup("throwing");
    try {
      const runner = new Runner({
        log: run.log,
        flow: run.flow,
        runId: run.runId,
        registry: run.registry,
        lockRoot: join(run.root, "store"),
      });
      expect(await runner.run()).toBe("ended");

      const state = await readState(run.log, run.runId);
      expect(state.endedStatus).toBe("failed");
      expect(Object.values(state.results).map((value) => value.result)).not.toContain(
        "ok",
      );
    } finally {
      await run.close();
    }
  });

  test("a check that throws is not recorded as ready", async () => {
    const run = await setup("broken-check");
    try {
      const runner = new Runner({
        log: run.log,
        flow: run.flow,
        runId: run.runId,
        registry: run.registry,
        lockRoot: join(run.root, "store"),
      });
      expect(await runner.run()).toBe("ended");

      const state = await readState(run.log, run.runId);
      expect(state.endedStatus).toBe("failed");
      expect(Object.values(state.results).map((value) => value.result)).not.toContain(
        "ready",
      );
      const entries = [];
      for await (const entry of historyEntries(run.log.read(run.runId))) {
        entries.push(entry);
      }
      expect(entries.some((entry) => entry.what === "check interrupted")).toBe(true);
    } finally {
      await run.close();
    }
  });

  test("an input recorded before a crash is applied on recovery", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const storeRoot = join(root, "store");
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({
        plugins: [pluginPath],
        store: { backend: "jsonl", path: storeRoot },
      }),
    );
    const config = await readConfig(home);
    const opened = openConfigLog(config);
    const info = await opened.startRun("simple", "job:1");
    await opened.close();

    const child = Bun.spawn({
      cmd: [process.execPath, crashChildPath, home, info.runId],
      cwd: home,
      env: { ...process.env, OPERAD_HOME: home },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await child.exited;

    const log = openConfigLog(config);
    try {
      // The input's record survived, its facts did not.
      expect((await readState(log, info.runId)).status).toBe("idle");

      const registry = await loadPluginRegistry({
        home,
        cwd: home,
        store: new FilePluginStore({ root: join(storeRoot, "plugins") }),
      });
      const found = registry.flow("simple");
      if (found === undefined) throw new Error("missing simple flow");
      const outcome = await new Runner({
        log,
        flow: found.flow,
        runId: info.runId,
        registry,
        lockRoot: storeRoot,
        recover: true,
      }).run();
      expect(outcome).toBe("ended");
      expect((await readState(log, info.runId)).endedStatus).toBe("done");
    } finally {
      await log.close();
    }
  });
});
