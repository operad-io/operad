import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  answerRun,
  historyEntries,
  listPending,
  loadPluginRegistry,
  openLog,
  openPluginStore,
  readState,
  recordAnswer,
  type AskTimer,
  type Fact,
  type LogBackend,
} from "../../src/index.ts";
import type { TimeoutClock } from "../../src/runner/runner.ts";
import { waitForChange } from "../../src/platform/index.ts";
import plugin from "../fixtures/plugins/ask.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const pluginPath = fileURLToPath(new URL("../fixtures/plugins/ask.ts", import.meta.url));
const childPath = fileURLToPath(new URL("../fixtures/ask-child.ts", import.meta.url));

const answerPath = fileURLToPath(new URL("../fixtures/answer-child.ts", import.meta.url));

const ACTOR = { via: "cli", id: "me" } as const;

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

/** A grace timer the test fires by hand; it records the delays it was given. */
class FakeTimer {
  readonly calls: number[] = [];
  private readonly fires: (() => void)[] = [];
  private waiters: (() => void)[] = [];

  readonly timer: AskTimer = (ms, fire) => {
    this.calls.push(ms);
    this.fires.push(fire);
    const waiting = this.waiters;
    this.waiters = [];
    for (const waiter of waiting) waiter();
    return () => undefined;
  };

  armed(): Promise<void> {
    if (this.calls.length > 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  fire(): void {
    this.fires.at(-1)?.();
  }
}

interface Env {
  readonly home: string;
  readonly dir: string;
  readonly storeRoot: string;
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  create(flow: string, name: string, extra?: Record<string, unknown>): Promise<string>;
  runner(
    runId: string,
    timer: FakeTimer,
    options?: { graceSecs?: number; timeoutClock?: TimeoutClock; stepTimeoutMs?: number },
  ): Runner;
  /** The id of the first question of the run, once it is open. */
  opened(runId: string): Promise<string>;
  gate(name: string): void;
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
  const log = openLog({ backend: "jsonl", path: storeRoot });
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
  const params = new Map<string, Record<string, unknown>>();
  const env: Env = {
    home,
    dir,
    storeRoot,
    log,
    registry,
    async create(flow, name, extra = {}) {
      const info = await log.startRun(flow, `job:${name}`);
      flows.set(info.runId, flow);
      params.set(info.runId, { name, dir, ...extra });
      return info.runId;
    },
    runner(runId, timer, options = {}) {
      const flow = flows.get(runId);
      const found = flow === undefined ? undefined : registry.flow(flow);
      if (found === undefined) throw new Error(`no flow for ${runId}`);
      return new Runner({
        log,
        flow: found.flow,
        runId,
        registry,
        lockRoot: storeRoot,
        params: (params.get(runId) ?? {}) as Record<string, string>,
        askTimer: timer.timer,
        ...(options.graceSecs === undefined ? {} : { askGraceSecs: options.graceSecs }),
        ...(options.timeoutClock === undefined ? {} : { timeoutClock: options.timeoutClock }),
        ...(options.stepTimeoutMs === undefined ? {} : { stepTimeoutMs: options.stepTimeoutMs }),
      });
    },
    async opened(runId) {
      let waitId = "";
      await waitUntil(log, async () => {
        const opened = (await facts(log, runId)).find((fact) => fact.kind === "ask_opened");
        const payload = opened?.payload;
        if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
          waitId = String(payload.waitId);
        }
        return waitId.length > 0;
      });
      return waitId;
    },
    gate(name) {
      writeFileSync(join(dir, `gate-${name}`), "go");
    },
    close: () => log.close(),
  };
  return env;
}

function flowOf(env: Env, name: string) {
  const found = env.registry.flow(name);
  if (found === undefined) throw new Error(`no flow ${name}`);
  return found.flow;
}

function stepResult(list: readonly Fact[], step: string): Record<string, unknown> {
  const fact = list.find(
    (item) =>
      item.kind === "step_result" &&
      typeof item.payload === "object" &&
      item.payload !== null &&
      !Array.isArray(item.payload) &&
      item.payload.step === step,
  );
  const payload = fact?.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error(`no result for ${step}`);
  }
  return payload;
}

