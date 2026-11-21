import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import {
  Kernel,
  MemoryPluginStore,
  PluginRegistry,
  defineFlow,
  openLog,
  type LogBackend,
} from "../../src/index.ts";
import { cleanupTempRoots, def, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

/** A log that counts candidate routes returned and refuses a whole-table read. */
function countingLog(inner: LogBackend): {
  readonly log: LogBackend;
  readonly candidateRows: () => number;
  readonly startRouteRows: () => number;
  readonly runsReads: () => number;
  readonly wholeReads: () => readonly string[];
} {
  let rows = 0;
  let startRoutes = 0;
  let runsReads = 0;
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
      if (property === "startRoutesWithoutRun") {
        return async () => {
          const outcomes = await target.startRoutesWithoutRun();
          startRoutes += outcomes.length;
          return outcomes;
        };
      }
      if (property === "runs") {
        return () => {
          runsReads += 1;
          throw new Error("the whole runs table was read");
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
  return {
    log,
    candidateRows: () => rows,
    startRouteRows: () => startRoutes,
    runsReads: () => runsReads,
    wholeReads: () => whole,
  };
}

test("candidates reads only the unresolved candidates after many resolved inputs", async () => {
  const root = await tempRoot();
  const storeRoot = join(root, "store");
  const inner = openLog({
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

test("refusedStarts reads only the start routes without a run", async () => {
  const root = await tempRoot();
  const storeRoot = join(root, "store");
  const inner = openLog({
    path: join(storeRoot, "log.sqlite"),
    clock: () => 1_700_000_000_000,
  });
  const { log, startRouteRows, runsReads } = countingLog(inner);
  try {
    const start = async (
      key: string,
      value: "started" | "candidate",
      resolves: string | undefined,
    ): Promise<string> => {
      const input = await inner.recordInput(null, "cron", key, {
        source: "cron",
        key,
        type: "tick",
        hops: 0,
      });
      await inner.recordOutcome(input.inputId, "route", {
        value,
        flow: "job",
        object: `job:${key}`,
      });
      if (resolves !== undefined) {
        await inner.recordOutcome(input.inputId, "resolve", { value: resolves });
      }
      return input.inputId;
    };
    const plain = await start("plain", "started", undefined);
    const plainWithRun = await start("plain-run", "started", undefined);
    const candidate = await start("candidate", "candidate", "started");
    const candidateWithRun = await start("candidate-run", "candidate", "started");
    const unresolved = await start("unresolved", "candidate", undefined);
    await inner.startRun("job", "job:plain-run", plainWithRun);
    await inner.startRun("job", "job:candidate-run", candidateWithRun);

    const registry = new PluginRegistry(
      [
        def({
          name: "app",
          steps: [
            {
              name: "work",
              calls: ["missing/step"],
              results: ["ok"],
              run: () => ({ result: "ok" }),
            },
          ],
          flows: [
            defineFlow({
              name: "job",
              entry: "work",
              steps: [
                {
                  id: "work",
                  kind: "plugin",
                  params: { use: "app/work", params: {} },
                  replay: "safe",
                  next: { ok: "done" },
                },
                { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
              ],
            }),
          ],
        }),
      ],
      {
        home: root,
        storeRoot,
        store: new MemoryPluginStore({ root: storeRoot }),
      },
    );
    const kernel = new Kernel({
      log,
      registry,
      home: root,
      storeRoot,
      rules: [],
    });

    const refused = await kernel.refusedStarts();
    expect(refused.map((item) => item.inputId).sort()).toEqual([candidate, plain].sort());
    expect(refused.every((item) => item.flow === "job")).toBe(true);
    expect(refused.some((item) => item.inputId === unresolved)).toBe(false);
    expect(startRouteRows()).toBe(2);
    expect(runsReads()).toBe(0);
  } finally {
    await inner.close();
  }
});
