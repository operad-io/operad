import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  Kernel,
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  definePlugin,
  formatHistoryEntry,
  historyEntries,
  listPending,
  loadTriggerRules,
  openLog,
  parseTriggerRules,
  readState,
  readStoredStart,
  readStoredTrigger,
  serveOnce,
  TriggerStore,
  type AppendResult,
  type Fact,
  type GlobalFact,
  type InputRecord,
  type JsonValue,
  type LogBackend,
  type NewFact,
  type RecordInputResult,
  type RunInfo,
  type RunsOptions,
  type StoredTriggerResult,
  type TriggerEvent,
  type TriggerRule,
  type TriggerStoreOptions,
} from "../../src/index.ts";
import plugin from "../fixtures/plugins/trigger.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

interface Setup {
  readonly root: string;
  readonly storeRoot: string;
  readonly log: LogBackend;
  readonly registry: PluginRegistry;
  readonly kernel: Kernel;
  readonly clock: { value: number };
  close(): Promise<void>;
}

async function setup(rules: readonly TriggerRule[] = []): Promise<Setup> {
  const root = await tempRoot();
  const storeRoot = join(root, "store");
  const log = openLog({ backend: "jsonl", path: storeRoot });
  const registry = new PluginRegistry([plugin], {
    home: root,
    storeRoot,
    store: new MemoryPluginStore({ root: storeRoot }),
  });
  const clock = { value: 1_700_000_000_000 };
  const kernel = new Kernel({
    log,
    registry,
    home: root,
    storeRoot,
    rules,
    clock: () => clock.value,
  });
  return {
    root,
    storeRoot,
    log,
    registry,
    kernel,
    clock,
    close: async () => {
      await log.close();
    },
  };
}

function rule(overrides: Partial<TriggerRule>): TriggerRule {
  return {
    source: "cron",
    type: "tick",
    start: { flow: "one" },
    object: "job:1",
    mode: "auto",
    ...overrides,
  };
}

function event(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    source: "cron",
    key: "0:2026-01-01T00:00:00.000Z",
    type: "tick",
    hops: 0,
    ...overrides,
  };
}

/** A log that throws on a chosen call, to place a crash between two writes. */
class CrashLog implements LogBackend {
  private readonly calls = new Map<string, number>();

  constructor(
    private readonly inner: LogBackend,
    private readonly crashAt: (method: string, call: number) => boolean,
    private readonly crashAfterStart = false,
    private readonly crashAfter: (method: string) => boolean = () => false,
  ) {}

  private check(method: string): void {
    const call = (this.calls.get(method) ?? 0) + 1;
    this.calls.set(method, call);
    if (this.crashAt(method, call)) {
      throw new Error(`injected crash in ${method} call ${call}`);
    }
  }

  private afterCheck(method: string): void {
    if (this.crashAfter(method)) {
      throw new Error(`injected crash after ${method}`);
    }
  }

  async startRun(
    flow: string,
    object: string,
    startInputId?: string | null,
  ): Promise<RunInfo> {
    this.check("startRun");
    const info = await this.inner.startRun(flow, object, startInputId ?? null);
    // A crash after the run exists but before its start files are written.
    if (this.crashAfterStart) throw new Error("injected crash after startRun");
    return info;
  }

  async endRun(runId: string): Promise<void> {
    this.check("endRun");
    return this.inner.endRun(runId);
  }

  async recordInput(
    runId: string | null,
    source: string,
    sourceKey: string,
    payload: JsonValue,
  ): Promise<RecordInputResult> {
    this.check("recordInput");
    const result = await this.inner.recordInput(runId, source, sourceKey, payload);
    this.afterCheck("recordInput");
    return result;
  }

  async append(
    runId: string,
    expectedSeq: number,
    facts: readonly NewFact[],
  ): Promise<AppendResult> {
    this.check("append");
    return this.inner.append(runId, expectedSeq, facts);
  }

  read(runId: string): AsyncIterable<Fact> {
    return this.inner.read(runId);
  }

  async runs(options?: RunsOptions): Promise<RunInfo[]> {
    this.check("runs");
    const result = await this.inner.runs(options);
    this.afterCheck("runs");
    return result;
  }

