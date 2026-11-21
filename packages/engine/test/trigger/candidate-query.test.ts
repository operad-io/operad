import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import {
  Kernel,
  MemoryPluginStore,
  PluginRegistry,
  openLog,
  type LogBackend,
} from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

/** A log that counts candidate routes returned and refuses a whole-table read. */
function countingLog(inner: LogBackend): {
  readonly log: LogBackend;
  readonly candidateRows: () => number;
  readonly wholeReads: () => readonly string[];
} {
  let rows = 0;
  const whole: string[] = [];
  const log = new Proxy(inner, {
    get(target, property) {
      if (property === "openCandidateRoutes") {
        return async () => {
          const outcomes = await target.openCandidateRoutes();
          rows += outcomes.length;
          return outcomes;
        };
      }
      if (property === "readInputs" || property === "readOutcomes") {
        return () => {
          whole.push(property);
          throw new Error(`candidates read the whole ${property}`);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { log, candidateRows: () => rows, wholeReads: () => whole };
}

test("candidates reads only the unresolved candidates after many resolved inputs", async () => {
  const root = await tempRoot();
  const storeRoot = join(root, "store");
  const inner = openLog({
    backend: "sqlite",
    path: join(storeRoot, "log.sqlite"),
    clock: () => 1_700_000_000_000,
  });
  const { log, candidateRows, wholeReads } = countingLog(inner);
  try {
    for (let index = 0; index < 50; index += 1) {
      const input = await inner.recordInput(null, "cron", `settled-${index}`, {
        source: "cron",
        key: `settled-${index}`,
        type: "tick",
        hops: 0,
      });
      await inner.recordOutcome(input.inputId, "route", {
        value: "candidate",
        flow: "job",
        object: `job:${index}`,
      });
      await inner.recordOutcome(input.inputId, "resolve", {
        value: "dismissed",
      });
    }
    const open: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const input = await inner.recordInput(null, "cron", `open-${index}`, {
        source: "cron",
        key: `open-${index}`,
        type: "tick",
        hops: 0,
      });
      open.push(input.inputId);
      await inner.recordOutcome(input.inputId, "route", {
        value: "candidate",
        flow: "job",
        object: `job:open-${index}`,
      });
    }

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
    });

    const candidates = await kernel.candidates();
    expect(candidates.map((candidate) => candidate.pendingId).sort()).toEqual(
      open.sort(),
    );
    expect(candidateRows()).toBe(3);
    expect(wholeReads()).toEqual([]);
  } finally {
    await inner.close();
  }
});
