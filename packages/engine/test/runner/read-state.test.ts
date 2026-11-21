import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import {
  MemoryPluginStore,
  PluginRegistry,
  Runner,
  appendInput,
  openLog,
  readState,
  replay,
  type Fact,
  type JsonValue,
  type LogBackend,
  type ReadOptions,
} from "../../src/index.ts";
import plugin from "../fixtures/plugins/runner.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const APPEND_CHILD = join(
  import.meta.dir,
  "..",
  "fixtures",
  "append-run-child.ts",
);

async function collect(facts: AsyncIterable<Fact>): Promise<Fact[]> {
  const result: Fact[] = [];
  for await (const fact of facts) result.push(fact);
  return result;
}

/** A real log that counts the fact rows each read gives back. */
function countingFacts(inner: LogBackend): {
  readonly log: LogBackend;
  readonly rows: () => number;
  readonly reads: () => number;
} {
  let rows = 0;
  let reads = 0;
  const log = new Proxy(inner, {
    get(target, property) {
      if (property === "read") {
        return (runId: string, options?: ReadOptions) => {
          reads += 1;
          const source = target.read(runId, options);
          return (async function* () {
            for await (const fact of source) {
              rows += 1;
              yield fact;
            }
          })();
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { log, rows: () => rows, reads: () => reads };
}

async function appendInChild(
  path: string,
  runId: string,
  kind: string,
  payload: JsonValue = {},
): Promise<number> {
  const child = Bun.spawn(
    [process.execPath, APPEND_CHILD, path, runId, kind, JSON.stringify(payload)],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, output, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(
      `append-run child exited ${code}: ${stderr || output || "no output"}`,
    );
  }
  return (JSON.parse(output) as { readonly lastSeq: number }).lastSeq;
}

test("read after a sequence returns only the facts that follow it", async () => {
  const root = await tempRoot();
  const log = openLog({ backend: "sqlite", path: join(root, "log.sqlite") });
  try {
    const run = await log.startRun("incremental", "job:1");
    for (const kind of ["one", "two", "three"]) {
      const info = await log.run(run.runId);
      await log.append(run.runId, info?.lastSeq ?? 0, [
        { kind, payload: {}, cause: 1 },
      ]);
    }

    expect((await collect(log.read(run.runId))).map((fact) => fact.seq)).toEqual([
      1, 2, 3,
    ]);
    expect(
      (await collect(log.read(run.runId, { after: 1 }))).map((fact) => fact.seq),
    ).toEqual([2, 3]);
    expect(await collect(log.read(run.runId, { after: 3 }))).toEqual([]);
  } finally {
    await log.close();
  }
});

test("an unchanged run reads no fact on the second readState", async () => {
  const root = await tempRoot();
  const inner = openLog({
    backend: "sqlite",
    path: join(root, "log.sqlite"),
  });
  const { log, rows, reads } = countingFacts(inner);
  try {
    const run = await inner.startRun("incremental", "job:1");
    await inner.append(run.runId, 0, [
      { kind: "run_started", payload: { flow: "incremental" }, cause: 1 },
      { kind: "step_started", payload: { effectId: "one" }, cause: 1 },
    ]);

    await readState(log, run.runId);
    const firstRows = rows();
    const firstReads = reads();
    expect(firstRows).toBe(2);

    await readState(log, run.runId);
    expect(rows()).toBe(firstRows);
    expect(reads()).toBe(firstReads);

    const info = await inner.run(run.runId);
    await inner.append(run.runId, info?.lastSeq ?? 0, [
      { kind: "step_interrupted", payload: { effectId: "one" }, cause: 1 },
    ]);
    await readState(log, run.runId);
    expect(rows()).toBe(firstRows + 1);
  } finally {
    await inner.close();
  }
});

test("an ended run's state is not kept", async () => {
  const root = await tempRoot();
  const inner = openLog({
    backend: "sqlite",
    path: join(root, "log.sqlite"),
  });
  const { log, rows, reads } = countingFacts(inner);
  try {
    const run = await inner.startRun("incremental", "job:1");
    await inner.append(run.runId, 0, [
      { kind: "run_started", payload: { flow: "incremental" }, cause: 1 },
    ]);
    await readState(log, run.runId);
    const firstRows = rows();
    const firstReads = reads();
    await inner.endRun(run.runId);

    await readState(log, run.runId);
    // The ended state is dropped, though this call still answers from it.
    expect(reads()).toBe(firstReads + 1);
    expect(rows()).toBe(firstRows);
    await readState(log, run.runId);
    expect(reads()).toBe(firstReads + 2);
    expect(rows()).toBe(firstRows + 1);
  } finally {
    await inner.close();
  }
});

test("appendInput keeps the state it appended", async () => {
  const root = await tempRoot();
  const storeRoot = join(root, "store");
  const inner = openLog({
    backend: "sqlite",
    path: join(storeRoot, "log.sqlite"),
  });
  const { log, rows } = countingFacts(inner);
  try {
    const registry = new PluginRegistry([plugin], {
      home: root,
      storeRoot,
      store: new MemoryPluginStore({ root: storeRoot }),
    });
    const found = registry.flow("simple");
    if (found === undefined) throw new Error("missing simple flow");
    const run = await inner.startRun("simple", "job:1");
    const state = await readState(log, run.runId);
    const before = rows();

    const appended = await appendInput(
      log,
      found.flow,
      run.runId,
      state,
      { kind: "start" },
      1_700_000_000_000,
    );
    const afterAppend = rows();
    const kept = await readState(log, run.runId);
    expect(rows()).toBe(afterAppend);
    expect(afterAppend).toBe(before);
    expect(kept).toEqual(appended.state);
  } finally {
    await inner.close();
  }
});

test("a kept state equals a full replay after every append of a recorded run", async () => {
  const root = await tempRoot();
  const storeRoot = join(root, "store");
  const log = openLog({
    backend: "sqlite",
    path: join(storeRoot, "log.sqlite"),
  });
  try {
    const registry = new PluginRegistry([plugin], {
      home: root,
      storeRoot,
      store: new MemoryPluginStore({ root: storeRoot }),
    });
    const found = registry.flow("simple");
    if (found === undefined) throw new Error("missing simple flow");
    const recordedRun = await log.startRun("simple", "job:1");
    const runner = new Runner({
      log,
      flow: found.flow,
      runId: recordedRun.runId,
      registry,
      lockRoot: storeRoot,
      object: { type: "job", id: "1" },
    });
    expect(await runner.run()).toBe("ended");
    const recorded = await collect(log.read(recordedRun.runId));
    expect(recorded.length).toBeGreaterThan(0);

    const target = await log.startRun("simple", "job:2");
    await readState(log, target.runId);
    for (const fact of recorded) {
      const info = await log.run(target.runId);
      await log.append(target.runId, info?.lastSeq ?? 0, [
        { kind: fact.kind, payload: fact.payload, cause: fact.cause },
      ]);
      expect(await readState(log, target.runId)).toEqual(
        replay(await collect(log.read(target.runId))),
      );
    }
  } finally {
    await log.close();
  }
});

test("the kept state follows a run that grows through two processes", async () => {
  const root = await tempRoot();
  const path = join(root, "log.sqlite");
  const log = openLog({ backend: "sqlite", path });
  try {
    const run = await log.startRun("incremental", "job:1");
    await log.append(run.runId, 0, [
      { kind: "run_started", payload: { flow: "incremental" }, cause: 1 },
    ]);
    const first = await readState(log, run.runId);
    expect(first).toEqual(replay(await collect(log.read(run.runId))));

    expect(await appendInChild(path, run.runId, "step_started", { effectId: "one" })).toBe(
      2,
    );
    const second = await readState(log, run.runId);
    expect(second.effectStarted).toBe("one");
    expect(second).toEqual(replay(await collect(log.read(run.runId))));

    const parent = await log.run(run.runId);
    await log.append(run.runId, parent?.lastSeq ?? 0, [
      { kind: "step_interrupted", payload: { effectId: "one" }, cause: 1 },
    ]);
    const third = await readState(log, run.runId);
    expect(third.effectStarted).toBeNull();
    expect(third).toEqual(replay(await collect(log.read(run.runId))));

    expect(
      await appendInChild(path, run.runId, "visit_limit_reached", { step: "work" }),
    ).toBe(4);
    const fourth = await readState(log, run.runId);
    expect(fourth).toEqual(replay(await collect(log.read(run.runId))));
  } finally {
    await log.close();
  }
});