for (const mode of ["memory", "file"] as const) {
  describe(`ctx.ask (${mode})`, () => {
    test("an answer within the grace goes to the waiting step", async () => {
      const env = await setup(mode);
      try {
        const id = await env.create("ask-wait", "a");
        const timer = new FakeTimer();
        const run = env.runner(id, timer).run();
        const waitId = await env.opened(id);
        expect(waitId.startsWith(`${id}:`)).toBe(true);
        expect(waitId.endsWith(":1")).toBe(true);

        const pending = await listPending(env.log, env.registry);
        expect(pending).toHaveLength(1);
        expect(pending[0]?.runId).toBe(id);
        expect(pending[0]?.prompt).toBe("Delete the stale branch?");
        expect(pending[0]?.choices).toEqual(["yes", "no"]);
        expect(pending[0]?.object).toBe("job:a");

        await recordAnswer({ log: env.log, runId: id, choice: "yes", note: "go", actor: ACTOR });
        expect(await run).toBe("ended");

        const list = await facts(env.log, id);
        const all = list.map((fact) => fact.kind);
        expect(count(all, "ask_opened")).toBe(1);
        expect(count(all, "ask_answered")).toBe(1);
        expect(all).not.toContain("ask_timed_out");
        expect(stepResult(list, "q").data).toEqual({
          choice: "yes",
          note: "go",
          actor: { via: "cli", id: "me" },
        });
        expect(await listPending(env.log, env.registry)).toEqual([]);
      } finally {
        await env.close();
      }
    }, 30_000);

    test("an answer after the timeout goes through the flow wait with one item", async () => {
      const env = await setup(mode);
      try {
        const id = await env.create("ask-wait", "a");
        const timer = new FakeTimer();
        const run = env.runner(id, timer).run();
        const waitId = await env.opened(id);
        await timer.armed();
        expect(await listPending(env.log, env.registry)).toHaveLength(1);
        timer.fire();
        expect(await run).toBe("waiting");

        const state = await readState(env.log, id);
        expect(state.status).toBe("waiting_person");
        expect(state.wait?.id).toBe(waitId);
        const pending = await listPending(env.log, env.registry);
        expect(pending).toHaveLength(1);
        expect(pending[0]?.prompt).toBe("Delete the stale branch?");
        expect(pending[0]?.choices).toEqual(["yes", "no"]);
        const list = await facts(env.log, id);
        expect(stepResult(list, "q")).toMatchObject({
          result: "waiting",
          data: {
            waitId,
            prompt: "Delete the stale branch?",
            choices: ["yes", "no"],
            resume: { session: "s1" },
          },
        });

        await answerRun({
          log: env.log,
          flow: flowOf(env, "ask-wait"),
          runId: id,
          choice: "no",
          actor: ACTOR,
        });
        expect((await readState(env.log, id)).status).toBe("ended");
        expect(await listPending(env.log, env.registry)).toEqual([]);
        const words: string[] = [];
        for await (const entry of historyEntries(env.log.read(id))) words.push(entry.what);
        expect(words).toContain("asked you");
        expect(words).toContain("nobody answered in time");
      } finally {
        await env.close();
      }
    }, 30_000);
  });
}

