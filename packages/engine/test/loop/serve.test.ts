import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  answerRun,
  historyEntries,
  listPending,
  loadPluginRegistry,
  openConfigLog,
  readConfig,
  readState,
  serve,
  serveOnce,
  sleepUntilAborted,
  storeRootOf,
} from "../../src/index.ts";
import plugin from "../fixtures/plugins/runner.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const pluginPath = fileURLToPath(
  new URL("../fixtures/plugins/runner.ts", import.meta.url),
);
const childPath = fileURLToPath(
  new URL("../fixtures/run-child.ts", import.meta.url),
);

interface Home {
  readonly root: string;
  readonly home: string;
  readonly storeRoot: string;
  readonly config: Awaited<ReturnType<typeof readConfig>>;
}

async function makeHome(): Promise<Home> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  await Bun.write(
    join(home, "config.json"),
    JSON.stringify({
      plugins: [pluginPath],
      store: { backend: "jsonl", path: join(root, "store") },
    }),
  );
  const config = await readConfig(home);
  return { root, home, storeRoot: storeRootOf(config), config };
}

async function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return;
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(dirname(path), () => {
      if (!existsSync(path)) return;
      watcher.close();
      resolve();
    });
    watcher.on("error", (error) => {
      watcher.close();
      reject(error);
    });
    if (existsSync(path)) {
      watcher.close();
      resolve();
    }
  });
}

