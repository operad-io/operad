import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  Kernel,
  MemoryPluginStore,
  PluginRegistry,
  openLog,
  serveOnce,
  type LogBackend,
} from "../../src/index.ts";
import { inputIdFor } from "../../src/log/facts.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

/** How much a pass read through the backend: calls, and records returned. */
interface Reads {
  readonly calls: Record<string, number>;
  inputsReturned: number;
  outcomesReturned: number;
}

/** The real backend, counting what each read gives back. */
function counting(inner: LogBackend): { log: LogBackend; reads: Reads } {
  const reads: Reads = { calls: {}, inputsReturned: 0, outcomesReturned: 0 };
  const count = (name: string): void => {
    reads.calls[name] = (reads.calls[name] ?? 0) + 1;
  };
  const log: LogBackend = {
    startRun: (flow, object, inputId, access) =>
      inner.startRun(flow, object, inputId, access),
    endRun: (runId) => inner.endRun(runId),
    recordInput: (runId, source, key, payload) =>
      inner.recordInput(runId, source, key, payload),
    append: (runId, seq, facts) => inner.append(runId, seq, facts),
    read: (runId) => {
      count("read");
      return inner.read(runId);
    },
    runs: (options) => {
      count(options?.active === true ? "runs(active)" : "runs(all)");
      return inner.runs(options);
    },
    appendGlobal: (fact, key) => inner.appendGlobal(fact, key),
    readGlobal: () => inner.readGlobal(),
    readInputs: () => {
      count("readInputs");
      return inner.readInputs();
    },
    readInputsAfter: async (position) => {
      count("readInputsAfter");
      const result = await inner.readInputsAfter(position);
      reads.inputsReturned += result.inputs.length;
      return result;
    },
    findInput: (inputId) => {
      count("findInput");
      return inner.findInput(inputId);
    },
    recordOutcome: (inputId, kind, payload) =>
      inner.recordOutcome(inputId, kind, payload),
    readOutcomes: () => {
      count("readOutcomes");
      return inner.readOutcomes();
    },
    readOutcome: (inputId, kind) => {
      count("readOutcome");
      return inner.readOutcome(inputId, kind);
    },
    readOutcomesAfter: async (seq) => {
      count("readOutcomesAfter");
      const result = await inner.readOutcomesAfter(seq);
      reads.outcomesReturned += result.length;
      return result;
    },
    close: () => inner.close(),
  };
  return { log, reads };
}

function inputIdOf(source: string, key: string): string {
  return inputIdFor(source, key);
}

const EVENTS = 1500;
const ANSWERED_RUNS = 400;