describe("ctx.ask", () => {
  test("a late answer to a step that ended is refused and recorded", async () => {
    const env = await setup("memory");
    try {
      const id = await env.create("ask-hold", "a", { onTimeout: "reject_once" });
      const timer = new FakeTimer();
      const run = env.runner(id, timer).run();
      const waitId = await env.opened(id);
      await timer.armed();
      timer.fire();
      await fileExists(join(env.dir, "holding-a"));

      await expect(
        recordAnswer({ log: env.log, runId: id, waitId, choice: "yes", actor: ACTOR }),
      ).rejects.toThrow(/closed/);
      await expect(
        recordAnswer({ log: env.log, runId: id, choice: "yes", actor: ACTOR }),
      ).rejects.toThrow(/not waiting for a person/);
      const list = await facts(env.log, id);
      const all = list.map((fact) => fact.kind);
      expect(count(all, "ask_refused")).toBe(1);
      expect(all).not.toContain("ask_answered");
      expect(stepResult(list, "q").result).toBe("rejected");
      expect(await listPending(env.log, env.registry)).toEqual([]);

      env.gate("a");
      expect(await run).toBe("ended");
    } finally {
      await env.close();
    }
  }, 30_000);

  test("an answer claimed by a process that stopped before the fact is still delivered", async () => {
    const env = await setup("memory");
    try {
      const id = await env.create("ask-wait", "c");
      const run = env.runner(id, new FakeTimer()).run();
      const waitId = await env.opened(id);
      // The claim is recorded, and the process that took it never wrote the fact.
      await env.log.recordInput(id, "person", `${id}:ask:${waitId}`, {
        kind: "ask_answer",
        waitId,
        choice: "no",
        note: null,
        actor: { via: "cli", id: "gone" },
      });
      expect(await run).toBe("ended");
      const list = await facts(env.log, id);
      expect(stepResult(list, "q").data).toMatchObject({
        choice: "no",
        actor: { via: "cli", id: "gone" },
      });
      expect(count(list.map((fact) => fact.kind), "ask_answered")).toBe(1);
    } finally {
      await env.close();
    }
  }, 30_000);

  test("an answer to a run that was cancelled while it asked is not taken", async () => {
    const env = await setup("memory");
    try {
      const id = await env.create("ask-wait", "a");
      const timer = new FakeTimer();
      const abort = new AbortController();
      const found = flowOf(env, "ask-wait");
      const run = new Runner({
        log: env.log,
        flow: found,
        runId: id,
        registry: env.registry,
        lockRoot: env.storeRoot,
        params: { name: "a", dir: env.dir },
        askTimer: timer.timer,
        signal: abort.signal,
      }).run();
      await env.opened(id);
      abort.abort();
      expect(await run).toBe("ended");
      const waitId = await env.opened(id);
      // The run has ended, so there is nothing to answer.
      await expect(
        recordAnswer({ log: env.log, runId: id, waitId, choice: "yes", actor: ACTOR }),
      ).rejects.toThrow(/not waiting for a person/);
    } finally {
      await env.close();
    }
  }, 30_000);

  test("the grace is the narrowest of the call, the step param and the config", async () => {
    const cases: {
      flow: string;
      extra: Record<string, unknown>;
      config?: number;
      expected: number;
    }[] = [
      { flow: "ask-param90", extra: { graceSecs: 5 }, config: 600, expected: 5_000 },
      { flow: "ask-param90", extra: {}, config: 600, expected: 90_000 },
      { flow: "ask-param30", extra: { graceSecs: 90 }, config: 600, expected: 30_000 },
      { flow: "ask-wait", extra: { graceSecs: 90 }, config: 600, expected: 90_000 },
      { flow: "ask-wait", extra: { graceSecs: 90 }, config: 7, expected: 7_000 },
      { flow: "ask-wait", extra: {}, config: 7, expected: 7_000 },
      { flow: "ask-wait", extra: {}, expected: 600_000 },
    ];
    for (const entry of cases) {
      const env = await setup("memory");
      try {
        const id = await env.create(entry.flow, "g", entry.extra);
        const timer = new FakeTimer();
        const run = env
          .runner(id, timer, entry.config === undefined ? {} : { graceSecs: entry.config })
          .run();
        await env.opened(id);
        await timer.armed();
        expect(timer.calls).toEqual([entry.expected]);
        await recordAnswer({ log: env.log, runId: id, choice: "yes", actor: ACTOR });
        expect(await run).toBe("ended");
      } finally {
        await env.close();
      }
    }
  }, 60_000);

  test("the step's own timeout does not run while it waits for an answer", async () => {
    const env = await setup("memory");
    try {
      const id = await env.create("ask-wait", "t");
      const timer = new FakeTimer();
      // A clock the test moves by hand: the step may take 100 ms in all.
      let now = 0;
      let next = 0;
      const timers = new Map<number, { due: number; fire: () => void }>();
      const timeoutClock: TimeoutClock = {
        now: () => now,
        set: (fire, ms) => {
          next += 1;
          timers.set(next, { due: now + ms, fire });
          return next;
        },
        clear: (handle) => {
          timers.delete(handle as number);
        },
      };
      const run = env.runner(id, timer, { timeoutClock, stepTimeoutMs: 100 }).run();
      await env.opened(id);
      await timer.armed();
      // The grace timer is set after the step's clock stopped: none is left.
      expect(timers.size).toBe(0);
      now += 10_000;
      for (const [handle, entry] of [...timers]) {
        timers.delete(handle);
        entry.fire();
      }
      await recordAnswer({ log: env.log, runId: id, choice: "yes", actor: ACTOR });
      expect(await run).toBe("ended");
      expect(stepResult(await facts(env.log, id), "q").result).toBe("answered");
    } finally {
      await env.close();
    }
  }, 30_000);

  test("a step that asks with onTimeout waiting must declare waiting", async () => {
    const env = await setup("memory");
    try {
      const asker = {
        ask: async () => {
          throw new Error("the question must not be asked");
        },
      };
      const options = { runId: "bare-run", asker, params: null };
      await expect(env.registry.runStep("ask/bare", {}, options)).rejects.toThrow(
        /must declare it in results/,
      );
      // With reject_once the step needs no waiting result.
      const taken = {
        ask: async () => ({
          kind: "timeout" as const,
          waitId: "w",
          prompt: "Bare?",
          choices: [],
        }),
      };
      const result = await env.registry.runStep(
        "ask/bare",
        { rejectOnce: true },
        { ...options, asker: taken },
      );
      expect(result).toEqual({ result: "answered", data: { rejected: true } });
    } finally {
      await env.close();
    }
  });

  test("a grace above the timer limit is refused", async () => {
    const env = await setup("memory");
    try {
      const asker = {
        ask: async () => {
          throw new Error("the question must not be asked");
        },
      };
      await expect(
        env.registry.runStep("ask/question", {}, {
          runId: "long-run",
          asker,
          params: { name: "l", dir: env.dir, graceSecs: 2_147_484 },
        }),
      ).rejects.toThrow(/from 0 to 2147483/);
      await expect(
        env.registry.runStep("ask/question", { askGraceSecs: 1e12 }, {
          runId: "long-run",
          asker,
          params: { name: "l", dir: env.dir },
        }),
      ).rejects.toThrow(/askGraceSecs.*from 0 to 2147483/);
    } finally {
      await env.close();
    }
  });

  test("a second question at once in one step is refused", async () => {
    const env = await setup("memory");
    try {
      const id = await env.create("ask-wait", "d", { concurrent: true });
      const run = env.runner(id, new FakeTimer()).run();
      await env.opened(id);
      const pending = await listPending(env.log, env.registry);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.prompt).toBe("First?");
      await recordAnswer({ log: env.log, runId: id, choice: "yes", actor: ACTOR });
      expect(await run).toBe("ended");
      const list = await facts(env.log, id);
      expect(count(list.map((fact) => fact.kind), "ask_opened")).toBe(1);
      expect(JSON.stringify(stepResult(list, "q").data)).toContain(
        "asks one question at a time",
      );
    } finally {
      await env.close();
    }
  }, 30_000);

  test("a grace of 0 does not wait", async () => {
    const env = await setup("memory");
    try {
      const id = await env.create("ask-wait", "z", { graceSecs: 0 });
      const timer = new FakeTimer();
      expect(await env.runner(id, timer).run()).toBe("waiting");
      expect(timer.calls).toEqual([]);
      const all = await kinds(env.log, id);
      expect(all).toContain("ask_opened");
      expect(all).toContain("ask_timed_out");
      const state = await readState(env.log, id);
      expect(state.status).toBe("waiting_person");
      expect(await listPending(env.log, env.registry)).toHaveLength(1);
    } finally {
      await env.close();
    }
  }, 30_000);

  test("reject_once returns to the step with rejected", async () => {
    const env = await setup("memory");
    try {
      const id = await env.create("ask-wait", "r", { onTimeout: "reject_once", graceSecs: 0 });
      const timer = new FakeTimer();
      expect(await env.runner(id, timer).run()).toBe("ended");
      const list = await facts(env.log, id);
      expect(stepResult(list, "q").result).toBe("rejected");
      expect(list.map((fact) => fact.kind)).not.toContain("waiting_for_person");
    } finally {
      await env.close();
    }
  }, 30_000);

  test("of two answers at once one wins and the other is refused", async () => {
    const env = await setup("memory");
    try {
      const id = await env.create("ask-hold", "a");
      const timer = new FakeTimer();
      const run = env.runner(id, timer).run();
      const waitId = await env.opened(id);
      const settled = await Promise.allSettled([
        recordAnswer({ log: env.log, runId: id, waitId, choice: "yes", actor: ACTOR }),
        recordAnswer({
          log: env.log,
          runId: id,
          waitId,
          choice: "no",
          actor: { via: "http", id: "you" },
        }),
      ]);
      expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(1);
      const lost = settled.find((item) => item.status === "rejected");
      expect(String((lost as PromiseRejectedResult).reason)).toMatch(/already answered/);

      await fileExists(join(env.dir, "holding-a"));
      const list = await facts(env.log, id);
      expect(count(list.map((fact) => fact.kind), "ask_answered")).toBe(1);
      // A third answer, later, is refused the same way.
      await expect(
        recordAnswer({ log: env.log, runId: id, waitId, choice: "no", actor: ACTOR }),
      ).rejects.toThrow(/already answered/);
      env.gate("a");
      expect(await run).toBe("ended");
    } finally {
      await env.close();
    }
  }, 30_000);
});