  async appendGlobal(fact: NewFact): Promise<GlobalFact> {
    this.check("appendGlobal");
    const result = await this.inner.appendGlobal(fact);
    this.afterCheck("appendGlobal");
    return result;
  }

  readGlobal(): AsyncIterable<GlobalFact> {
    return this.inner.readGlobal();
  }

  readInputs(): AsyncIterable<InputRecord> {
    return this.inner.readInputs();
  }

  async close(): Promise<void> {
    return this.inner.close();
  }
}

/** A journal that throws after a chosen write, to place a crash in a sidecar. */
class CrashStore extends TriggerStore {
  constructor(
    options: TriggerStoreOptions,
    private readonly crashAfter: (method: string) => boolean,
  ) {
    super(options);
  }

  private crash(method: string): void {
    if (this.crashAfter(method)) {
      throw new Error(`injected crash after ${method}`);
    }
  }

  override recordEvent(inputId: string, event: TriggerEvent): void {
    super.recordEvent(inputId, event);
    this.crash("recordEvent");
  }

  override setResult(
    inputId: string,
    result: Omit<StoredTriggerResult, "at">,
  ): void {
    super.setResult(inputId, result);
    this.crash("setResult");
  }
}

/** How many event records the trigger journal holds for one run-end key. */
function endEventRecords(storeRoot: string, key: string): number {
  const path = join(storeRoot, "triggers", "events.jsonl");
  if (!existsSync(path)) return 0;
  let count = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.length === 0) continue;
    const record = JSON.parse(line) as {
      readonly type?: string;
      readonly event?: { readonly source?: string; readonly key?: string };
    };
    if (
      record.type === "event" &&
      record.event?.source === "operad" &&
      record.event.key === key
    ) {
      count += 1;
    }
  }
  return count;
}

async function drive(env: Setup, runId: string): Promise<void> {
  const runs = await env.log.runs();
  const run = runs.find((candidate) => candidate.runId === runId);
  if (run === undefined) throw new Error(`missing run ${runId}`);
  const found = env.registry.flow(run.flow);
  if (found === undefined) throw new Error(`missing flow ${run.flow}`);
  const startInput = readStoredStart(env.storeRoot, runId);
  const trigger = readStoredTrigger(env.storeRoot, runId);
  await new Runner({
    log: env.log,
    flow: found.flow,
    runId,
    registry: env.registry,
    lockRoot: env.storeRoot,
    ...(startInput === undefined ? {} : { startInput }),
    ...(trigger === undefined ? {} : { trigger }),
    onEnded: async (id, state) => {
      await env.kernel.emitRunEnd(id, state);
    },
    emit: async (emitted) => {
      const dot = emitted.type.indexOf(".");
      if (dot <= 0) throw new Error(`bad type ${emitted.type}`);
      await env.kernel.emitStep(
        runId,
        emitted.type.slice(0, dot),
        emitted,
        run.object,
      );
    },
  }).run();
}

/** Runs every idle active run, including runs started by their events. */
async function drain(env: Setup, limit = 30): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    const active = await env.log.runs({ active: true });
    let progressed = false;
    for (const run of active) {
      const state = await readState(env.log, run.runId);
      if (state.status !== "idle") continue;
      await drive(env, run.runId);
      progressed = true;
    }
    if (!progressed) return;
  }
}

async function runHistory(env: Setup, runId: string): Promise<string> {
  const lines: string[] = [];
  for await (const entry of historyEntries(env.log.read(runId))) {
    lines.push(formatHistoryEntry(entry));
  }
  return lines.join("\n");
}