for (const backend of ["jsonl", "sqlite"] as const) {
  describe(`a tick over a large history (${backend})`, () => {
    test("reads what changed, not every input, answer and outcome ever recorded", async () => {
      const root = await tempRoot();
      const storeRoot = join(root, "store");
      const inner = openLog({
        backend,
        path: backend === "jsonl" ? storeRoot : join(storeRoot, "log.sqlite"),
      });
      const { log, reads } = counting(inner);
      const registry = new PluginRegistry([], {
        home: root,
        storeRoot,
        store: new MemoryPluginStore({ root: storeRoot }),
      });
      const kernel = new Kernel({
        log,
        registry,
        home: root,
        storeRoot,
        rules: [],
        onLog: () => undefined,
      });
      try {
        // A long history: many events that started nothing, and many runs
        // that were answered by a person and have ended.
        for (let index = 0; index < EVENTS; index += 1) {
          await kernel.receive({
            source: "manual",
            key: `event-${index}`,
            type: "noted",
            hops: 0,
          });
        }
        for (let index = 0; index < ANSWERED_RUNS; index += 1) {
          const run = await log.startRun("old-flow", `job:${index}`);
          await log.recordInput(run.runId, "person", `answer-${index}`, {
            kind: "person_answer",
            waitId: "w1",
            choice: "yes",
            actor: { via: "test", id: "tester" },
          });
          await log.endRun(run.runId);
        }

        const options = {
          log,
          registry,
          kernel,
          lockRoot: storeRoot,
          spawnRun: () => undefined,
        };
        const reset = (): void => {
          for (const name of Object.keys(reads.calls)) delete reads.calls[name];
          reads.inputsReturned = 0;
          reads.outcomesReturned = 0;
        };

        // The first pass after a start reads the history once.
        await serveOnce(options);
        expect(reads.inputsReturned).toBeGreaterThanOrEqual(EVENTS + ANSWERED_RUNS);

        // A pass with nothing new reads nothing of it.
        reset();
        await serveOnce(options);
        expect(reads.inputsReturned).toBe(0);
        expect(reads.outcomesReturned).toBe(0);
        expect(reads.calls["readInputs"]).toBeUndefined();
        expect(reads.calls["readOutcomes"]).toBeUndefined();
        expect(reads.calls["findInput"]).toBeUndefined();
        expect(reads.calls["readOutcome"]).toBeUndefined();
        expect(reads.calls["read"]).toBeUndefined();
        expect(reads.calls["runs(all)"]).toBeUndefined();
        // The answers of ended runs were settled in the first pass: a quiet
        // pass looks at the active runs only for its own loop and limits.
        expect(reads.calls["runs(active)"] ?? 0).toBeLessThanOrEqual(2);

        // One new event is read once by each of the two readers (answers and
        // routing), and costs a couple of outcome lookups.
        await kernel.receive({
          source: "manual",
          key: "event-new",
          type: "noted",
          hops: 0,
        });
        reset();
        await serveOnce(options);
        expect(reads.inputsReturned).toBe(2);
        expect(reads.calls["readInputs"]).toBeUndefined();
        expect(reads.calls["readOutcomes"]).toBeUndefined();
        expect(reads.calls["read"]).toBeUndefined();
        expect(reads.calls["readOutcome"] ?? 0).toBeLessThanOrEqual(2);
      } finally {
        await inner.close();
      }
    }, 120_000);

    test("an event whose routing failed is tried again on the next pass", async () => {
      const root = await tempRoot();
      const storeRoot = join(root, "store");
      const inner = openLog({
        backend,
        path: backend === "jsonl" ? storeRoot : join(storeRoot, "log.sqlite"),
      });
      let failures = 1;
      const flaky: LogBackend = {
        ...counting(inner).log,
        readOutcome: (inputId, kind) => {
          if (failures > 0) {
            failures -= 1;
            return Promise.reject(new Error("injected read failure"));
          }
          return inner.readOutcome(inputId, kind);
        },
      };
      const registry = new PluginRegistry([], {
        home: root,
        storeRoot,
        store: new MemoryPluginStore({ root: storeRoot }),
      });
      const messages: string[] = [];
      const kernel = new Kernel({
        log: flaky,
        registry,
        home: root,
        storeRoot,
        rules: [],
        onLog: (message) => messages.push(message),
      });
      try {
        // Recorded without routing, as a process that stopped right after.
        await inner.recordInput(null, "manual", "late", {
          source: "manual",
          key: "late",
          type: "noted",
          hops: 0,
        });
        await kernel.recoverUnrouted();
        expect(messages.join("\n")).toContain("injected read failure");
        expect(await inner.readOutcome(inputIdOf("manual", "late"), "route")).toBeUndefined();

        await kernel.recoverUnrouted();
        expect(await inner.readOutcome(inputIdOf("manual", "late"), "route")).toBeDefined();
      } finally {
        await inner.close();
      }
    });
  });
}

for (const backend of ["jsonl", "sqlite"] as const) {
  describe(`reading by position and by id (${backend})`, () => {
    test("inputs after a position, one input by id, and outcomes after a sequence", async () => {
      const root = await tempRoot();
      const log = openLog({
        backend,
        path: backend === "jsonl" ? join(root, "store") : join(root, "store", "log.sqlite"),
      });
      try {
        expect(await log.readInputsAfter(0)).toEqual({ inputs: [], position: 0 });
        await log.recordInput(null, "manual", "a", { n: 1 });
        await log.recordInput(null, "manual", "b", { n: 2 });
        const first = await log.readInputsAfter(0);
        expect(first.inputs.map((input) => input.sourceKey)).toEqual(["a", "b"]);
        expect((await log.readInputsAfter(first.position)).inputs).toEqual([]);

        await log.recordInput(null, "manual", "c", { n: 3 });
        const next = await log.readInputsAfter(first.position);
        expect(next.inputs.map((input) => input.sourceKey)).toEqual(["c"]);
        expect(next.position).toBeGreaterThan(first.position);

        expect((await log.findInput(inputIdFor("manual", "b")))?.payload).toEqual({ n: 2 });
        expect(await log.findInput(inputIdFor("manual", "zzz"))).toBeUndefined();

        const one = await log.recordOutcome(inputIdFor("manual", "a"), "route", { value: "none" });
        await log.recordOutcome(inputIdFor("manual", "b"), "route", { value: "none" });
        expect((await log.readOutcome(inputIdFor("manual", "a"), "route"))?.seq).toBe(one.outcome.seq);
        expect(await log.readOutcome(inputIdFor("manual", "a"), "resolve")).toBeUndefined();
        const after = await log.readOutcomesAfter(one.outcome.seq);
        expect(after.map((outcome) => outcome.inputId)).toEqual([inputIdFor("manual", "b")]);
      } finally {
        await log.close();
      }
    });
  });
}