interface Child {
  readonly exited: Promise<number>;
}

describe("ctx.ask answers from two processes", () => {
  test("of two processes answering one question exactly one wins", async () => {
    const env = await setup("file");
    try {
      const id = await env.create("ask-hold", "x");
      const run = env.runner(id, new FakeTimer()).run();
      const waitId = await env.opened(id);
      const answerer = (choice: string) =>
        Bun.spawn(
          [process.execPath, answerPath, env.home, id, waitId, choice],
          { stdio: ["ignore", "inherit", "inherit"] },
        ).exited;
      const codes = await Promise.all([answerer("yes"), answerer("no")]);
      expect([...codes].sort()).toEqual([0, 3]);
      await fileExists(join(env.dir, "holding-x"));
      const list = await facts(env.log, id);
      expect(count(list.map((fact) => fact.kind), "ask_answered")).toBe(1);
      env.gate("x");
      expect(await run).toBe("ended");
    } finally {
      await env.close();
    }
  }, 60_000);
});

describe("ctx.ask survives a crash", () => {
  function spawnChild(
    env: Env,
    runId: string,
    params: Record<string, unknown>,
    crash: "opened" | "timed-out" | "answer-read" | "none",
    recover = false,
  ): Child {
    const child = Bun.spawn(
      [
        process.execPath,
        childPath,
        env.home,
        runId,
        JSON.stringify({ dir: env.dir, ...params }),
        crash,
        ...(recover ? ["recover"] : []),
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    return { exited: child.exited };
  }

  test("after ask_opened, before the answer: asked again, one item", async () => {
    const env = await setup("file");
    try {
      const id = await env.create("ask-wait", "k");
      const dead = spawnChild(env, id, { name: "k" }, "opened");
      expect(await dead.exited).not.toBe(0);
      const waitId = await env.opened(id);
      expect(await listPending(env.log, env.registry)).toHaveLength(1);

      const restarted = spawnChild(env, id, { name: "k" }, "none", true);
      await fileExists(join(env.dir, "started-k-again"));
      expect(await listPending(env.log, env.registry)).toHaveLength(1);
      await recordAnswer({ log: env.log, runId: id, choice: "yes", actor: ACTOR });
      expect(await restarted.exited).toBe(0);

      const list = await facts(env.log, id);
      const all = list.map((fact) => fact.kind);
      expect(count(all, "ask_opened")).toBe(1);
      expect(count(all, "ask_answered")).toBe(1);
      expect(stepResult(list, "q").result).toBe("answered");
      expect(waitId.startsWith(`${id}:`)).toBe(true);
    } finally {
      await env.close();
    }
  }, 60_000);

  test("an answer to a question whose step ended without closing it is refused and recorded", async () => {
    const env = await setup("file");
    try {
      // An unsafe step that stopped after it asked is not run again: the run
      // goes on to the person, and the old question stays open in the log.
      const id = await env.create("ask-unsafe", "u");
      const dead = spawnChild(env, id, { name: "u" }, "opened");
      expect(await dead.exited).not.toBe(0);
      const waitId = await env.opened(id);
      const restarted = spawnChild(env, id, { name: "u" }, "none", true);
      expect(await restarted.exited).toBe(0);
      const state = await readState(env.log, id);
      expect(state.status).toBe("waiting_person");
      expect(state.wait?.id).not.toBe(waitId);

      await expect(
        recordAnswer({ log: env.log, runId: id, waitId, choice: "yes", actor: ACTOR }),
      ).rejects.toThrow(/closed/);
      const all = await kinds(env.log, id);
      expect(count(all, "ask_refused")).toBe(1);
      expect(all).not.toContain("ask_answered");
      // The flow's own wait is still there to answer.
      expect((await readState(env.log, id)).status).toBe("waiting_person");
    } finally {
      await env.close();
    }
  }, 60_000);

  test("an old open question does not change the error for an answer", async () => {
    const env = await setup("file");
    try {
      // The unsafe step stopped after it asked; the run went on to a step that
      // is running now, and the old question is open in the log for good.
      const id = await env.create("ask-unsafe-hold", "y");
      const dead = spawnChild(env, id, { name: "y" }, "opened");
      expect(await dead.exited).not.toBe(0);
      await env.opened(id);
      const restarted = spawnChild(env, id, { name: "y" }, "none", true);
      await fileExists(join(env.dir, "holding-y"));
      expect((await readState(env.log, id)).status).toBe("running");
      await expect(
        recordAnswer({ log: env.log, runId: id, choice: "yes", actor: ACTOR }),
      ).rejects.toThrow(/not waiting for a person/);
      expect(await kinds(env.log, id)).not.toContain("ask_refused");
      env.gate("y");
      expect(await restarted.exited).toBe(0);
    } finally {
      await env.close();
    }
  }, 60_000);

  test("after ask_answered, before the step reads it: delivered from the fact", async () => {
    const env = await setup("file");
    try {
      const id = await env.create("ask-wait", "k");
      const dead = spawnChild(env, id, { name: "k" }, "answer-read");
      await env.opened(id);
      await recordAnswer({ log: env.log, runId: id, choice: "no", note: "later", actor: ACTOR });
      expect(await dead.exited).not.toBe(0);
      const midway = await kinds(env.log, id);
      expect(midway).toContain("ask_answered");
      expect(midway).not.toContain("step_result");

      const restarted = spawnChild(env, id, { name: "k" }, "none", true);
      expect(await restarted.exited).toBe(0);
      const list = await facts(env.log, id);
      expect(stepResult(list, "q").data).toEqual({
        choice: "no",
        note: "later",
        actor: { via: "cli", id: "me" },
      });
      const all = list.map((fact) => fact.kind);
      expect(count(all, "ask_opened")).toBe(1);
      expect(count(all, "ask_answered")).toBe(1);
    } finally {
      await env.close();
    }
  }, 60_000);

  test("after the timeout, before the flow wait: the wait is reached with the same id", async () => {
    const env = await setup("file");
    try {
      const id = await env.create("ask-wait", "k");
      const dead = spawnChild(env, id, { name: "k", graceSecs: 0 }, "timed-out");
      expect(await dead.exited).not.toBe(0);
      const waitId = await env.opened(id);
      const midway = await kinds(env.log, id);
      expect(midway).toContain("ask_timed_out");
      expect(midway).not.toContain("step_result");

      const restarted = spawnChild(env, id, { name: "k", graceSecs: 0 }, "none", true);
      expect(await restarted.exited).toBe(0);
      const state = await readState(env.log, id);
      expect(state.status).toBe("waiting_person");
      expect(state.wait?.id).toBe(waitId);
      expect(await listPending(env.log, env.registry)).toHaveLength(1);
      expect(count(await kinds(env.log, id), "ask_opened")).toBe(1);
    } finally {
      await env.close();
    }
  }, 60_000);
});
