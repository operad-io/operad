import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  StepLimits,
  historyEntries,
  listRunning,
  loadPluginRegistry,
  openConfigLog,
  openLog,
  openPluginStore,
  readConfig,
  serveOnce,
  type Fact,
  type LogBackend,
  type RunnerOutcome,
} from "../../src/index.ts";
import { waitForChange } from "../../src/platform/index.ts";
import plugin from "../fixtures/plugins/limits.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const pluginPath = fileURLToPath(new URL("../fixtures/plugins/limits.ts", import.meta.url));
const childPath = fileURLToPath(new URL("../fixtures/limits-child.ts", import.meta.url));

/** Resolves when the file exists: a directory watch, re-checked on a timer. */
async function fileExists(path: string): Promise<void> {
  while (!existsSync(path)) {
    await waitForChange(dirname(path), basename(path), 200);
  }
}

/** Resolves when `check` holds, looking again after each change to the log. */
function waitUntil(log: LogBackend, check: () => Promise<boolean>): Promise<void> {
  return new Promise((resolve, reject) => {
    let busy = false;
    let again = false;
    let finished = false;
    let unsubscribe: () => void = () => undefined;
    const settle = (error?: unknown): void => {
      finished = true;
      unsubscribe();
      if (error === undefined) resolve();
      else reject(error);
    };
    const look = async (): Promise<void> => {
      if (finished) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          if (await check()) return settle();
        } while (again);
      } catch (error) {
        settle(error);
      } finally {
        busy = false;
      }
    };
    unsubscribe = log.subscribe?.(() => void look()) ?? (() => undefined);
    void look();
  });
}

async function facts(log: LogBackend, runId: string): Promise<Fact[]> {
  const list: Fact[] = [];
  for await (const fact of log.read(runId)) list.push(fact);
  return list;
}

async function kinds(log: LogBackend, runId: string): Promise<string[]> {
  return (await facts(log, runId)).map((fact) => fact.kind);
}

function count(list: readonly string[], kind: string): number {
  return list.filter((item) => item === kind).length;
}

interface Env {
  readonly root: string;
  readonly home: string;
  readonly dir: string;
  readonly storeRoot: string;
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  /** Creates a run of a flow; its step reads the name and the directory. */
  create(flow: string, name: string): Promise<string>;
  /** A runner for a created run. */
  runner(runId: string, name: string, options?: { signal?: AbortSignal }): Runner;
  open(...names: string[]): void;
  started(name: string): Promise<void>;
  queued(runId: string): Promise<void>;
  order(): string[];
  close(): Promise<void>;
}