function spawn(home: Home, runId: string, recover: boolean) {
  return Bun.spawn({
    cmd: [
      process.execPath,
      childPath,
      home.home,
      runId,
      ...(recover ? ["--recover"] : []),
    ],
    cwd: home.home,
    env: { ...process.env, OPERAD_HOME: home.home },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

describe("serve loop", () => {
  test("recovers an unsafe run into a person wait, and an action ends it", async () => {
    const home = await makeHome();
    const log = openConfigLog(home.config);
    const registry = await loadPluginRegistry({
      home: home.home,
      store: new MemoryPluginStore({ root: home.storeRoot }),
    });
    try {
      const info = await log.startRun("crash", "job:1");
      const first = spawn(home, info.runId, false);
      await waitForFile(join(home.home, "blocked"));
      first.kill("SIGKILL");
      await first.exited;
      rmSync(join(home.home, "blocked"), { force: true });

      let recovered: ReturnType<typeof spawn> | undefined;
      await serveOnce({
        log,
        registry,
        lockRoot: home.storeRoot,
        spawnRun: (runId, options) => {
          recovered = spawn(home, runId, options.recover);
        },
      });
      expect(recovered).toBeDefined();
      await recovered?.exited;

      const state = await readState(log, info.runId);
      expect(state.status).toBe("waiting_person");
      expect(state.wait?.prompt).toContain("interrupted");

      const pending = await listPending(log, registry);
      expect(pending.map((item) => item.runId)).toEqual([info.runId]);
      expect(pending[0]?.choices).toEqual(["finish", "stop"]);

      const withAnswer = new PluginRegistry([plugin], {
        home: home.home,
        storeRoot: home.storeRoot,
        onAnswer: async (runId, choice) => {
          const found = registry.flow("crash");
          if (found === undefined) throw new Error("flow missing");
          await answerRun({ log, flow: found.flow, runId, choice, actor: { via: "test", id: "tester" } });
        },
      });
      await withAnswer.runAction("approve", {}, {
        object: { type: "job", id: "1", data: {} },
        runId: info.runId,
        actor: { via: "test", id: "tester" },
      });
      expect((await readState(log, info.runId)).endedStatus).toBe("done");

      const entries = [];
      for await (const entry of historyEntries(log.read(info.runId))) {
        entries.push(entry);
      }
      const text = entries.map((entry) => `${entry.what} ${entry.why}`).join("\n");
      expect(text).toContain("cannot be replayed safely");
      expect(text).toContain("run done");
      for (const word of ["fact", "effect", "node", "graph", "decide"]) {
        expect(text.toLowerCase()).not.toContain(word);
      }
    } finally {
      await log.close();
    }
  });

  test("starts a run a plugin asks for on tick", async () => {
    const home = await makeHome();
    const log = openConfigLog(home.config);
    const registry = await loadPluginRegistry({
      home: home.home,
      store: new MemoryPluginStore({ root: home.storeRoot }),
    });
    try {
      writeFileSync(join(home.home, "tick-start"), "go");
      const spawned: string[] = [];
      await serveOnce({
        log,
        registry,
        lockRoot: home.storeRoot,
        spawnRun: (runId) => {
          spawned.push(runId);
        },
      });
      const active = await log.runs({ active: true });
      expect(active.map((run) => run.flow)).toEqual(["ask"]);
      expect(spawned).toEqual(active.map((run) => run.runId));
    } finally {
      await log.close();
    }
  });

  test("does not wake a wait before it is due", async () => {
    const home = await makeHome();
    const log = openConfigLog(home.config);
    const registry = await loadPluginRegistry({
      home: home.home,
      store: new MemoryPluginStore({ root: home.storeRoot }),
    });
    try {
      const info = await log.startRun("pause", "job:4");
      const found = registry.flow("pause");
      if (found === undefined) throw new Error("missing pause flow");
      await new Runner({
        log,
        flow: found.flow,
        runId: info.runId,
        registry,
        lockRoot: home.storeRoot,
        clock: () => 1_000,
      }).run();

      const early: string[] = [];
      await serveOnce({
        log,
        registry,
        lockRoot: home.storeRoot,
        clock: () => 1_000,
        spawnRun: (runId) => {
          early.push(runId);
        },
      });
      expect(early).toEqual([]);

      const due: string[] = [];
      await serveOnce({
        log,
        registry,
        lockRoot: home.storeRoot,
        clock: () => 7_000,
        spawnRun: (runId) => {
          due.push(runId);
        },
      });
      expect(due).toEqual([info.runId]);
    } finally {
      await log.close();
    }
  });

  test("an interrupted loop leaves a mid-step child running", async () => {
    const home = await makeHome();
    const log = openConfigLog(home.config);
    const registry = await loadPluginRegistry({
      home: home.home,
      store: new MemoryPluginStore({ root: home.storeRoot }),
    });
    try {
      const info = await log.startRun("retry", "job:3");
      let child: ReturnType<typeof spawn> | undefined;
      const controller = new AbortController();
      const loop = serve({
        home: home.home,
        log,
        registry,
        lockRoot: home.storeRoot,
        intervalMs: 20,
        signal: controller.signal,
        spawnRun: (runId, options) => {
          child = spawn(home, runId, options.recover);
        },
      });
      await waitForFile(join(home.home, "blocked"));
      controller.abort();
      await loop;

      expect(child?.exitCode).toBeNull();
      writeFileSync(join(home.home, "release"), "go");
      await child?.exited;
      expect((await readState(log, info.runId)).endedStatus).toBe("done");
    } finally {
      await log.close();
    }
  });

  test("re-runs a safe step after the run process is killed", async () => {
    const home = await makeHome();
    const log = openConfigLog(home.config);
    const registry = await loadPluginRegistry({
      home: home.home,
      store: new MemoryPluginStore({ root: home.storeRoot }),
    });
    try {
      const info = await log.startRun("retry", "job:2");
      const first = spawn(home, info.runId, false);
      await waitForFile(join(home.home, "blocked"));
      first.kill("SIGKILL");
      await first.exited;
      rmSync(join(home.home, "blocked"), { force: true });

      let recovered: ReturnType<typeof spawn> | undefined;
      await serveOnce({
        log,
        registry,
        lockRoot: home.storeRoot,
        spawnRun: (runId, options) => {
          recovered = spawn(home, runId, options.recover);
        },
      });
      expect(recovered).toBeDefined();
      await waitForFile(join(home.home, "blocked"));
      writeFileSync(join(home.home, "release"), "go");
      await recovered?.exited;

      const state = await readState(log, info.runId);
      expect(state.status).toBe("ended");
      expect(state.endedStatus).toBe("done");

      const words = [];
      for await (const entry of historyEntries(log.read(info.runId))) {
        words.push(entry.what);
      }
      expect(words).toContain("re-running work after a crash");
    } finally {
      await log.close();
    }
  });

  test("a sleeping loop ends as soon as the signal aborts", async () => {
    const home = await makeHome();
    const log = openConfigLog(home.config);
    const registry = await loadPluginRegistry({
      home: home.home,
      store: new MemoryPluginStore({ root: home.storeRoot }),
    });
    try {
      const controller = new AbortController();
      const entered = Promise.withResolvers<void>();
      const loop = serve({
        home: home.home,
        log,
        registry,
        lockRoot: home.storeRoot,
        intervalMs: 600_000,
        signal: controller.signal,
        spawnRun: () => undefined,
        sleep: async (ms, signal) => {
          entered.resolve();
          await sleepUntilAborted(ms, signal);
        },
      });
      await entered.promise;
      controller.abort();
      await loop;
    } finally {
      await log.close();
    }
  });
});