describe("the kernel start entry", () => {
  test("the same event twice records one input and starts one run", async () => {
    const env = await setup([rule({})]);
    try {
      const first = await env.kernel.receive(event());
      const second = await env.kernel.receive(event());
      expect(first.kind).toBe("started");
      expect(second.kind).toBe("started");
      if (first.kind !== "started" || second.kind !== "started") return;
      expect(second.runId).toBe(first.runId);
      expect(second.duplicate).toBe(true);

      const runs = await env.log.runs();
      expect(runs).toHaveLength(1);
      expect(runs[0]?.flow).toBe("one");
      expect(runs[0]?.object).toBe("job:1");
      if (first.runId === undefined) throw new Error("no run id");
      const state = await readState(env.log, first.runId);
      expect(state.status).toBe("idle");
    } finally {
      await env.close();
    }
  });

  test("observe records what it would have started", async () => {
    const env = await setup([rule({ mode: "observe" })]);
    try {
      const result = await env.kernel.receive(event());
      expect(result.kind).toBe("observed");
      expect(result.flow).toBe("one");
      expect(result.object).toBe("job:1");
      expect(await env.log.runs()).toHaveLength(0);
      expect(env.kernel.store.result(result.inputId)?.kind).toBe("observed");
      const facts: { readonly kind: string; readonly payload: unknown }[] = [];
      for await (const fact of env.log.readGlobal()) facts.push(fact);
      const observed = facts.find((fact) => fact.kind === "trigger_observed");
      expect(observed).toBeDefined();
      expect(JSON.stringify(observed?.payload)).toContain(
        "would start one on job:1",
      );
    } finally {
      await env.close();
    }
  });

  test("the start fact is caused by the recorded event", async () => {
    const env = await setup([rule({})]);
    try {
      const result = await env.kernel.receive(event());
      if (result.runId === undefined) throw new Error("no run id");
      await drive(env, result.runId);
      const facts: { readonly kind: string; readonly cause: number | string }[] = [];
      for await (const fact of env.log.read(result.runId)) facts.push(fact);
      expect(facts[0]?.kind).toBe("run_started");
      expect(facts[0]?.cause).toBe(result.inputId);
    } finally {
      await env.close();
    }
  });

  test("a crash after the run is created keeps the event that started it", async () => {
    const env = await setup([]);
    try {
      const crashing = new Kernel({
        log: new CrashLog(env.log, () => false, true),
        registry: env.registry,
        home: env.root,
        storeRoot: env.storeRoot,
        onLog: () => undefined,
      });
      await expect(
        crashing.start({
          flow: "one",
          object: "job:1",
          trigger: event({ hops: 2 }),
        }),
      ).rejects.toThrow("injected crash after startRun");

      const active = await env.log.runs({ active: true });
      expect(active).toHaveLength(1);
      const run = active[0];
      if (run === undefined) throw new Error("no run");
      // The run exists, but its creator died before writing its start files.
      expect(readStoredStart(env.storeRoot, run.runId)).toBeUndefined();
      expect(readStoredTrigger(env.storeRoot, run.runId)).toBeUndefined();
      const recorded = env.kernel.store
        .unrouted()
        .find((item) => item.event.type === "tick");
      if (recorded === undefined) throw new Error("the event was not recorded");

      // Recovery restores the start files before it hands the run to a child.
      await serveOnce({
        log: env.log,
        registry: env.registry,
        lockRoot: env.storeRoot,
        kernel: env.kernel,
        spawnRun: (runId) => drive(env, runId),
      });

      expect(readStoredStart(env.storeRoot, run.runId)).toMatchObject({
        kind: "start",
        inputId: recorded.inputId,
        hops: 2,
        trigger: { source: "cron", type: "tick", key: event().key },
      });
      expect(readStoredTrigger(env.storeRoot, run.runId)).toMatchObject({
        source: "cron",
        type: "tick",
        key: event().key,
        hops: 2,
      });

      const facts: {
        readonly kind: string;
        readonly cause: number | string;
        readonly payload: unknown;
      }[] = [];
      for await (const fact of env.log.read(run.runId)) facts.push(fact);
      const started = facts.find((fact) => fact.kind === "run_started");
      expect(started?.cause).toBe(recorded.inputId);
      expect(started?.payload).toMatchObject({
        hops: 2,
        trigger: { source: "cron", type: "tick", key: event().key },
      });
      const state = await readState(env.log, run.runId);
      expect(state.status).toBe("ended");
      expect(state.results["work:1"]?.data).toMatchObject({
        trigger: { source: "cron", hops: 2 },
      });
    } finally {
      await env.close();
    }
  });

  test("a candidate appears in pending, starts, and then leaves pending", async () => {
    const env = await setup([rule({ mode: "candidate" })]);
    try {
      const result = await env.kernel.receive(event());
      expect(result.kind).toBe("candidate");
      const pendingId = result.pendingId;
      if (pendingId === undefined) throw new Error("no pending id");

      const pending = await listPending(env.log, env.registry, env.kernel.store);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.pendingId).toBe(pendingId);
      expect(pending[0]?.actions).toEqual([
        { plugin: "operad", action: "start" },
        { plugin: "operad", action: "dismiss" },
      ]);

      const started = await env.kernel.startCandidate(pendingId);
      expect(started.kind).toBe("started");
      expect(await env.kernel.store.candidates()).toHaveLength(0);
      await drain(env);
      const runs = await env.log.runs();
      expect(runs.map((run) => run.flow)).toEqual(["one"]);
    } finally {
      await env.close();
    }
  });

  test("a candidate can be dismissed and starts nothing", async () => {
    const env = await setup([rule({ mode: "candidate" })]);
    try {
      const result = await env.kernel.receive(event());
      const pendingId = result.pendingId;
      if (pendingId === undefined) throw new Error("no pending id");
      env.kernel.dismiss(pendingId);
      expect(await env.kernel.store.candidates()).toHaveLength(0);
      expect(await env.log.runs()).toHaveLength(0);
    } finally {
      await env.close();
    }
  });

  test("an event for an object with an active run goes into that run's history", async () => {
    const env = await setup([rule({})]);
    try {
      const first = await env.kernel.receive(event());
      if (first.runId === undefined) throw new Error("no run id");
      const second = await env.kernel.receive(event({ key: "second" }));
      expect(second.kind).toBe("active");
      expect(second.runId).toBe(first.runId);
      expect(await env.log.runs()).toHaveLength(1);
      const text = await runHistory(env, first.runId);
      expect(text).toContain("event tick from cron");
    } finally {
      await env.close();
    }
  });

  test("a rule takes the event's object and its params reach the flow", async () => {
    const params = { prompt: "from the rule", count: 2 };
    const env = await setup([
      rule({
        start: { flow: "one", params },
        object: "$event.object",
        mode: "auto",
      }),
    ]);
    try {
      const incoming = event({
        object: "job:7",
        key: "object-rule",
        summary: "external note",
        data: { value: 1 },
        flow: "two",
        params: { evil: true },
        cwd: "/tmp",
      } as Partial<TriggerEvent>);
      const result = await env.kernel.receive(incoming);
      expect(result.kind).toBe("started");
      if (result.runId === undefined) throw new Error("no run id");
      await drain(env);
      const runs = await env.log.runs();
      expect(runs.map((run) => run.flow)).toEqual(["one"]);
      expect(runs[0]?.object).toBe("job:7");
      const state = await readState(env.log, result.runId);
      const recorded = Object.values(state.results)[0];
      expect((recorded?.data as { flowParams?: unknown }).flowParams).toEqual(params);
      const seen = (recorded?.data as {
        trigger?: { summary?: string; data?: string };
      }).trigger;
      expect(seen?.summary).toBeDefined();
      expect(seen?.data).toBeDefined();
      expect(readFileSync(seen?.summary ?? "", "utf8")).toBe("external note");
      expect(readFileSync(seen?.data ?? "", "utf8")).toContain('"value": 1');
    } finally {
      await env.close();
    }
  });

  test("run.done chains to a second flow, once even when repeated", async () => {
    const env = await setup([
      rule({}),
      rule({
        source: "operad",
        type: "run.done",
        start: { flow: "two" },
        object: "$event.object",
      }),
    ]);
    try {
      const first = await env.kernel.receive(event());
      if (first.runId === undefined) throw new Error("no run id");
      await drive(env, first.runId);
      let runs = await env.log.runs();
      expect(runs.map((run) => run.flow)).toEqual(["one", "two"]);

      const firstState = await readState(env.log, first.runId);
      await env.kernel.emitRunEnd(first.runId, firstState);
      runs = await env.log.runs();
      expect(runs.filter((run) => run.flow === "two")).toHaveLength(1);
    } finally {
      await env.close();
    }
  });

  test("a recovered run emits its end event once and starts the chained flow", async () => {
    const env = await setup([
      rule({
        source: "operad",
        type: "run.done",
        start: { flow: "one" },
        object: "$event.object",
      }),
    ]);
    try {
      const first = await env.log.startRun("one", "job:1");
      // A crash after the terminal facts but before the run was marked ended.
      await env.log.append(first.runId, 0, [
        { kind: "run_started", payload: { flow: "one", hops: 0 }, cause: "seed" },
        { kind: "run_ended", payload: { status: "done", reason: null }, cause: "seed" },
      ]);

      const spawnRun = () => undefined;
      await serveOnce({
        log: env.log,
        registry: env.registry,
        lockRoot: env.storeRoot,
        kernel: env.kernel,
        spawnRun,
      });

      const runs = await env.log.runs();
      expect(runs.filter((run) => run.flow === "one")).toHaveLength(2);
      expect(runs.find((run) => run.runId === first.runId)?.active).toBe(false);

      await serveOnce({
        log: env.log,
        registry: env.registry,
        lockRoot: env.storeRoot,
        kernel: env.kernel,
        spawnRun,
      });
      expect(
        (await env.log.runs()).filter((run) => run.flow === "one"),
      ).toHaveLength(2);
    } finally {
      await env.close();
    }
  });

  test("run.failed and run.cancelled match their own rules only", async () => {
    const env = await setup([
      rule({
        source: "operad",
        type: "run.done",
        start: { flow: "one" },
        object: "$event.object",
      }),
      rule({
        source: "operad",
        type: "run.failed",
        start: { flow: "two" },
        object: "job:failed",
      }),
      rule({
        source: "operad",
        type: "run.cancelled",
        start: { flow: "two" },
        object: "job:cancelled",
      }),
    ]);
    try {
      const failing = await env.kernel.start({
        flow: "failing",
        object: "job:failed",
      });
      const cancelling = await env.kernel.start({
        flow: "cancelling",
        object: "job:cancelled",
      });
      if (failing.kind !== "started" || cancelling.kind !== "started") {
        throw new Error("did not start");
      }
      await drive(env, failing.runId);
      await drive(env, cancelling.runId);
      const runs = await env.log.runs();
      expect(runs.map((run) => run.flow).sort()).toEqual([
        "cancelling",
        "failing",
        "two",
        "two",
      ]);
      expect(
        runs
          .filter((run) => run.flow === "two")
          .map((run) => run.object)
          .sort(),
      ).toEqual(["job:cancelled", "job:failed"]);
      expect(runs.filter((run) => run.flow === "one")).toHaveLength(0);
    } finally {
      await env.close();
    }
  });

  test("ctx.emit starts a matched flow and a bad type is refused", async () => {
    const env = await setup([
      rule({
        source: "operad",
        type: "trigger.custom",
        start: { flow: "two" },
        object: "$event.object",
      }),
    ]);
    try {
      const started = await env.kernel.start({
        flow: "emitting",
        object: "job:emit",
      });
      await drain(env);
      const runs = await env.log.runs();
      expect(runs.map((run) => run.flow)).toEqual(["emitting", "two"]);
      expect(started.kind).toBe("started");

      const bad = await env.kernel.start({ flow: "bad-emit", object: "job:bad" });
      if (bad.kind !== "started") throw new Error("bad-emit did not start");
      await drain(env);
      const state = await readState(env.log, bad.runId);
      const recorded = Object.values(state.results)[0];
      expect((recorded?.data as { error?: string }).error).toContain(
        "must begin with",
      );
    } finally {
      await env.close();
    }
  });

  test("hops stop after the ninth event and the history says why", async () => {
    const env = await setup([
      rule({
        source: "operad",
        type: "run.done",
        start: { flow: "one" },
        object: "$event.object",
      }),
      {
        source: "manual",
        type: "go",
        start: { flow: "one" },
        object: "$event.object",
        mode: "auto",
      },
    ]);
    try {
      await env.kernel.receive(
        event({ source: "manual", type: "go", key: "start", object: "job:1" }),
      );
      await drain(env, 50);
      const runs = await env.log.runs();
      expect(runs).toHaveLength(9);

      const last = runs[runs.length - 1];
      if (last === undefined) throw new Error("no last run");
      const text = await runHistory(env, last.runId);
      expect(text).toContain("not started");
      expect(text).toContain("chain is 9 hops deep");

      const skipped = await env.kernel.receive(
        event({ source: "manual", type: "go", key: "too-deep", hops: 9 }),
      );
      expect(skipped.kind).toBe("skipped");
      expect(await env.log.runs()).toHaveLength(9);
    } finally {
      await env.close();
    }
  });
});

