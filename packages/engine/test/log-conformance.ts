import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  ActiveRunError,
  InvalidPayloadError,
  RunEndedError,
  RunNotFoundError,
  SCHEMA_VERSION,
  SchemaVersionError,
  SecretSerializationError,
  SeqConflictError,
  secret,
  type Fact,
  type GlobalFact,
  type InputOutcome,
  type JsonValue,
  type LogBackend,
  type LogBackendFactory,
  type LogBackendOptions,
} from "../src/index.ts";

/**
 * What a backend must expose to be checked by the suite. The extra methods are
 * test hooks: deleting a run and reading a schema version have no place in the
 * backend interface, but the suite has to simulate them.
 */
export interface LogConformanceFactory extends LogBackendFactory {
  /** The module a child process can import; its default export is the factory. */
  readonly modulePath: string;
  readSchemaVersion(directory: string): number | undefined;
  writeSchemaVersion(directory: string, version: number): void;
  removeRun(directory: string, runId: string): void;
  countInputRecords(directory: string): number;
  /** All text the backend stored, so a test can look for a leaked secret. */
  storedText(directory: string, runId: string): string;
  /**
   * Fault injection into a backend that stores one append-only file per run.
   * A backend whose storage cannot hold a torn record (sqlite) leaves this
   * out, and the torn-line test is not registered for it.
   */
  readonly rawRun?: RawRunFile;
}

export interface RawRunFile {
  size(directory: string, runId: string): number;
  append(directory: string, runId: string, text: string): void;
}

const CHILD = join(import.meta.dir, "fixtures", "log-child.ts");
const TEST_ROOT = resolve(import.meta.dir, "..", "..", "..", ".radian", "test-tmp");

