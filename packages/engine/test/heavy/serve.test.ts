import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  answerRun,
  defineFlow,
  definePlugin,
  historyEntries,
  listPending,
  parseObjectKey,
  loadPluginRegistry,
  openConfigLog,
  readConfig,
  readState,
  readStoredStart,
  readStoredTrigger,
  serve,
  serveOnce,
  sleepUntilAborted,
  storeRootOf,
} from "../../src/index.ts";
import { markerEnv } from "../../src/platform/index.ts";
import plugin from "../fixtures/plugins/runner.ts";
import triggerPlugin from "../fixtures/plugins/trigger.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const pluginPath = fileURLToPath(
  new URL("../fixtures/plugins/runner.ts", import.meta.url),
);
const childPath = fileURLToPath(
  new URL("../fixtures/run-child.ts", import.meta.url),
);
const answerChildPath = fileURLToPath(
  new URL("../fixtures/record-answer-child.ts", import.meta.url),
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
      store: { backend: "sqlite", path: join(root, "store", "log.sqlite") },
    }),
  );
  const config = await readConfig(home);
  return { root, home, storeRoot: storeRootOf(config), config };
}

/**
 * Resolves when the file exists. A directory watch wakes it at once; a watch
 * can miss an event under load, so a look every 100 ms backs it.
 */