describe("run-end recovery", () => {
  function chain(): TriggerRule {
    return rule({
      source: "operad",
      type: "run.done",
      start: { flow: "two" },
      object: "$event.object",
    });
  }

  async function seedEndedRun(env: Setup): Promise<RunInfo> {
    const first = await env.log.startRun("one", "job:1");
    await env.log.append(first.runId, 0, [
      { kind: "run_started", payload: { flow: "one", hops: 0 }, cause: "seed" },
      { kind: "run_ended", payload: { status: "done", reason: null }, cause: "seed" },
    ]);
    return first;
  }

  function serve(env: Setup): Promise<unknown> {
    return serveOnce({
      log: env.log,
      registry: env.registry,
      lockRoot: env.storeRoot,
      kernel: env.kernel,
      spawnRun: () => undefined,
    });
  }

  test("a crash after the run is ended still records its end event", async () => {
    const env = await setup([chain()]);
    try {
      const started = await env.kernel.start({ flow: "one", object: "job:1" });
      if (started.kind !== "started") throw new Error("did not start");
      const found = env.registry.flow("one");
      if (found === undefined) throw new Error("missing flow");
      // The first `runs` call is the end event looking its run up.
      const crashLog = new CrashLog(env.log, (method) => method === "runs");
      const crashKernel = new Kernel({
        log: crashLog,
        registry: env.registry,
        home: env.root,
        storeRoot: env.storeRoot,
        rules: [chain()],
        onLog: () => undefined,
      });
      const startInput = readStoredStart(env.storeRoot, started.runId);
      await expect(
        new Runner({
          log: crashLog,
          flow: found.flow,
          runId: started.runId,
          registry: env.registry,
          lockRoot: env.storeRoot,
          ...(startInput === undefined ? {} : { startInput }),
          onEnded: async (id, state) => {
            await crashKernel.emitRunEnd(id, state);
          },
        }).run(),
      ).rejects.toThrow("injected crash");

      // The run reached its end, but its end event was never recorded.
      expect((await readState(env.log, started.runId)).status).toBe("ended");

      await serve(env);

      const runs = await env.log.runs();
      expect(runs.filter((run) => run.flow === "two")).toHaveLength(1);
      expect(endEventRecords(env.storeRoot, started.runId)).toBe(1);
    } finally {
      await env.close();
    }
  });

  test("a crash between the event record and the end still chains once", async () => {
    const env = await setup([chain()]);
    try {
      const first = await seedEndedRun(env);
      const state = await readState(env.log, first.runId);
      const crashing = new Kernel({
        log: new CrashLog(env.log, (method) => method === "endRun"),
        registry: env.registry,
        home: env.root,
        storeRoot: env.storeRoot,
        rules: [chain()],
        onLog: () => undefined,
      });
      await expect(crashing.emitRunEnd(first.runId, state)).rejects.toThrow(
        "injected crash",
      );
      // The record happened; the run was never marked ended.
      expect(endEventRecords(env.storeRoot, first.runId)).toBe(1);
      expect(
        (await env.log.runs({ active: true })).map((run) => run.runId),
      ).toEqual([first.runId]);

      await serve(env);

      let runs = await env.log.runs();
      expect(runs.filter((run) => run.flow === "two")).toHaveLength(1);
      expect(runs.find((run) => run.runId === first.runId)?.active).toBe(false);
      expect(endEventRecords(env.storeRoot, first.runId)).toBe(1);

      await serve(env);
      runs = await env.log.runs();
      expect(runs.filter((run) => run.flow === "two")).toHaveLength(1);
    } finally {
      await env.close();
    }
  });

  test("a crash between the end and routing still chains once", async () => {
    const env = await setup([chain()]);
    try {
      const first = await seedEndedRun(env);
      const state = await readState(env.log, first.runId);
      const crashing = new Kernel({
        // The first call finds the run; the second is the routing lookup.
        log: new CrashLog(env.log, (method, call) => method === "runs" && call === 2),
        registry: env.registry,
        home: env.root,
        storeRoot: env.storeRoot,
        rules: [chain()],
        onLog: () => undefined,
      });
      await crashing.emitRunEnd(first.runId, state);
      // The run is ended, but no rule has seen its event yet.
      expect(await env.log.runs({ active: true })).toHaveLength(0);
      expect(
        env.kernel.store
          .unrouted()
          .some((item) => item.event.key === first.runId),
      ).toBe(true);
      expect(endEventRecords(env.storeRoot, first.runId)).toBe(1);

      await serve(env);

      let runs = await env.log.runs();
      expect(runs.filter((run) => run.flow === "two")).toHaveLength(1);
      expect(endEventRecords(env.storeRoot, first.runId)).toBe(1);

      await serve(env);
      runs = await env.log.runs();
      expect(runs.filter((run) => run.flow === "two")).toHaveLength(1);
    } finally {
      await env.close();
    }
  });
});