function tempDirectory(label: string): string {
  const directory = join(TEST_ROOT, `${label}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function cleanup(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

function fixedClock(value = 1_700_000_000_000): () => number {
  return () => value;
}

async function openStore(
  factory: LogBackendFactory,
  directory: string,
  options?: LogBackendOptions,
): Promise<LogBackend> {
  return await factory.open(directory, options);
}

async function collect(facts: AsyncIterable<Fact>): Promise<Fact[]> {
  const result: Fact[] = [];
  for await (const fact of facts) result.push(fact);
  return result;
}

async function collectGlobal(
  facts: AsyncIterable<GlobalFact>,
): Promise<GlobalFact[]> {
  const result: GlobalFact[] = [];
  for await (const fact of facts) result.push(fact);
  return result;
}

async function collectOutcomes(
  outcomes: AsyncIterable<InputOutcome>,
): Promise<InputOutcome[]> {
  const result: InputOutcome[] = [];
  for await (const outcome of outcomes) result.push(outcome);
  return result;
}

async function captureError(action: () => unknown): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("expected the action to fail");
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolveTimeout, rejectTimeout) => {
    const timer = setTimeout(() => rejectTimeout(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveTimeout(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectTimeout(error);
      },
    );
  });
}

/** A fixed-seed generator, so a failing crash run can be reproduced. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface LineReader {
  next(): Promise<string | null>;
  cancel(): Promise<void>;
}

function lineReader(stream: ReadableStream<Uint8Array>): LineReader {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  return {
    async next(): Promise<string | null> {
      while (true) {
        const newline = pending.indexOf("\n");
        if (newline >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          return line;
        }
        const { value, done } = await reader.read();
        if (done) {
          if (pending.length === 0) return null;
          const line = pending;
          pending = "";
          return line;
        }
        pending += decoder.decode(value, { stream: true });
      }
    },
    async cancel(): Promise<void> {
      await reader.cancel();
    },
  };
}

function spawnChild(mode: string, environment: Record<string, string>): {
  proc: ReturnType<typeof Bun.spawn>;
  lines: LineReader;
} {
  const proc = Bun.spawn([process.execPath, CHILD, mode], {
    cwd: TEST_ROOT,
    env: { ...process.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { proc, lines: lineReader(proc.stdout) };
}

async function readStderr(proc: ReturnType<typeof Bun.spawn>): Promise<string> {
  const stream = proc.stderr;
  if (stream instanceof ReadableStream) return await new Response(stream).text();
  return "";
}

interface ChildResult {
  readonly ok: boolean;
  readonly name?: string;
  readonly message?: string;
}

async function runChild(mode: string, environment: Record<string, string>): Promise<ChildResult> {
  const { proc, lines } = spawnChild(mode, environment);
  const line = await withTimeout(lines.next(), 15_000, `child ${mode} produced no output`);
  const exitCode = await proc.exited;
  const stderr = await readStderr(proc);
  if (line === null) {
    throw new Error(`child ${mode} exited ${exitCode} without a result: ${stderr}`);
  }
  return JSON.parse(line) as ChildResult;
}

function assertWholeBatches(facts: readonly Fact[]): void {
  const seenTokens = new Set<string>();
  let previousToken: string | null = null;
  const batches = new Map<string, { index: number; count: number }[]>();

  facts.forEach((fact, position) => {
    expect(fact.seq).toBe(position + 1);
    expect(fact.kind).toBe("crash");

    const payload = fact.payload as {
      token?: unknown;
      index?: unknown;
      count?: unknown;
    };
    expect(typeof payload.token).toBe("string");
    expect(Number.isInteger(payload.index)).toBe(true);
    expect(Number.isInteger(payload.count)).toBe(true);

    const token = payload.token as string;
    const index = payload.index as number;
    const count = payload.count as number;

    if (token !== previousToken) {
      expect(seenTokens.has(token)).toBe(false);
      seenTokens.add(token);
      previousToken = token;
    }
    const entries = batches.get(token) ?? [];
    entries.push({ index, count });
    batches.set(token, entries);
  });

  for (const entries of batches.values()) {
    entries.sort((left, right) => left.index - right.index);
    const first = entries[0];
    if (!first) throw new Error("a batch had no facts");
    expect(entries.length).toBe(first.count);
    entries.forEach((entry, index) => expect(entry.index).toBe(index));
  }
}

export function runLogConformance(factory: LogConformanceFactory): void {
  mkdirSync(TEST_ROOT, { recursive: true });

  describe(`log backend: ${factory.name}`, () => {
    test("startRun keeps one active run per flow and object", async () => {
      const directory = tempDirectory("active-run");
      const backend = await openStore(factory, directory, { clock: fixedClock() });
      try {
        const first = await backend.startRun("flow-a", "object-a");
        expect(first.active).toBe(true);
        expect(first.lastSeq).toBe(0);
        expect(first.startedAt).toBe(1_700_000_000_000);

        expect(await backend.startRun("flow-a", "object-b")).toBeDefined();
        expect(await captureError(() => backend.startRun("flow-a", "object-a"))).toBeInstanceOf(
          ActiveRunError,
        );

        const active = await backend.runs({ active: true });
        expect(active.map((run) => run.object).sort()).toEqual(["object-a", "object-b"]);

        await backend.endRun(first.runId);
        const afterEnd = await backend.runs({ active: true });
        expect(afterEnd.map((run) => run.object)).toEqual(["object-b"]);

        const all = await backend.runs();
        const ended = all.find((run) => run.runId === first.runId);
        expect(ended?.active).toBe(false);
        expect(typeof ended?.endedAt).toBe("number");

        const restarted = await backend.startRun("flow-a", "object-a");
        expect(restarted.runId).not.toBe(first.runId);
      } finally {
        await backend.close();
        cleanup(directory);
      }
    });

    test("startRun keeps the input that made the run", async () => {
      const directory = tempDirectory("start-input");
      const backend = await openStore(factory, directory, { clock: fixedClock() });
      try {
        const run = await backend.startRun("flow", "object", "input_event");
        expect(run.startInputId).toBe("input_event");

        const listed = (await backend.runs()).find(
          (candidate) => candidate.runId === run.runId,
        );
        expect(listed?.startInputId).toBe("input_event");

        const plain = await backend.startRun("flow", "plain", "input_plain");
        expect(plain.startInputId).toBe("input_plain");
        const second = await backend.startRun("flow", "other");
        expect(second.startInputId).toBeNull();
      } finally {
        await backend.close();
        cleanup(directory);
      }
    });

    test("endRun is idempotent, unknown runs fail, and an ended run takes no facts", async () => {
      const directory = tempDirectory("end-run");
      const backend = await openStore(factory, directory, { clock: fixedClock() });
      try {
        const run = await backend.startRun("flow", "object");
        await backend.endRun(run.runId);
        await backend.endRun(run.runId);

        expect(await captureError(() => backend.endRun("does-not-exist"))).toBeInstanceOf(
          RunNotFoundError,
        );
        expect(
          await captureError(() =>
            backend.append(run.runId, 0, [{ kind: "late", payload: {}, cause: 1 }]),
          ),
        ).toBeInstanceOf(RunEndedError);
      } finally {
        await backend.close();
        cleanup(directory);
      }
    });

    test("recordInput stores one record per (source, sourceKey)", async () => {
      const directory = tempDirectory("inputs");
      let backend = await openStore(factory, directory, { clock: fixedClock() });
      try {
        const run = await backend.startRun("flow", "object");
        const first = await backend.recordInput(run.runId, "github", "issue:1", { title: "one" });
        expect(first.duplicate).toBe(false);

        const duplicate = await backend.recordInput(run.runId, "github", "issue:1", {
          title: "changed",
        });
        expect(duplicate.duplicate).toBe(true);
        expect(duplicate.inputId).toBe(first.inputId);

        expect((await backend.recordInput(run.runId, "github", "issue:2", {})).duplicate).toBe(
          false,
        );
        expect((await backend.recordInput(run.runId, "ci", "issue:1", {})).duplicate).toBe(false);
        expect(factory.countInputRecords(directory)).toBe(3);

        await backend.close();
        backend = await openStore(factory, directory, { clock: fixedClock() });
        const afterReopen = await backend.recordInput(run.runId, "github", "issue:1", {
          title: "changed",
        });
        expect(afterReopen.duplicate).toBe(true);
        expect(factory.countInputRecords(directory)).toBe(3);

        expect(
          await captureError(() => backend.recordInput("missing-run", "github", "issue:3", {})),
        ).toBeInstanceOf(RunNotFoundError);
      } finally {
        await backend.close();
        cleanup(directory);
      }
    });

    test("recordInput dedupes across two open backends", async () => {
      const directory = tempDirectory("inputs-live");
      const first = await openStore(factory, directory, { clock: fixedClock() });
      const second = await openStore(factory, directory, { clock: fixedClock() });
      try {
        const run = await first.startRun("flow", "object");
        const stored = await first.recordInput(run.runId, "github", "issue:9", {});
        expect(stored.duplicate).toBe(false);

        const duplicate = await second.recordInput(run.runId, "github", "issue:9", {});
        expect(duplicate.duplicate).toBe(true);
        expect(duplicate.inputId).toBe(stored.inputId);

        const other = await second.recordInput(run.runId, "github", "issue:10", {});
        expect(other.duplicate).toBe(false);
        expect((await first.recordInput(run.runId, "github", "issue:10", {})).duplicate).toBe(true);
        expect(factory.countInputRecords(directory)).toBe(2);
      } finally {
        await first.close();
        await second.close();
        cleanup(directory);
      }
    });

    test("recordOutcome keeps the first outcome per (inputId, kind)", async () => {
      const directory = tempDirectory("outcomes");
      let backend = await openStore(factory, directory, { clock: fixedClock() });
      try {
        const input = await backend.recordInput(null, "github", "issue:1", {});
        const first = await backend.recordOutcome(input.inputId, "observed", { at: 1 });
        expect(first.duplicate).toBe(false);
        expect(first.outcome.payload).toEqual({ at: 1 });

        const duplicate = await backend.recordOutcome(input.inputId, "observed", { at: 2 });
        expect(duplicate.duplicate).toBe(true);
        expect(duplicate.outcome.payload).toEqual({ at: 1 });

        // A different kind is a later outcome for the same input.
        const candidate = await backend.recordOutcome(input.inputId, "candidate", { flow: "one" });
        expect(candidate.duplicate).toBe(false);
        expect((await collectOutcomes(backend.readOutcomes())).map((item) => item.kind).sort()).toEqual(
          ["candidate", "observed"],
        );

        await backend.close();
        backend = await openStore(factory, directory, { clock: fixedClock() });
        const afterReopen = await backend.recordOutcome(input.inputId, "observed", { at: 3 });
        expect(afterReopen.duplicate).toBe(true);
        expect(afterReopen.outcome.payload).toEqual({ at: 1 });
        expect(await collectOutcomes(backend.readOutcomes())).toHaveLength(2);
      } finally {
        await backend.close();
        cleanup(directory);
      }
    });

    test("recordOutcome keeps one outcome across two open backends", async () => {
      const directory = tempDirectory("outcomes-live");
      const first = await openStore(factory, directory, { clock: fixedClock() });
      const second = await openStore(factory, directory, { clock: fixedClock() });
      try {
        const input = await first.recordInput(null, "github", "issue:9", {});
        const stored = await first.recordOutcome(input.inputId, "observed", { by: "first" });
        expect(stored.duplicate).toBe(false);

        const duplicate = await second.recordOutcome(input.inputId, "observed", { by: "second" });
        expect(duplicate.duplicate).toBe(true);
        expect(duplicate.outcome.payload).toEqual({ by: "first" });
        expect(await collectOutcomes(second.readOutcomes())).toHaveLength(1);
      } finally {
        await first.close();
        await second.close();
        cleanup(directory);
      }
    });

    test("global facts keep their order across reopen", async () => {
      const directory = tempDirectory("global-facts");
      let backend = await openStore(factory, directory, { clock: fixedClock() });
      try {
        const first = await backend.appendGlobal({
          kind: "trigger_observed",
          payload: { reason: "would start one on job:1" },
          cause: "input-one",
        });
        expect(first.seq).toBe(1);
        await backend.appendGlobal({
          kind: "trigger_skipped",
          payload: { reason: "too deep" },
          cause: "input-two",
        });

        await backend.close();
        backend = await openStore(factory, directory, { clock: fixedClock() });
        const facts = await collectGlobal(backend.readGlobal());
        expect(facts.map((fact) => fact.kind)).toEqual([
          "trigger_observed",
          "trigger_skipped",
        ]);
        expect(facts.map((fact) => fact.seq)).toEqual([1, 2]);
      } finally {
        await backend.close();
        cleanup(directory);
      }
    });

    test("append assigns sequence numbers, enforces expectedSeq, and accepts an empty batch", async () => {
      const directory = tempDirectory("append");
      let backend = await openStore(factory, directory, { clock: fixedClock(1234) });
      try {
        const run = await backend.startRun("flow", "object");
        const first = await backend.append(run.runId, 0, [
          { kind: "one", payload: { value: 1 }, cause: 1 },
          { kind: "two", payload: { value: 2 }, cause: 1 },
        ]);
        expect(first.lastSeq).toBe(2);
        expect(first.facts.map((fact) => fact.seq)).toEqual([1, 2]);
        expect(first.facts[0]?.time).toBe(1234);

        const stale = await captureError(() =>
          backend.append(run.runId, 1, [{ kind: "stale", payload: {}, cause: 1 }]),
        );
        expect(stale).toBeInstanceOf(SeqConflictError);

        const empty = await backend.append(run.runId, 2, []);
        expect(empty.lastSeq).toBe(2);
        expect(empty.facts).toEqual([]);
        expect(
          await captureError(() => backend.append(run.runId, 1, [])),
        ).toBeInstanceOf(SeqConflictError);

        await backend.append(run.runId, 2, [{ kind: "three", payload: {}, cause: 2 }]);
        await backend.close();
        backend = await openStore(factory, directory, { clock: fixedClock(1234) });

        const facts = await collect(backend.read(run.runId));
        expect(facts.map((fact) => fact.kind)).toEqual(["one", "two", "three"]);
        expect(facts.map((fact) => fact.seq)).toEqual([1, 2, 3]);

        expect(
          await captureError(() =>
            backend.append("missing-run", 0, [{ kind: "x", payload: {}, cause: 1 }]),
          ),
        ).toBeInstanceOf(RunNotFoundError);
      } finally {
        await backend.close();
        cleanup(directory);
      }
    });

    test("unicode and nested payloads round-trip", async () => {
      const directory = tempDirectory("payloads");
      const backend = await openStore(factory, directory, { clock: fixedClock() });
      try {
        const run = await backend.startRun("flow", "object");
        const payload: JsonValue = {
          emoji: "🧪🚀",
          chinese: "流程引擎",
          nested: { list: [1, true, null, { deep: "值" }] },
        };
        await backend.append(run.runId, 0, [{ kind: "unicode", payload, cause: 1 }]);
        await backend.close();

        const reopened = await openStore(factory, directory);
        try {
          const facts = await collect(reopened.read(run.runId));
          expect(facts).toHaveLength(1);
          expect(facts[0]?.payload).toEqual(payload);
        } finally {
          await reopened.close();
        }
      } finally {
        await backend.close();
        cleanup(directory);
      }
    });

    test("10 000 facts in one batch stay one contiguous batch", async () => {
      const directory = tempDirectory("large-batch");
      const backend = await openStore(factory, directory, { clock: fixedClock() });
      try {
        const run = await backend.startRun("flow", "object");
        const facts = Array.from({ length: 10_000 }, (_, index) => ({
          kind: `fact-${index}`,
          payload: { index, text: `value ${index}` },
          cause: 1,
        }));
        const result = await backend.append(run.runId, 0, facts);
        expect(result.lastSeq).toBe(10_000);

        const read = await collect(backend.read(run.runId));
        expect(read).toHaveLength(10_000);
        expect(read[0]?.seq).toBe(1);
        expect(read[9_999]?.seq).toBe(10_000);
        expect(read[9_999]?.payload).toEqual({ index: 9_999, text: "value 9999" });
      } finally {
        await backend.close();
        cleanup(directory);
      }
    });

    test("a run file deleted by hand makes read fail without touching other runs", async () => {
      const directory = tempDirectory("deleted-run");
      const backend = await openStore(factory, directory, { clock: fixedClock() });
      try {
        const deleted = await backend.startRun("flow", "deleted");
        const kept = await backend.startRun("flow", "kept");
        await backend.append(deleted.runId, 0, [{ kind: "gone", payload: {}, cause: 1 }]);
        await backend.append(kept.runId, 0, [{ kind: "kept", payload: {}, cause: 1 }]);

        factory.removeRun(directory, deleted.runId);

        expect(await captureError(() => collect(backend.read(deleted.runId)))).toBeInstanceOf(
          RunNotFoundError,
        );
        const keptFacts = await collect(backend.read(kept.runId));
        expect(keptFacts.map((fact) => fact.kind)).toEqual(["kept"]);
        expect((await backend.runs()).map((run) => run.runId)).toEqual([kept.runId]);
      } finally {
        await backend.close();
        cleanup(directory);
      }
    });

    // Only a backend that stores one append-only file per run can hold a torn
    // record. sqlite's transactions cannot, and the SIGKILL test below covers
    // the same whole-batch guarantee for it.
    const rawRun = factory.rawRun;
    if (rawRun) {
      test("a torn last line is cut off on open", async () => {
        const directory = tempDirectory("torn-line");
        let backend = await openStore(factory, directory, { clock: fixedClock() });
        try {
          const run = await backend.startRun("flow", "object");
          await backend.append(run.runId, 0, [{ kind: "whole", payload: {}, cause: 1 }]);
          await backend.close();

          const before = rawRun.size(directory, run.runId);
          rawRun.append(directory, run.runId, '{"type":"batch","facts":[{"runId":');
          expect(rawRun.size(directory, run.runId)).toBeGreaterThan(before);

          backend = await openStore(factory, directory);
          const facts = await collect(backend.read(run.runId));
          expect(facts.map((fact) => fact.kind)).toEqual(["whole"]);
          expect(rawRun.size(directory, run.runId)).toBe(before);
        } finally {
          await backend.close();
          cleanup(directory);
        }
      });
    }

    test("a Secret never reaches the log", async () => {
      const directory = tempDirectory("secrets");
      let backend = await openStore(factory, directory, { clock: fixedClock() });
      try {
        const value = secret("hunter2");
        expect(() => JSON.stringify(value)).toThrow(SecretSerializationError);

        const run = await backend.startRun("flow", "object");
        const error = await captureError(() =>
          backend.append(run.runId, 0, [
            {
              kind: "leak",
              payload: { password: value as unknown as JsonValue },
              cause: 1,
            },
          ]),
        );
        expect(error).toBeInstanceOf(SecretSerializationError);
        expect(await collect(backend.read(run.runId))).toEqual([]);

        await backend.append(run.runId, 0, [{ kind: "safe", payload: {}, cause: 1 }]);
        expect(
          await captureError(() =>
            backend.append(run.runId, 1, [
              { kind: "safe", payload: {}, cause: 1 },
              {
                kind: "leak",
                payload: { password: value as unknown as JsonValue },
                cause: 1,
              },
            ]),
          ),
        ).toBeInstanceOf(SecretSerializationError);
        expect((await collect(backend.read(run.runId))).map((fact) => fact.kind)).toEqual([
          "safe",
        ]);
        expect(factory.storedText(directory, run.runId)).not.toContain("hunter2");

        await backend.close();
        backend = await openStore(factory, directory);
        expect((await collect(backend.read(run.runId))).map((fact) => fact.kind)).toEqual([
          "safe",
        ]);
      } finally {
        await backend.close();
        cleanup(directory);
      }
    });

    test("a payload with a toJSON method is refused and writes nothing", async () => {
      const directory = tempDirectory("to-json");
      let backend = await openStore(factory, directory, { clock: fixedClock() });
      try {
        const run = await backend.startRun("flow", "object");
        const payload: Record<string, JsonValue> = { looks: "plain" };
        Object.defineProperty(payload, "toJSON", {
          value: () => undefined,
          enumerable: false,
        });

        const error = await captureError(() =>
          backend.append(run.runId, 0, [
            { kind: "sneaky", payload: payload as JsonValue, cause: 1 },
          ]),
        );
        expect(error).toBeInstanceOf(InvalidPayloadError);
        expect(await collect(backend.read(run.runId))).toEqual([]);

        await backend.close();
        backend = await openStore(factory, directory);
        expect(await collect(backend.read(run.runId))).toEqual([]);
      } finally {
        await backend.close();
        cleanup(directory);
      }
    });

    test("a newer schema_version is refused with a clear error", async () => {
      const directory = tempDirectory("schema");
      const backend = await openStore(factory, directory);
      await backend.close();

      expect(factory.readSchemaVersion(directory)).toBe(SCHEMA_VERSION);
      factory.writeSchemaVersion(directory, SCHEMA_VERSION + 1);

      const error = await captureError(() => factory.open(directory));
      expect(error).toBeInstanceOf(SchemaVersionError);
      const message = (error as Error).message;
      expect(message).toContain("schema_version");
      expect(message).toContain(String(SCHEMA_VERSION + 1));
      cleanup(directory);
    });

    test("two processes appending to one run: the stale one is refused", async () => {
      const directory = tempDirectory("append-race");
      const backend = await openStore(factory, directory, { clock: fixedClock() });
      let runId: string;
      try {
        const run = await backend.startRun("flow", "object");
        runId = run.runId;
        await backend.append(run.runId, 0, [{ kind: "seed", payload: {}, cause: 1 }]);
      } finally {
        await backend.close();
      }

      const base = {
        OPERAD_LOG_BACKEND_MODULE: factory.modulePath,
        OPERAD_LOG_STORE: directory,
        OPERAD_RUN_ID: runId,
        OPERAD_EXPECTED_SEQ: "1",
      };
      const results = await Promise.all([
        runChild("append-once", { ...base, OPERAD_WHO: "a" }),
        runChild("append-once", { ...base, OPERAD_WHO: "b" }),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      const loser = results.find((result) => !result.ok);
      expect(loser?.name).toBe("SeqConflictError");

      const reopened = await openStore(factory, directory);
      try {
        const facts = await collect(reopened.read(runId));
        expect(facts.map((fact) => fact.kind)).toEqual(["seed", "race"]);
      } finally {
        await reopened.close();
        cleanup(directory);
      }
    });

    test("two processes racing startRun on one pair: exactly one wins", async () => {
      const directory = tempDirectory("start-race");
      const environment = {
        OPERAD_LOG_BACKEND_MODULE: factory.modulePath,
        OPERAD_LOG_STORE: directory,
        OPERAD_FLOW: "race-flow",
        OPERAD_OBJECT: "race-object",
      };
      const results = await Promise.all([
        runChild("start-race", environment),
        runChild("start-race", environment),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      const loser = results.find((result) => !result.ok);
      expect(loser?.name).toBe("ActiveRunError");

      const backend = await openStore(factory, directory);
      try {
        const active = await backend.runs({ active: true });
        expect(active).toHaveLength(1);
        expect(active[0]?.flow).toBe("race-flow");
      } finally {
        await backend.close();
        cleanup(directory);
      }
    });

    test("SIGKILL during appends leaves only whole batches and contiguous seqs", async () => {
      const directory = tempDirectory("crash");
      const seeder = await openStore(factory, directory, { clock: fixedClock() });
      const run = await seeder.startRun("crash-flow", "crash-object");
      await seeder.close();

      const random = mulberry32(0xc0ffee);
      const kills = 50;
      try {
        for (let kill = 0; kill < kills; kill += 1) {
          const { proc, lines } = spawnChild("append-loop", {
            OPERAD_LOG_BACKEND_MODULE: factory.modulePath,
            OPERAD_LOG_STORE: directory,
            OPERAD_RUN_ID: run.runId,
          });

          const first = await withTimeout(
            lines.next(),
            15_000,
            `crash child ${kill} did not append before the timeout`,
          );
          if (first === null) {
            const exitCode = await proc.exited;
            const stderr = await readStderr(proc);
            throw new Error(`crash child ${kill} exited ${exitCode}: ${stderr}`);
          }

          const extra = Math.floor(random() * 5);
          for (let line = 0; line < extra; line += 1) {
            const next = await withTimeout(
              lines.next(),
              15_000,
              `crash child ${kill} stopped producing batches`,
            );
            if (next === null) break;
          }

          // The kill point is the number of batch lines the parent has read,
          // chosen from the fixed seed. No sleep: the signal follows the event.
          proc.kill("SIGKILL");
          await proc.exited;
          await lines.cancel();
          await readStderr(proc);

          const backend = await openStore(factory, directory);
          try {
            const facts = await collect(backend.read(run.runId));
            assertWholeBatches(facts);
          } finally {
            await backend.close();
          }
        }

        const backend = await openStore(factory, directory);
        try {
          const facts = await collect(backend.read(run.runId));
          expect(facts.length).toBeGreaterThan(0);
          await backend.endRun(run.runId);
          const ended = (await backend.runs()).find((info) => info.runId === run.runId);
          expect(ended?.active).toBe(false);
        } finally {
          await backend.close();
        }
      } finally {
        cleanup(directory);
      }
    }, 180_000);
  });
}