function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve) => {
    const check = (): void => {
      if (!existsSync(path)) return;
      watcher.close();
      clearInterval(timer);
      resolve();
    };
    const watcher = watch(dirname(path), check);
    watcher.on("error", check);
    const timer = setInterval(check, 100);
    check();
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
  test("a run whose flow is not loaded fails, names it, and is not spawned", async () => {
    const home = await makeHome();
    const log = openConfigLog(home.config);
    const registry = await loadPluginRegistry({
      home: home.home,
      store: new MemoryPluginStore({ root: home.storeRoot }),
    });
    try {
      const info = await log.startRun("gone", "job:1");
      const spawned: string[] = [];
      const messages: string[] = [];
      await serveOnce({
        log,
        registry,
        lockRoot: home.storeRoot,
        storeRoot: home.storeRoot,
        home: home.home,
        spawnRun: (runId) => {
          spawned.push(runId);
        },
        onLog: (message) => messages.push(message),
      });

      const state = await readState(log, info.runId);
      expect(state.status).toBe("ended");
      expect(state.endedStatus).toBe("failed");
      const facts = [];
      for await (const fact of log.read(info.runId)) facts.push(fact);
      const ended = facts.find((fact) => fact.kind === "run_ended");
      expect((ended?.payload as { reason?: string } | undefined)?.reason).toBe(
        'flow "gone" is not loaded',
      );
      expect(spawned).toEqual([]);
      expect(messages).toContain(`run ${info.runId}: flow "gone" is not loaded`);
      expect((await log.runs({ active: true })).some((run) => run.runId === info.runId)).toBe(
        false,
      );
    } finally {
      await log.close();
    }
  });

  test("serve start stops marked processes of runs that are not active, and says so once", async () => {
    const home = await makeHome();
    const log = openConfigLog(home.config);
    const registry = await loadPluginRegistry({
      home: home.home,
      store: new MemoryPluginStore({ root: home.storeRoot }),
    });
    const idle = ["-e", "setTimeout(() => {}, 300000)"];
    const marked = (runId: string): ReturnType<typeof nodeSpawn> => {
      const child = nodeSpawn(process.execPath, idle, {
        env: {
          ...process.env,
          ...markerEnv({ runId, step: "test/step", home: home.home }),
        },
        stdio: "ignore",
      });
      return child;
    };
    const active = await log.startRun("retry", "job:7");
    const stale = marked("run-gone");
    const kept = marked(active.runId);
    try {
      const messages: string[] = [];
      const controller = new AbortController();
      controller.abort();
      await serve({
        home: home.home,
        log,
        registry,
        lockRoot: home.storeRoot,
        signal: controller.signal,
        spawnRun: () => undefined,
        onLog: (message) => messages.push(message),
      });
      await new Promise<void>((resolve) => {
        if (stale.exitCode !== null || stale.signalCode !== null) resolve();
        else stale.once("exit", () => resolve());
      });
      // Still ours to kill: a TERM from the sweep would have ended it already.
      kept.kill("SIGKILL");
      await new Promise<void>((resolve) => {
        if (kept.exitCode !== null || kept.signalCode !== null) resolve();
        else kept.once("exit", () => resolve());
      });
      expect(kept.signalCode).toBe("SIGKILL");
      expect(messages.filter((m) => m.includes("no longer active"))).toHaveLength(1);
    } finally {
      stale.kill("SIGKILL");
      kept.kill("SIGKILL");
      await log.close();
    }
  });

  test("a recorded answer runs the next step in serve's process", async () => {
    const home = await makeHome();
    const log = openConfigLog(home.config);
    const registry = await loadPluginRegistry({
      home: home.home,
      store: new MemoryPluginStore({ root: home.storeRoot }),
    });
    try {
      const info = await log.startRun("after-ask", "job:2");
      const found = registry.flow("after-ask");
      if (found === undefined) throw new Error("missing flow after-ask");
      await new Runner({
        log,
        flow: found.flow,
        runId: info.runId,
        registry,
        lockRoot: home.storeRoot,
      }).run();
      expect((await readState(log, info.runId)).status).toBe("waiting_person");

      // Another process records the answer only. The run stays where it is and
      // no step is requested until serve picks the input up.
      const child = Bun.spawn({
        cmd: [process.execPath, answerChildPath, home.home, info.runId, "go"],
        cwd: home.home,
        env: { ...process.env, OPERAD_HOME: home.home },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await child.exited).toBe(0);
      const childPid = child.pid;
      expect((await readState(log, info.runId)).status).toBe("waiting_person");
      const before = [];
      for await (const fact of log.read(info.runId)) before.push(fact);
      expect(
        before.some(
          (fact) =>
            fact.kind === "effect_requested" &&
            (fact.payload as { step?: unknown }).step === "work",
        ),
      ).toBe(false);

      const spawned: string[] = [];
      await serveOnce({
        log,
        registry,
        lockRoot: home.storeRoot,
        spawnRun: async (runId, options) => {
          spawned.push(runId);
          await new Runner({
            log,
            flow: found.flow,
            runId,
            registry,
            lockRoot: home.storeRoot,
            recover: options.recover,
          }).run();
        },
      });

      expect(spawned).toEqual([info.runId]);
      expect((await readState(log, info.runId)).endedStatus).toBe("done");
      const facts = [];
      for await (const fact of log.read(info.runId)) facts.push(fact);
      const started = facts.find(
        (fact) =>
          fact.kind === "step_started" &&
          (fact.payload as { step?: unknown }).step === "work",
      );
      // The step's start fact names this process, not the one that answered.
      expect((started?.payload as { pid?: unknown }).pid).toBe(process.pid);
      expect((started?.payload as { pid?: unknown }).pid).not.toBe(childPid);
    } finally {
      await log.close();
    }
  });

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
      const started = active[0];
      if (started === undefined) throw new Error("no started run");
      // The tick start went through the kernel entry: its start metadata exists.
      expect(readStoredStart(home.storeRoot, started.runId)).toBeDefined();
    } finally {
      await log.close();
    }
  });

  test("a tick trigger sent twice starts one run and keeps the event", async () => {
    const home = await makeHome();
    const log = openConfigLog(home.config);
    const flow = defineFlow({
      name: "tick-flow",
      entry: "done",
      steps: [
        { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
      ],
    });
    const plugin = definePlugin({
      name: "ticking",
      kind: "domain",
      version: "0.0.1",
      flows: [flow],
      async onTick(ctx) {
        await ctx.start({
          flow: "tick-flow",
          object: { type: "job", id: "1" },
          trigger: { source: "manual", key: "tick-1", type: "go", hops: 0 },
        });
      },
    });
    const registry = new PluginRegistry([plugin], {
      home: home.home,
      storeRoot: home.storeRoot,
      store: new MemoryPluginStore({ root: home.storeRoot }),
    });
    try {
      const options = {
        log,
        registry,
        lockRoot: home.storeRoot,
        spawnRun: () => undefined,
      };
      await serveOnce(options);
      await serveOnce(options);

      const active = await log.runs({ active: true });
      expect(active).toHaveLength(1);
      const run = active[0];
      if (run === undefined) throw new Error("no run");
      const start = readStoredStart(home.storeRoot, run.runId);
      expect(start?.inputId).toBeDefined();
      expect(readStoredTrigger(home.storeRoot, run.runId)).toMatchObject({
        source: "manual",
        key: "tick-1",
        type: "go",
        hops: 0,
      });
    } finally {
      await log.close();
    }
  });

  test("recovery starts a run-end chain without a kernel argument", async () => {
    const home = await makeHome();
    await Bun.write(
      join(home.home, "triggers.json"),
      JSON.stringify([
        {
          source: "operad",
          type: "run.done",
          start: { flow: "one" },
          object: "$event.object",
          mode: "auto",
        },
      ]),
    );
    const log = openConfigLog(home.config);
    const registry = new PluginRegistry([triggerPlugin], {
      home: home.home,
      storeRoot: home.storeRoot,
      store: new MemoryPluginStore({ root: home.storeRoot }),
    });
    try {
      const first = await log.startRun("one", "job:1");
      await log.append(first.runId, 0, [
        { kind: "run_started", payload: { flow: "one", hops: 0 }, cause: "seed" },
        { kind: "run_ended", payload: { status: "done", reason: null }, cause: "seed" },
      ]);

      await serveOnce({
        log,
        registry,
        lockRoot: home.storeRoot,
        spawnRun: () => undefined,
      });

      const runs = await log.runs();
      expect(runs.filter((run) => run.flow === "one")).toHaveLength(2);
      expect(runs.find((run) => run.runId === first.runId)?.active).toBe(false);
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
      // Every process the loop started: under load it may start a second one for
      // the run before the first holds the run lock; that one gives up at once.
      const children: ReturnType<typeof spawn>[] = [];
      const controller = new AbortController();
      const loop = serve({
        home: home.home,
        log,
        registry,
        lockRoot: home.storeRoot,
        intervalMs: 20,
        signal: controller.signal,
        spawnRun: (runId, options) => {
          children.push(spawn(home, runId, options.recover));
        },
      });
      await waitForFile(join(home.home, "blocked"));
      controller.abort();
      await loop;

      // A process is still mid-step after the loop ended.
      expect(children.some((child) => child.exitCode === null)).toBe(true);
      writeFileSync(join(home.home, "release"), "go");
      await Promise.all(children.map((child) => child.exited));
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

  test("a run started without an object has no object", async () => {
    expect(parseObjectKey("flow:clock/hourly")).toBeUndefined();
    expect(parseObjectKey("job:3")).toEqual({ type: "job", id: "3" });
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