describe("event receipt recovery", () => {
  type Mode = "observe" | "candidate" | "auto";
  type CrashPoint =
    | "after recordInput"
    | "after the sidecar write"
    | "after startRun"
    | "after the pending item"
    | "after the outcome";

  interface Row {
    readonly point: CrashPoint;
    readonly mode: Mode;
    readonly lostSidecar?: boolean;
  }

  const rows: readonly Row[] = [
    { point: "after recordInput", mode: "auto" },
    { point: "after the sidecar write", mode: "auto" },
    { point: "after startRun", mode: "auto" },
    { point: "after startRun", mode: "auto", lostSidecar: true },
    { point: "after the pending item", mode: "auto" },
    { point: "after the outcome", mode: "observe", lostSidecar: true },
    { point: "after the outcome", mode: "candidate" },
  ];

  /** A kernel whose first receive crashes at one chosen write. */
  function crashingKernel(
    env: Setup,
    row: Row,
    triggersRoot: string,
  ): Kernel {
    const store = new CrashStore(
      { root: triggersRoot, clock: () => env.clock.value },
      (method) =>
        (row.point === "after the sidecar write" && method === "recordEvent") ||
        (row.point === "after the outcome" && method === "setResult"),
    );
    const log = new CrashLog(
      env.log,
      (method) => row.point === "after the pending item" && method === "startRun",
      row.point === "after startRun",
      (method) => row.point === "after recordInput" && method === "recordInput",
    );
    return new Kernel({
      log,
      registry: env.registry,
      home: env.root,
      storeRoot: env.storeRoot,
      rules: [rule({ mode: row.mode })],
      clock: () => env.clock.value,
      store,
      onLog: () => undefined,
    });
  }

  for (const row of rows) {
    test(`a crash ${row.point} in ${row.mode} mode keeps one outcome`, async () => {
      const env = await setup([rule({ mode: row.mode })]);
      const triggersRoot = join(env.storeRoot, "triggers");
      try {
        await expect(
          crashingKernel(env, row, triggersRoot).receive(event()),
        ).rejects.toThrow("injected crash");

        // What the first call left in the log, not in the sidecar.
        const beforeRetry = await env.log.runs();
        expect(beforeRetry).toHaveLength(row.point === "after startRun" ? 1 : 0);

        if (row.lostSidecar === true) {
          rmSync(join(triggersRoot, "events.jsonl"), { force: true });
        }

        const restarted = new Kernel({
          log: env.log,
          registry: env.registry,
          home: env.root,
          storeRoot: env.storeRoot,
          rules: [rule({ mode: row.mode })],
          clock: () => env.clock.value,
          onLog: () => undefined,
        });
        const result = await restarted.receive(event());
        expect(result.duplicate).toBe(true);

        const runs = await env.log.runs();
        if (row.mode === "auto") {
          expect(result.kind).toBe("started");
          expect(runs).toHaveLength(1);
          expect(result.runId).toBe(runs[0]?.runId);
        } else if (row.mode === "candidate") {
          expect(result.kind).toBe("candidate");
          expect(runs).toHaveLength(0);
          expect(await restarted.store.candidates()).toHaveLength(1);
        } else {
          expect(result.kind).toBe("observed");
          expect(runs).toHaveLength(0);
          const observed: string[] = [];
          for await (const fact of env.log.readGlobal()) {
            if (fact.kind === "trigger_observed") observed.push(fact.kind);
          }
          expect(observed).toHaveLength(1);
        }
      } finally {
        await env.close();
      }
    });
  }
  test("serve routes a recorded event with no outcome without a resend", async () => {
    const env = await setup([rule({})]);
    const triggersRoot = join(env.storeRoot, "triggers");
    try {
      const crashing = crashingKernel(
        env,
        { point: "after recordInput", mode: "auto" },
        triggersRoot,
      );
      await expect(crashing.receive(event())).rejects.toThrow("injected crash");
      expect(await env.log.runs()).toHaveLength(0);

      const restarted = new Kernel({
        log: env.log,
        registry: env.registry,
        home: env.root,
        storeRoot: env.storeRoot,
        rules: [rule({})],
        clock: () => env.clock.value,
        onLog: () => undefined,
      });
      const options = {
        log: env.log,
        registry: env.registry,
        lockRoot: env.storeRoot,
        kernel: restarted,
        spawnRun: () => undefined,
      };
      await serveOnce(options);
      expect(await env.log.runs()).toHaveLength(1);

      // A second pass sees the outcome in the log and starts nothing more.
      await serveOnce(options);
      expect(await env.log.runs()).toHaveLength(1);
    } finally {
      await env.close();
    }
  });
});

