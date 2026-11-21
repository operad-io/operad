import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  StepLimits,
  appendInput,
  decide,
  defineFlow,
  initialState,
  openLog,
  readState,
  replay,
  type Fact,
  type KernelState,
  type LogBackend,
  type NewFact,
} from "../../src/index.ts";
import { useGrant } from "../../src/runner/grants.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const flow = defineFlow({
  name: "incremental-writes",
  entry: "work",
  steps: [
    {
      id: "work",
      kind: "plugin",
      params: { use: "test/echo", params: {} },
      replay: "safe",
      next: { ok: "done" },
    },
    { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
  ],
});

async function collect(facts: AsyncIterable<Fact>): Promise<Fact[]> {
  const result: Fact[] = [];
  for await (const fact of facts) result.push(fact);
  return result;
}

/** A real log with a chosen method replaced; every other call is forwarded. */
function withMethod(
  inner: LogBackend,
  method: "read" | "append",
  replacement: (...args: never[]) => unknown,
): LogBackend {
  return new Proxy(inner, {
    get(target, property) {
      if (property === method) return replacement;
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("a reported wait takes its next sequence from the run info", async () => {
  const root = await tempRoot();
  const inner = openLog({ backend: "sqlite", path: join(root, "log.sqlite") });
  try {
    const run = await inner.startRun(flow.name, "job:1");
    await inner.append(run.runId, 0, [
      { kind: "run_started", payload: { flow: flow.name }, cause: 1 },
    ]);
    const log = withMethod(inner, "read", () => {
      throw new Error("the reported wait read the run");
    });
    const limits = new StepLimits({ log });

    await limits.report({
      runId: run.runId,
      effectId: "work",
      step: "work",
      key: "pool",
      ahead: 0,
    });

    const facts = await collect(inner.read(run.runId));
    expect(facts.map((fact) => fact.kind)).toEqual(["run_started", "step_queued"]);
    expect(facts[1]?.seq).toBe(2);
  } finally {
    await inner.close();
  }
});

test("a grant uses the run's latest sequence when its fact scan is stale", async () => {
  const root = await tempRoot();
  const inner = openLog({ backend: "sqlite", path: join(root, "log.sqlite") });
  try {
    const run = await inner.startRun(flow.name, "job:1");
    await inner.append(run.runId, 0, [
      { kind: "run_started", payload: { flow: flow.name }, cause: 1 },
      { kind: "step_started", payload: { effectId: "work" }, cause: 1 },
    ]);
    const stale = withMethod(inner, "read", async function* (runId: string) {
      const all = await collect(inner.read(runId));
      // A scan that began before the last fact landed sees only what it had.
      for (const fact of all.slice(0, -1)) yield fact;
    });

    const grants = [{ waitId: "w1", kind: "command" as const, value: "echo ok" }];
    expect(await useGrant(stale, run.runId, "work", grants, "w1")).toBe(true);

    const facts = await collect(inner.read(run.runId));
    expect(facts.filter((fact) => fact.kind === "grant_used")).toHaveLength(1);
    expect(facts[facts.length - 1]?.seq).toBe(3);
  } finally {
    await inner.close();
  }
});

test("appendInput keeps the facts the log appended", async () => {
  const root = await tempRoot();
  const inner = openLog({ backend: "sqlite", path: join(root, "log.sqlite") });
  try {
    const log = withMethod(
      inner,
      "append",
      async (runId: string, expectedSeq: number, facts: readonly NewFact[]) => {
        const first = await inner.append(runId, expectedSeq, facts);
        const extra = await inner.append(runId, first.lastSeq, [
          {
            kind: "step_started",
            payload: { step: "work", effectId: "from-the-log", pid: 1 },
            cause: first.lastSeq,
          },
        ]);
        return { lastSeq: extra.lastSeq, facts: [...first.facts, ...extra.facts] };
      },
    );
    const run = await inner.startRun(flow.name, "job:1");
    const before = await readState(log, run.runId);

    const { state, decision } = await appendInput(
      log,
      flow,
      run.runId,
      before,
      { kind: "start" },
      1,
    );

    expect(decision.facts.map((fact) => fact.kind)).toEqual([
      "run_started",
      "step_entered",
      "effect_requested",
    ]);
    expect(state.effectStarted).toBe("from-the-log");
    expect(state).toEqual(replay(await collect(inner.read(run.runId))));
  } finally {
    await inner.close();
  }
});

test("markStarted keeps the facts the log appended", async () => {
  const root = await tempRoot();
  const storeRoot = join(root, "store");
  const inner = openLog({
    backend: "sqlite",
    path: join(storeRoot, "log.sqlite"),
  });
  try {
    const run = await inner.startRun(flow.name, "job:1");
    const decision = decide(flow, initialState(), { kind: "start" }, 1);
    const stored = await inner.append(run.runId, 0, decision.facts);
    const state = replay(stored.facts);
    const effect = state.effect;
    if (effect === null) throw new Error("the start effect is missing");

    const log = withMethod(
      inner,
      "append",
      async (runId: string, expectedSeq: number, facts: readonly NewFact[]) => {
        const result = await inner.append(runId, expectedSeq, facts);
        return {
          lastSeq: result.lastSeq,
          facts: result.facts.map((fact) => {
            if (fact.kind !== "step_started") return fact;
            const payload =
              typeof fact.payload === "object" &&
              fact.payload !== null &&
              !Array.isArray(fact.payload)
                ? fact.payload
                : {};
            return {
              ...fact,
              payload: { ...payload, effectId: "from-the-result" },
            };
          }),
        };
      },
    );
    const registry = new PluginRegistry([], {
      home: root,
      storeRoot,
      store: new MemoryPluginStore({ root: storeRoot }),
    });
    const runner = new Runner({
      log,
      flow,
      runId: run.runId,
      registry,
    });
    const marked = await (
      runner as unknown as {
        markStarted(
          state: KernelState,
          effect: NonNullable<KernelState["effect"]>,
        ): Promise<KernelState>;
      }
    ).markStarted(state, effect);

    expect(marked.effectStarted).toBe("from-the-result");
  } finally {
    await inner.close();
  }
});