/** `file` loads the plugin by path, so its steps run in worker threads. */
async function setup(mode: "memory" | "file"): Promise<Env> {
  const root = await tempRoot();
  const home = join(root, "home");
  const dir = join(root, "flags");
  mkdirSync(home, { recursive: true });
  mkdirSync(dir, { recursive: true });
  const storeRoot = join(root, "store");
  await Bun.write(
    join(home, "config.json"),
    JSON.stringify({ plugins: [pluginPath], store: { backend: "jsonl", path: storeRoot } }),
  );
  // Every fact gets a later time than the one before it, so queue order is exact.
  let tick = 0;
  const log = openLog({
    backend: "jsonl",
    path: storeRoot,
    clock: () => {
      tick = Math.max(Date.now(), tick + 1);
      return tick;
    },
  });
  const registry =
    mode === "memory"
      ? new PluginRegistry([plugin], {
          home,
          storeRoot,
          store: new MemoryPluginStore({ root: storeRoot }),
        })
      : await loadPluginRegistry({
          home,
          cwd: home,
          store: openPluginStore({ backend: "jsonl", root: storeRoot }),
        });
  const flows = new Map<string, string>();
  const env: Env = {
    root,
    home,
    dir,
    storeRoot,
    log,
    registry,
    async create(flow, name) {
      const info = await log.startRun(flow, `job:${name}`);
      flows.set(info.runId, flow);
      return info.runId;
    },
    runner(runId, name, options = {}) {
      const flow = flows.get(runId);
      const found = flow === undefined ? undefined : registry.flow(flow);
      if (found === undefined) throw new Error(`no flow for ${runId}`);
      return new Runner({
        log,
        flow: found.flow,
        runId,
        registry,
        lockRoot: storeRoot,
        params: { name, dir },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    },
    open(...names) {
      for (const name of names) writeFileSync(join(dir, `gate-${name}`), "go");
    },
    started: (name) => fileExists(join(dir, `started-${name}`)),
    queued: (runId) =>
      waitUntil(log, async () => (await kinds(log, runId)).includes("step_queued")),
    order() {
      const path = join(dir, "order");
      return existsSync(path)
        ? readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0)
        : [];
    },
    close: () => log.close(),
  };
  return env;
}

for (const mode of ["memory", "file"] as const) {
  describe(`reported waits (${mode})`, () => {
    test("two steps that report a wait show queued with the right ahead, then running", async () => {
      const env = await setup(mode);
      try {
        const a = await env.create("lim-reported", "a");
        const b = await env.create("lim-reported", "b");
        const runs: Promise<RunnerOutcome>[] = [env.runner(a, "a").run()];
        await fileExists(join(env.dir, "queued-a"));
        runs.push(env.runner(b, "b").run());
        await fileExists(join(env.dir, "queued-b"));

        const waiting = await listRunning(env.log);
        const first = waiting.find((item) => item.runId === a);
        const second = waiting.find((item) => item.runId === b);
        expect(first?.queued).toEqual({ key: "shared place", ahead: 0 });
        expect(second?.queued).toEqual({ key: "shared place", ahead: 1 });
        expect(second?.stepLabel).toBe("work queued (shared place, 1 ahead)");
        // A step that waits has not started running.
        expect(second?.stepStartedAt).toBeNull();
        expect(second?.stepElapsedMs).toBe(0);

        // The place is taken: the row is running again and the wait counts as queued time.
        writeFileSync(join(env.dir, "place-a"), "go");
        await env.started("a");
        const after = await listRunning(env.log);
        const taken = after.find((item) => item.runId === a);
        const behind = after.find((item) => item.runId === b);
        expect(taken?.queued).toBeNull();
        expect(taken?.stepLabel).toBe("work");
        expect(taken?.stepStartedAt).not.toBeNull();
        expect(taken?.queuedMs).toBeGreaterThan(0);
        expect(behind?.queued).toEqual({ key: "shared place", ahead: 0 });

        env.open("a", "b");
        writeFileSync(join(env.dir, "place-b"), "go");
        expect(await Promise.all(runs)).toEqual(["ended", "ended"]);
      } finally {
        await env.close();
      }
    });
  });

  describe(`reported waits with a plugin count (${mode})`, () => {
    test("a late report of the earlier waiter does not change the ahead the later one reported", async () => {
      const env = await setup(mode);
      try {
        const a = await env.create("lim-reported", "a");
        const b = await env.create("lim-reported", "b");
        // a began to wait before b, but b reports first: b says 1 ahead, a says 0.
        writeFileSync(join(env.dir, "ahead-a"), "0");
        writeFileSync(join(env.dir, "ahead-b"), "1");
        const runs: Promise<RunnerOutcome>[] = [env.runner(b, "b").run()];
        await fileExists(join(env.dir, "queued-b"));
        const early = await listRunning(env.log);
        expect(early.find((item) => item.runId === b)?.queued).toEqual({ key: "shared place", ahead: 1 });
        runs.push(env.runner(a, "a").run());
        await fileExists(join(env.dir, "queued-a"));
        const waiting = await listRunning(env.log);
        expect(waiting.find((item) => item.runId === b)?.queued).toEqual({ key: "shared place", ahead: 1 });
        expect(waiting.find((item) => item.runId === a)?.queued).toEqual({ key: "shared place", ahead: 0 });
        env.open("a", "b");
        writeFileSync(join(env.dir, "place-a"), "go");
        writeFileSync(join(env.dir, "place-b"), "go");
        expect(await Promise.all(runs)).toEqual(["ended", "ended"]);
      } finally {
        await env.close();
      }
    });
  });

  describe(`step limits (${mode})`, () => {
    test("two steps run, the third starts when one ends", async () => {
      const env = await setup(mode);
      try {
        const [a, b, c] = await Promise.all(
          ["a", "b", "c"].map((name) => env.create("lim-a2", name)),
        );
        if (a === undefined || b === undefined || c === undefined) throw new Error("runs");
        const runs: Promise<RunnerOutcome>[] = [env.runner(a, "a").run()];
        await env.started("a");
        runs.push(env.runner(b, "b").run());
        await env.started("b");
        runs.push(env.runner(c, "c").run());
        await env.queued(c);

        // The third waits and says so, in the running view and in history.
        // A grant pass now would give it a place if one were free.
        await new StepLimits({ log: env.log, lockRoot: env.storeRoot }).grant();
        expect(await kinds(env.log, c)).not.toContain("step_slot");
        expect(existsSync(join(env.dir, "started-c"))).toBe(false);
        const running = await listRunning(env.log);
        const waiting = running.find((item) => item.runId === c);
        expect(waiting?.queued).toEqual({ key: "a", ahead: 0 });
        expect(waiting?.stepLabel).toBe("work queued (a, 0 ahead)");
        expect(running.find((item) => item.runId === a)?.queued).toBeNull();
        const history = [];
        for await (const entry of historyEntries(env.log.read(c))) history.push(entry.what);
        expect(history).toContain("work is queued");

        env.open("a");
        await env.started("c");
        env.open("b", "c");
        expect(await Promise.all(runs)).toEqual(["ended", "ended", "ended"]);
        expect(env.order()).toEqual(["a", "b", "c"]);
        // Only the third ever waited.
        expect(count(await kinds(env.log, a), "step_queued")).toBe(1);
        expect(count(await kinds(env.log, c), "step_slot")).toBe(1);
      } finally {
        await env.close();
      }
    }, 30_000);

    test("a queue is first come, first served across four", async () => {
      const env = await setup(mode);
      try {
        const names = ["a", "b", "c", "d"];
        const ids: string[] = [];
        for (const name of names) ids.push(await env.create("lim-a1", name));
        const runs: Promise<RunnerOutcome>[] = [];
        for (const [index, name] of names.entries()) {
          const id = ids[index] ?? "";
          runs.push(env.runner(id, name).run());
          if (index === 0) await env.started(name);
          else await env.queued(id);
        }
        env.open(...names);
        expect(await Promise.all(runs)).toEqual(["ended", "ended", "ended", "ended"]);
        expect(env.order()).toEqual(names);
      } finally {
        await env.close();
      }
    }, 30_000);

    test("different keys do not block each other and no key is never limited", async () => {
      const env = await setup(mode);
      try {
        const specs: [string, string][] = [
          ["lim-a1", "x"],
          ["lim-b1", "y"],
          ["lim-free", "f1"],
          ["lim-free", "f2"],
          ["lim-free", "f3"],
        ];
        const ids: string[] = [];
        for (const [flow, name] of specs) ids.push(await env.create(flow, name));
        // One at a time, so each is judged on its own, with the others held.
        const runs: Promise<RunnerOutcome>[] = [];
        for (const [index, [, name]] of specs.entries()) {
          runs.push(env.runner(ids[index] ?? "", name).run());
          await env.started(name);
        }
        for (const id of ids.slice(2)) {
          expect(await kinds(env.log, id)).not.toContain("step_queued");
        }
        env.open(...specs.map(([, name]) => name));
        expect(await Promise.all(runs)).toEqual(specs.map(() => "ended"));
      } finally {
        await env.close();
      }
    }, 30_000);

    test("a step a step starts counts against the key", async () => {
      const env = await setup(mode);
      try {
        const nested = await env.create("lim-nested", "n");
        const plain = await env.create("lim-a1", "m");
        const first = env.runner(nested, "n").run();
        await env.started("n");
        const second = env.runner(plain, "m").run();
        await env.queued(plain);
        expect(existsSync(join(env.dir, "started-m"))).toBe(false);
        expect(await kinds(env.log, nested)).toContain("step_slot");
        env.open("n");
        await env.started("m");
        env.open("m");
        expect(await Promise.all([first, second])).toEqual(["ended", "ended"]);
        expect(env.order()).toEqual(["n", "m"]);
      } finally {
        await env.close();
      }
    }, 30_000);
  });
}

describe("step limits", () => {
  test("a step cancelled while it waits leaves the queue", async () => {
    const env = await setup("memory");
    try {
      const [a, b, c] = await Promise.all(
        ["a", "b", "c"].map((name) => env.create("lim-a1", name)),
      );
      if (a === undefined || b === undefined || c === undefined) throw new Error("runs");
      const first = env.runner(a, "a").run();
      await env.started("a");
      const cancel = new AbortController();
      const second = env.runner(b, "b", { signal: cancel.signal }).run();
      await env.queued(b);
      const third = env.runner(c, "c").run();
      await env.queued(c);

      cancel.abort();
      expect(await second).toBe("ended");
      const secondKinds = await kinds(env.log, b);
      expect(secondKinds).toContain("step_released");
      expect(secondKinds).not.toContain("step_started");

      env.open("a", "c");
      expect(await Promise.all([first, third])).toEqual(["ended", "ended"]);
      expect(env.order()).toEqual(["a", "c"]);
    } finally {
      await env.close();
    }
  }, 30_000);

  test("a limit that cannot be evaluated fails the step with the reason", async () => {
    const env = await setup("memory");
    try {
      const id = await env.create("lim-a1", "a");
      const throwing = new PluginRegistry(
        [
          {
            ...plugin,
            steps: [
              {
                name: "hold",
                results: ["ok", "failed", "interrupted"],
                limit: { key: () => "k", concurrent: () => 0 },
                run: () => ({ result: "ok" as const }),
              },
              ...(plugin.steps ?? []).filter((step) => step.name !== "hold"),
            ],
          },
        ],
        { home: env.home, storeRoot: env.storeRoot, store: new MemoryPluginStore({ root: env.storeRoot }) },
      );
      const found = throwing.flow("lim-a1");
      if (found === undefined) throw new Error("flow");
      const outcome = await new Runner({
        log: env.log,
        flow: found.flow,
        runId: id,
        registry: throwing,
        lockRoot: env.storeRoot,
        params: { name: "a", dir: env.dir },
      }).run();
      expect(outcome).toBe("ended");
      const result = (await facts(env.log, id)).find((fact) => fact.kind === "step_result");
      expect(JSON.stringify(result?.payload)).toContain("concurrent must return a positive integer");
    } finally {
      await env.close();
    }
  });
});

interface Child {
  readonly exited: Promise<number>;
  kill(): void;
}

describe("step limits survive a crash", () => {
  function spawnChild(
    env: Env,
    runId: string,
    name: string,
    crash: "queued" | "slot" | "result" | "none",
    recover = false,
  ): Child {
    const child = Bun.spawn(
      [
        process.execPath,
        childPath,
        env.home,
        runId,
        JSON.stringify({ name, dir: env.dir }),
        crash,
        ...(recover ? ["recover"] : []),
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    return { exited: child.exited, kill: () => child.kill("SIGKILL") };
  }

  test("after step_queued, before step_slot: queued again in its old place", async () => {
    const env = await setup("file");
    try {
      const h = await env.create("lim-a1", "h");
      const q = await env.create("lim-a1", "q");
      const r = await env.create("lim-a1", "r");
      const holder = env.runner(h, "h").run();
      await env.started("h");

      const dead = spawnChild(env, q, "q", "queued");
      expect(await dead.exited).not.toBe(0);
      const afterCrash = await kinds(env.log, q);
      expect(afterCrash).toContain("step_queued");
      expect(afterCrash).not.toContain("step_slot");

      const later = env.runner(r, "r").run();
      await env.queued(r);
      env.open("h", "q", "r");
      expect(await holder).toBe("ended");
      // The place goes to the one that was first in line, though it is dead.
      expect(await kinds(env.log, q)).toContain("step_slot");
      expect(await kinds(env.log, r)).not.toContain("step_slot");

      const restarted = spawnChild(env, q, "q", "none");
      expect(await restarted.exited).toBe(0);
      expect(await later).toBe("ended");
      expect(env.order()).toEqual(["h", "q", "r"]);
      expect(count(await kinds(env.log, q), "step_queued")).toBe(1);
    } finally {
      await env.close();
    }
  }, 60_000);

  test("after step_slot, before the step starts: the step runs holding its slot", async () => {
    const env = await setup("file");
    try {
      const q = await env.create("lim-a1", "q");
      const s = await env.create("lim-a1", "s");
      const dead = spawnChild(env, q, "q", "slot");
      expect(await dead.exited).not.toBe(0);
      const afterCrash = await kinds(env.log, q);
      expect(afterCrash).toContain("step_slot");
      expect(afterCrash).not.toContain("step_started");

      const other = env.runner(s, "s").run();
      await env.queued(s);
      expect(await kinds(env.log, s)).not.toContain("step_slot");

      env.open("q", "s");
      const restarted = spawnChild(env, q, "q", "none");
      expect(await restarted.exited).toBe(0);
      expect(await other).toBe("ended");
      const after = await kinds(env.log, q);
      expect(count(after, "step_queued")).toBe(1);
      expect(count(after, "step_slot")).toBe(1);
      expect(env.order()).toEqual(["q", "s"]);
    } finally {
      await env.close();
    }
  }, 60_000);

  test("while the step runs: the slot is held and recovery follows replay", async () => {
    const env = await setup("file");
    try {
      const q = await env.create("lim-a1", "q");
      const s = await env.create("lim-a1", "s");
      const child = spawnChild(env, q, "q", "none");
      await env.started("q");
      child.kill();
      await child.exited;

      const other = env.runner(s, "s").run();
      await env.queued(s);
      expect(await kinds(env.log, s)).not.toContain("step_slot");

      // A safe step runs again and keeps the slot it had.
      env.open("q", "s");
      const restarted = spawnChild(env, q, "q", "none", true);
      expect(await restarted.exited).toBe(0);
      expect(existsSync(join(env.dir, "started-q-again"))).toBe(true);
      expect(await other).toBe("ended");
      const after = await kinds(env.log, q);
      expect(count(after, "step_queued")).toBe(1);
      expect(count(after, "step_slot")).toBe(1);
      expect(env.order()).toEqual(["q", "q", "s"]);
    } finally {
      await env.close();
    }
  }, 60_000);

  test("while an unsafe step runs: its interruption frees the slot", async () => {
    const env = await setup("file");
    try {
      const q = await env.create("lim-a1-unsafe", "q");
      const s = await env.create("lim-a1", "s");
      const child = spawnChild(env, q, "q", "none");
      await env.started("q");
      child.kill();
      await child.exited;

      const other = env.runner(s, "s").run();
      await env.queued(s);
      expect(await kinds(env.log, s)).not.toContain("step_slot");

      env.open("s");
      const restarted = spawnChild(env, q, "q", "none", true);
      expect(await restarted.exited).toBe(0);
      expect(await other).toBe("ended");
      // The unsafe step did not run again.
      expect(existsSync(join(env.dir, "started-q-again"))).toBe(false);
      expect(env.order()).toEqual(["q", "s"]);
    } finally {
      await env.close();
    }
  }, 60_000);

  test("after the result, before the next is granted: the next gets the slot on restart", async () => {
    const env = await setup("file");
    try {
      const q = await env.create("lim-a1", "q");
      const s = await env.create("lim-a1", "s");
      const first = spawnChild(env, q, "q", "result");
      await env.started("q");
      const queuedBehind = spawnChild(env, s, "s", "queued");
      expect(await queuedBehind.exited).not.toBe(0);

      env.open("q");
      expect(await first.exited).not.toBe(0);
      expect(await kinds(env.log, q)).toContain("step_result");
      expect(await kinds(env.log, s)).not.toContain("step_slot");

      const spawned: string[] = [];
      await serveOnce({
        log: env.log,
        registry: env.registry,
        lockRoot: env.storeRoot,
        home: env.home,
        spawnRun: (runId) => {
          spawned.push(runId);
        },
      });
      expect(await kinds(env.log, s)).toContain("step_slot");
      expect(spawned).toContain(s);
    } finally {
      await env.close();
    }
  }, 60_000);
});

describe("step limits after a released place", () => {
  test("a step queued again after its release gets a place", async () => {
    const env = await setup("memory");
    try {
      const q = await env.create("lim-a1", "q");
      // The run is in the state a crash leaves: the effect is outstanding, and
      // the failed attempt's place was released before its result was written.
      await env.log.append(q, 0, [
        { kind: "run_started", payload: { flow: "lim-a1" }, cause: "test" },
        { kind: "step_entered", payload: { step: "work", visit: 1, kind: "plugin" }, cause: 1 },
        {
          kind: "effect_requested",
          payload: {
            effectId: "work:1",
            effect: "run_plugin_step",
            step: "work",
            replay: "safe",
            recovery: false,
            use: "lim/hold",
            params: { key: "a", concurrent: 1 },
            check: null,
            due: null,
          },
          cause: 2,
        },
      ]);
      const claim = { runId: q, effectId: "work:1", step: "work", key: "a", concurrent: 1 };
      await env.log.append(q, 3, [
        { kind: "step_queued", payload: { step: "work", effectId: "work:1", key: "a", concurrent: 1 }, cause: 3 },
      ]);
      await env.log.append(q, 4, [
        { kind: "step_released", payload: { effectId: "work:1", key: "a" }, cause: 4 },
      ]);

      const limits = new StepLimits({ log: env.log, lockRoot: env.storeRoot });
      await limits.acquire(claim);
      const after = await kinds(env.log, q);
      expect(after.slice(-2)).toEqual(["step_queued", "step_slot"]);
    } finally {
      await env.close();
    }
  }, 10_000);
});