describe("trigger rules", () => {
  test("a missing file means no rules", async () => {
    const root = await tempRoot();
    expect(await loadTriggerRules({ home: join(root, "home") })).toEqual([]);
  });

  test("an invalid rule names the index and field", () => {
    expect(() =>
      parseTriggerRules(
        [
          {
            source: "cron",
            type: "tick",
            start: { flow: "one" },
            object: "job:1",
            mode: "sometimes",
          },
        ],
        "triggers.json",
      ),
    ).toThrow(/rule 0: mode/);
  });

  test("an invalid schedule names the rule index", () => {
    expect(() =>
      parseTriggerRules(
        [
          {
            source: "cron",
            type: "tick",
            start: { flow: "one" },
            object: "job:1",
            mode: "auto",
            schedule: "not a cron",
          },
        ],
        "triggers.json",
      ),
    ).toThrow(/rule 0: schedule/);
  });

  test("a rule whose flow does not exist is refused at load", async () => {
    const env = await setup();
    try {
      expect(() =>
        parseTriggerRules(
          [
            {
              source: "cron",
              type: "tick",
              start: { flow: "missing" },
              object: "job:1",
              mode: "auto",
            },
          ],
          "triggers.json",
          env.registry,
        ),
      ).toThrow(/rule 0: start.flow: unknown flow "missing"/);
    } finally {
      await env.close();
    }
  });
});

describe("source plugins", () => {
  test("a source that throws in start or emit is logged and the loop continues", async () => {
    const logs: string[] = [];
    const throwing = definePlugin({
      name: "throwing",
      kind: "source",
      version: "0.0.1",
      start() {
        throw new Error("boom");
      },
    });
    const emitting = definePlugin({
      name: "emitting",
      kind: "source",
      version: "0.0.1",
      async start(ctx) {
        await ctx.emit({ key: "one", type: "tick" });
        return { stop: () => undefined };
      },
    });
    const registry = new PluginRegistry([throwing, emitting], {
      onLog: (message) => logs.push(message),
    });
    const started = await registry.startSources({
      rules: [],
      clock: () => 0,
      emit: () => {
        throw new Error("event refused");
      },
    });
    expect(started.map((source) => source.plugin)).toEqual(["emitting"]);
    expect(logs.some((line) => line.includes("start failed: boom"))).toBe(true);
    expect(logs.some((line) => line.includes("emit failed: event refused"))).toBe(
      true,
    );
  });
});
