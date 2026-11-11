import type { BigIntStats } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  openAsync,
} from "./file-system.ts";
import {
  ActiveRunError,
  CorruptLogError,
  RunEndedError,
  RunNotFoundError,
  SchemaVersionError,
  SeqConflictError,
  StoreClosedError,
} from "./errors.ts";
import {
  assertExpectedSeq,
  assertName,
  assertRunId,
  inputIdFor,
  validateNewFact,
} from "./facts.ts";
import { assertJsonValue } from "./json-value.ts";
import { SCHEMA_VERSION } from "./schema.ts";
import { assertStoreNotMoving } from "../runner/lock.ts";
import {
  linkExclusive,
  resolveSubscriptionWatch,
  withFileLock,
  type SubscriptionWatch,
} from "../platform/index.ts";
import type {
  AppendResult,
  Fact,
  GlobalFact,
  InputOutcome,
  InputRecord,
  InputsAfter,
  JsonValue,
  LogBackend,
  LogBackendFactory,
  LogBackendOptions,
  LogChange,
  NewFact,
  RecordInputResult,
  RecordOutcomeResult,
  RunInfo,
  RunsOptions,
} from "./types.ts";

const SCHEMA_FILE = "schema.json";
const LOCK_FILE = ".lock";
const RUNS_INDEX_FILE = "runs.index";
const INPUTS_FILE = "inputs.jsonl";
const OUTCOMES_FILE = "outcomes.jsonl";
const GLOBAL_FACTS_FILE = "global-facts.jsonl";
const RUNS_DIR = "runs";
const NEWLINE = 0x0a;

interface RunHeader {
  readonly type: "run";
  readonly schemaVersion: number;
  readonly runId: string;
  readonly flow: string;
  readonly object: string;
  readonly startedAt: number;
  readonly access?: JsonValue | undefined;
  readonly startInputId?: string | null;
}

interface StoredInput {
  readonly type: "input";
  readonly inputId: string;
  readonly runId: string | null;
  readonly source: string;
  readonly sourceKey: string;
  readonly payload: JsonValue;
  readonly time: number;
}

interface StoredGlobalFact {
  readonly type: "global_fact";
  readonly seq: number;
  readonly kind: string;
  readonly payload: JsonValue;
  readonly cause: string | number;
  readonly time: number;
  readonly uniqueKey?: string;
}

interface StoredOutcome {
  readonly type: "outcome";
  readonly inputId: string;
  readonly kind: string;
  readonly payload: JsonValue;
  readonly seq: number;
  readonly time: number;
}

function outcomeKey(inputId: string, kind: string): string {
  return `${inputId}\u0000${kind}`;
}

function parseOutcomeLine(line: string): StoredOutcome | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Partial<StoredOutcome>;
  if (record.type !== "outcome" || typeof record.inputId !== "string") {
    return undefined;
  }
  if (typeof record.kind !== "string" || record.kind.length === 0) return undefined;
  if (typeof record.seq !== "number" || !Number.isInteger(record.seq)) return undefined;
  if (typeof record.time !== "number") return undefined;
  return record as StoredOutcome;
}

interface EndMarker {
  readonly endedAt: number;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeAllSync(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset, null);
    if (written <= 0) throw new Error("write returned no bytes");
    offset += written;
  }
}

function readAllAtSync(fd: number, buffer: Buffer, position: number): void {
  let offset = 0;
  while (offset < buffer.length) {
    const read = readSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (read === 0) throw new Error("unexpected end of file");
    offset += read;
  }
}

function writeFileSynced(path: string, contents: string): void {
  const fd = openSync(path, "w");
  try {
    writeAllSync(fd, Buffer.from(contents, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    try {
      fsyncSync(fd);
    } catch (error) {
      if (!isErrno(error, "EINVAL") && !isErrno(error, "EPERM")) throw error;
    }
  } finally {
    closeSync(fd);
  }
}

/** Create `path` with `contents`, but never replace an existing file. */
function createExclusive(path: string, contents: string): boolean {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSynced(temporary, contents);
  try {
    return linkExclusive(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Append `line` as one write and fsync it. If the write itself fails, put the
 * file back where it was so a failed batch leaves no trace.
 */
function appendLineSynced(path: string, line: string): void {
  const data = Buffer.from(line, "utf8");
  const fd = openSync(path, "a");
  let originalSize: number | undefined;
  try {
    originalSize = fstatSync(fd).size;
    writeAllSync(fd, data);
    fsyncSync(fd);
  } catch (error) {
    if (originalSize !== undefined) {
      try {
        ftruncateSync(fd, originalSize);
        fsyncSync(fd);
      } catch {
        // The next open cuts the torn line off anyway.
      }
    }
    throw error;
  } finally {
    closeSync(fd);
  }
}

/** Return the index of the last `byte` at or before `from`, or -1. */
function findLastByte(fd: number, from: number, byte: number): number {
  let position = from;
  const chunkSize = 64 * 1024;
  while (position >= 0) {
    const start = Math.max(0, position - chunkSize + 1);
    const length = position - start + 1;
    const buffer = Buffer.allocUnsafe(length);
    readAllAtSync(fd, buffer, start);
    const index = buffer.lastIndexOf(byte);
    if (index >= 0) return start + index;
    position = start - 1;
  }
  return -1;
}

/** Cut off bytes after the last newline. */
function truncateTornLine(path: string): void {
  if (!existsSync(path)) return;
  const fd = openSync(path, "r+");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return;
    const last = Buffer.allocUnsafe(1);
    readAllAtSync(fd, last, size - 1);
    if (last[0] === NEWLINE) return;
    const newline = findLastByte(fd, size - 1, NEWLINE);
    ftruncateSync(fd, newline < 0 ? 0 : newline + 1);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The last complete line in a file, ignoring a torn final line. */
function readLastLine(path: string): string | null {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return null;

    const last = Buffer.allocUnsafe(1);
    readAllAtSync(fd, last, size - 1);

    let endExclusive: number;
    if (last[0] === NEWLINE) {
      endExclusive = size - 1;
    } else {
      const newline = findLastByte(fd, size - 1, NEWLINE);
      if (newline < 0) return null;
      endExclusive = newline;
    }
    if (endExclusive <= 0) return null;

    const previous = findLastByte(fd, endExclusive - 1, NEWLINE);
    const start = previous + 1;
    const length = endExclusive - start;
    if (length <= 0) return null;

    const buffer = Buffer.allocUnsafe(length);
    readAllAtSync(fd, buffer, start);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function readFirstLine(path: string): string | null {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return null;
    const buffer = Buffer.allocUnsafe(8192);
    const decoder = new TextDecoder();
    let text = "";
    let position = 0;
    while (position < size) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
      if (read === 0) break;
      position += read;
      text += decoder.decode(buffer.subarray(0, read), { stream: true });
      const newline = text.indexOf("\n");
      if (newline >= 0) return text.slice(0, newline);
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

function parseHeader(value: unknown, runId: string): RunHeader {
  if (typeof value !== "object" || value === null) {
    throw new CorruptLogError(runId, "the header is not an object");
  }
  const record = value as Record<string, unknown>;
  if (record.type !== "run") throw new CorruptLogError(runId, "the first line is not a run header");
  if (record.runId !== runId) throw new CorruptLogError(runId, "the header names another run");
  if (
    typeof record.flow !== "string" ||
    typeof record.object !== "string" ||
    typeof record.startedAt !== "number" ||
    !Number.isFinite(record.startedAt)
  ) {
    throw new CorruptLogError(runId, "the header is missing flow, object or startedAt");
  }
  return {
    type: "run",
    schemaVersion: typeof record.schemaVersion === "number" ? record.schemaVersion : SCHEMA_VERSION,
    runId,
    flow: record.flow,
    object: record.object,
    startedAt: record.startedAt,
    ...(record.access === undefined
      ? {}
      : { access: record.access as JsonValue }),
    startInputId:
      typeof record.startInputId === "string" ? record.startInputId : null,
  };
}

function parseFact(value: unknown, runId: string): Fact {
  if (typeof value !== "object" || value === null) {
    throw new CorruptLogError(runId, "a fact is not an object");
  }
  const record = value as Record<string, unknown>;
  if (record.runId !== runId) throw new CorruptLogError(runId, "a fact names another run");
  if (!Number.isInteger(record.seq) || (record.seq as number) < 1) {
    throw new CorruptLogError(runId, "a fact has no valid sequence number");
  }
  if (typeof record.kind !== "string") throw new CorruptLogError(runId, "a fact has no kind");
  if (typeof record.cause !== "number" && typeof record.cause !== "string") {
    throw new CorruptLogError(runId, "a fact has no cause");
  }
  if (typeof record.time !== "number" || !Number.isFinite(record.time)) {
    throw new CorruptLogError(runId, "a fact has no time");
  }
  if (!Object.hasOwn(record, "payload")) throw new CorruptLogError(runId, "a fact has no payload");
  try {
    assertJsonValue(record.payload, "fact payload");
  } catch {
    throw new CorruptLogError(runId, "a fact payload is not JSON");
  }
  return {
    runId,
    seq: record.seq as number,
    kind: record.kind,
    payload: record.payload,
    cause: record.cause,
    time: record.time,
  };
}

function parseBatch(value: unknown, runId: string): Fact[] {
  if (typeof value !== "object" || value === null) {
    throw new CorruptLogError(runId, "a batch is not an object");
  }
  const record = value as Record<string, unknown>;
  if (record.type !== "batch" || !Array.isArray(record.facts)) {
    throw new CorruptLogError(runId, "a batch has no facts array");
  }
  return record.facts.map((fact) => parseFact(fact, runId));
}

function parseLine(line: string, runId: string): RunHeader | Fact[] {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new CorruptLogError(runId, "a line is not JSON");
  }
  if (typeof value !== "object" || value === null) {
    throw new CorruptLogError(runId, "a line is not an object");
  }
  const type = (value as { type?: unknown }).type;
  if (type === "run") return parseHeader(value, runId);
  if (type === "batch") return parseBatch(value, runId);
  throw new CorruptLogError(runId, `unknown record type ${String(type)}`);
}

function parseGlobalFactLine(line: string): StoredGlobalFact {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new CorruptLogError("global", "a global fact line is not JSON");
  }
  if (typeof value !== "object" || value === null) {
    throw new CorruptLogError("global", "a global fact line is not an object");
  }
  const record = value as Partial<StoredGlobalFact>;
  if (record.type !== "global_fact") {
    throw new CorruptLogError("global", "a global fact line has no type");
  }
  if (!Number.isInteger(record.seq) || (record.seq as number) < 1) {
    throw new CorruptLogError("global", "a global fact has no valid sequence number");
  }
  if (typeof record.kind !== "string" || record.kind.length === 0) {
    throw new CorruptLogError("global", "a global fact has no kind");
  }
  if (typeof record.cause !== "number" && typeof record.cause !== "string") {
    throw new CorruptLogError("global", "a global fact has no cause");
  }
  if (typeof record.time !== "number" || !Number.isFinite(record.time)) {
    throw new CorruptLogError("global", "a global fact has no time");
  }
  if (record.uniqueKey !== undefined && typeof record.uniqueKey !== "string") {
    throw new CorruptLogError("global", "a global fact has an invalid unique key");
  }
  return record as StoredGlobalFact;
}

function globalFactOf(stored: StoredGlobalFact): GlobalFact {
  return {
    seq: stored.seq,
    kind: stored.kind,
    payload: stored.payload,
    cause: stored.cause,
    time: stored.time,
    ...(stored.uniqueKey === undefined ? {} : { uniqueKey: stored.uniqueKey }),
  };
}

function inputOfLine(line: string): InputRecord | undefined {
  if (line.length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Partial<StoredInput>;
  if (
    record.type !== "input" ||
    typeof record.inputId !== "string" ||
    typeof record.source !== "string" ||
    typeof record.sourceKey !== "string"
  ) {
    return undefined;
  }
  return {
    inputId: record.inputId,
    runId: typeof record.runId === "string" ? record.runId : null,
    source: record.source,
    sourceKey: record.sourceKey,
    payload: (record.payload ?? null) as JsonValue,
    time: typeof record.time === "number" ? record.time : 0,
  };
}

class JsonlLogBackend implements LogBackend {
  readonly #directory: string;
  readonly #runsDirectory: string;
  readonly #inputsPath: string;
  readonly #indexPath: string;
  readonly #outcomesPath: string;
  readonly #globalFactsPath: string;
  readonly #lockPath: string;
  readonly #clock: () => number;
  readonly #newRunId: () => string;
  readonly #subscriptionWatch: SubscriptionWatch;
  /** Where each input's line lies in the inputs file, by input id. */
  readonly #inputIds = new Map<string, { readonly start: number; readonly length: number }>();
  #inputBytes = 0;
  readonly #outcomes = new Map<string, StoredOutcome>();
  /** The same outcomes in sequence order, so a reader can start after a cursor. */
  #outcomeList: StoredOutcome[] = [];
  /** The runs index, read up to `#indexBytes`, and the runs it says are active. */
  #indexBytes = 0;
  #indexIno: bigint | undefined;
  readonly #activeIds = new Set<string>();
  #outcomeSeq = 0;
  #outcomeBytes = 0;
  #closed = false;
  #stopWatch: (() => void) | undefined;
  #stopPoll: (() => void) | undefined;
  #snapshot: Map<string, { readonly size: number; readonly ended: boolean }> | undefined;
  readonly #listeners = new Set<(change: LogChange) => void>();

  constructor(
    directory: string,
    clock: () => number,
    newRunId: () => string,
    subscriptionWatch: SubscriptionWatch,
  ) {
    this.#directory = directory;
    this.#runsDirectory = join(directory, RUNS_DIR);
    this.#inputsPath = join(directory, INPUTS_FILE);
    this.#indexPath = join(directory, RUNS_INDEX_FILE);
    this.#outcomesPath = join(directory, OUTCOMES_FILE);
    this.#globalFactsPath = join(directory, GLOBAL_FACTS_FILE);
    this.#lockPath = join(directory, LOCK_FILE);
    this.#clock = clock;
    this.#newRunId = newRunId;
    this.#subscriptionWatch = subscriptionWatch;
  }

  async startRun(
    flow: string,
    object: string,
    startInputId: string | null = null,
    access?: JsonValue,
  ): Promise<RunInfo> {
    assertName(flow, "flow");
    assertName(object, "object");
    if (access !== undefined) assertJsonValue(access, "run access");
    return this.#withLock(() => {
      assertStoreNotMoving(this.#directory);
      const active = this.#listRunsUnlocked(true).find(
        (run) => run.flow === flow && run.object === object,
      );
      if (active) throw new ActiveRunError(flow, object, active.runId);

      const runId = this.#newRunId();
      assertRunId(runId);
      const startedAt = this.#clock();
      const header: RunHeader = {
        type: "run",
        schemaVersion: SCHEMA_VERSION,
        runId,
        flow,
        object,
        startedAt,
        ...(access === undefined ? {} : { access }),
        startInputId,
      };
      // Indexed before the file exists: a crash between the two leaves an id
      // with no run, which a listing skips; the other order would hide a run.
      this.#syncActiveUnlocked();
      appendLineSynced(this.#indexPath, `s ${runId}\n`);
      if (!createExclusive(this.#runPath(runId), `${JSON.stringify(header)}\n`)) {
        throw new Error(`run id ${runId} already exists`);
      }
      fsyncDirectory(this.#runsDirectory);
      this.#syncActiveUnlocked();
      this.#notify({ runId, object });
      return {
        runId,
        flow,
        object,
        active: true,
        startedAt,
        endedAt: null,
        lastSeq: 0,
        ...(access === undefined ? {} : { access }),
        startInputId,
      };
    });
  }

  async endRun(runId: string): Promise<void> {
    assertRunId(runId);
    this.#withLock(() => {
      assertStoreNotMoving(this.#directory);
      const path = this.#runPath(runId);
      if (!existsSync(path)) throw new RunNotFoundError(runId);
      const endPath = this.#endPath(runId);
      if (existsSync(endPath)) return;
      const info = this.#runInfoUnlocked(runId);
      const marker: EndMarker = { endedAt: this.#clock() };
      writeFileSynced(endPath, `${JSON.stringify(marker)}\n`);
      fsyncDirectory(this.#runsDirectory);
      // After the marker: a crash between the two leaves an id the listing
      // finds ended and drops.
      appendLineSynced(this.#indexPath, `e ${runId}\n`);
      this.#syncActiveUnlocked();
      this.#notify({ runId, object: info.object });
    });
  }

  async recordInput(
    runId: string | null,
    source: string,
    sourceKey: string,
    payload: JsonValue,
  ): Promise<RecordInputResult> {
    if (runId !== null) assertRunId(runId);
    assertName(source, "source");
    assertName(sourceKey, "sourceKey");
    assertJsonValue(payload, "input payload");
    return this.#withLock(() => {
      assertStoreNotMoving(this.#directory);
      if (runId !== null) {
        const info = this.#runInfoUnlocked(runId);
        if (!info.active) throw new RunEndedError(runId);
      }
      this.#refreshInputsUnlocked();

      const inputId = inputIdFor(source, sourceKey);
      if (this.#inputIds.has(inputId)) {
        return { duplicate: true, inputId };
      }

      const record: StoredInput = {
        type: "input",
        inputId,
        runId,
        source,
        sourceKey,
        payload,
        time: this.#clock(),
      };
      const line = `${JSON.stringify(record)}\n`;
      const start = this.#inputBytes;
      appendLineSynced(this.#inputsPath, line);
      this.#inputIds.set(inputId, { start, length: Buffer.byteLength(line) });
      this.#inputBytes = statSync(this.#inputsPath).size;
      return { duplicate: false, inputId };
    });
  }

  async *readInputs(): AsyncGenerator<InputRecord> {
    this.#assertOpen();
    if (!existsSync(this.#inputsPath)) return;
    const text = readFileSync(this.#inputsPath).toString("utf8");
    for (const line of text.split("\n")) {
      const record = inputOfLine(line);
      if (record !== undefined) yield record;
    }
  }

  async readInputsAfter(position: number): Promise<InputsAfter> {
    this.#assertOpen();
    if (!existsSync(this.#inputsPath)) return { inputs: [], position: 0 };
    const size = statSync(this.#inputsPath).size;
    // A file shorter than the position was replaced: read it from the start.
    const from = position > size ? 0 : position;
    if (from === size) return { inputs: [], position: from };
    const fd = openSync(this.#inputsPath, "r");
    let chunk: Buffer;
    try {
      chunk = Buffer.allocUnsafe(size - from);
      readAllAtSync(fd, chunk, from);
    } finally {
      closeSync(fd);
    }
    // Only whole lines count; a torn last line is read again next time.
    const end = chunk.lastIndexOf(0x0a) + 1;
    const inputs: InputRecord[] = [];
    for (const line of chunk.subarray(0, end).toString("utf8").split("\n")) {
      const record = inputOfLine(line);
      if (record !== undefined) inputs.push(record);
    }
    return { inputs, position: from + end };
  }

  async findInput(inputId: string): Promise<InputRecord | undefined> {
    this.#assertOpen();
    // The remembered place of the line is read, not the whole history.
    return this.#withLock(() => {
      this.#refreshInputsUnlocked();
      const place = this.#inputIds.get(inputId);
      if (place === undefined) return undefined;
      const fd = openSync(this.#inputsPath, "r");
      try {
        const buffer = Buffer.allocUnsafe(place.length);
        readAllAtSync(fd, buffer, place.start);
        return inputOfLine(buffer.toString("utf8").trimEnd());
      } finally {
        closeSync(fd);
      }
    });
  }

  async readOutcome(
    inputId: string,
    kind: string,
  ): Promise<InputOutcome | undefined> {
    this.#assertOpen();
    return this.#withLock(() => {
      this.#refreshOutcomesUnlocked();
      const stored = this.#outcomes.get(outcomeKey(inputId, kind));
      return stored === undefined ? undefined : this.#asOutcome(stored);
    });
  }

  async readOutcomesAfter(seq: number): Promise<InputOutcome[]> {
    this.#assertOpen();
    return this.#withLock(() => {
      this.#refreshOutcomesUnlocked();
      const list = this.#outcomeList;
      // The first outcome above the cursor, by bisection: a pass with nothing
      // new looks at one entry, not at every outcome ever recorded.
      let low = 0;
      let high = list.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        const entry = list[middle];
        if (entry !== undefined && entry.seq > seq) high = middle;
        else low = middle + 1;
      }
      return list.slice(low).map((stored) => this.#asOutcome(stored));
    });
  }

  async recordOutcome(
    inputId: string,
    kind: string,
    payload: JsonValue,
  ): Promise<RecordOutcomeResult> {
    assertName(inputId, "inputId");
    assertName(kind, "outcome kind");
    assertJsonValue(payload, "outcome payload");
    return this.#withLock(() => {
      assertStoreNotMoving(this.#directory);
      this.#refreshOutcomesUnlocked();
      const key = outcomeKey(inputId, kind);
      const existing = this.#outcomes.get(key);
      if (existing !== undefined) {
        return { duplicate: true, outcome: this.#asOutcome(existing) };
      }
      this.#outcomeSeq += 1;
      const stored: StoredOutcome = {
        type: "outcome",
        inputId,
        kind,
        payload,
        seq: this.#outcomeSeq,
        time: this.#clock(),
      };
      appendLineSynced(this.#outcomesPath, `${JSON.stringify(stored)}\n`);
      this.#rememberOutcome(stored);
      this.#outcomeBytes = statSync(this.#outcomesPath).size;
      return { duplicate: false, outcome: this.#asOutcome(stored) };
    });
  }

  async *readOutcomes(): AsyncGenerator<InputOutcome> {
    this.#assertOpen();
    if (!existsSync(this.#outcomesPath)) return;
    const text = readFileSync(this.#outcomesPath).toString("utf8");
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      const stored = parseOutcomeLine(line);
      if (stored === undefined) continue;
      yield this.#asOutcome(stored);
    }
  }

  async append(
    runId: string,
    expectedSeq: number,
    facts: readonly NewFact[],
  ): Promise<AppendResult> {
    assertRunId(runId);
    assertExpectedSeq(expectedSeq);
    for (const fact of facts) validateNewFact(fact);

    return this.#withLock(() => {
      assertStoreNotMoving(this.#directory);
      const path = this.#runPath(runId);
      if (!existsSync(path)) throw new RunNotFoundError(runId);
      const info = this.#runInfoUnlocked(runId);
      if (!info.active) throw new RunEndedError(runId);

      truncateTornLine(path);
      const lastSeq = this.#lastSeqUnlocked(path, runId);
      if (expectedSeq !== lastSeq) {
        throw new SeqConflictError(runId, expectedSeq, lastSeq);
      }
      if (facts.length === 0) {
        return { lastSeq, facts: [] };
      }

      const stored: Fact[] = facts.map((fact, index) => ({
        runId,
        seq: lastSeq + index + 1,
        kind: fact.kind,
        payload: fact.payload,
        cause: fact.cause,
        time: this.#clock(),
      }));
      const line = `${JSON.stringify({ type: "batch", facts: stored })}\n`;
      appendLineSynced(path, line);
      this.#notify({ runId, object: info.object });
      return { lastSeq: lastSeq + stored.length, facts: stored };
    });
  }

  read(runId: string): AsyncIterable<Fact> {
    assertRunId(runId);
    return this.#read(runId);
  }

  async appendGlobal(fact: NewFact, uniqueKey?: string): Promise<GlobalFact> {
    validateNewFact(fact);
    if (uniqueKey !== undefined) assertName(uniqueKey, "uniqueKey");
    return this.#withLock(() => {
      assertStoreNotMoving(this.#directory);
      truncateTornLine(this.#globalFactsPath);
      if (uniqueKey !== undefined) {
        const existing = this.#globalFactWithKeyUnlocked(uniqueKey);
        if (existing !== undefined) return globalFactOf(existing);
      }
      const lastSeq = this.#lastGlobalSeqUnlocked();
      const stored: StoredGlobalFact = {
        type: "global_fact",
        seq: lastSeq + 1,
        kind: fact.kind,
        payload: fact.payload,
        cause: fact.cause,
        time: this.#clock(),
        ...(uniqueKey === undefined ? {} : { uniqueKey }),
      };
      appendLineSynced(this.#globalFactsPath, `${JSON.stringify(stored)}\n`);
      return globalFactOf(stored);
    });
  }

  /** The global fact a unique key already holds, read under the append lock. */
  #globalFactWithKeyUnlocked(uniqueKey: string): StoredGlobalFact | undefined {
    if (!existsSync(this.#globalFactsPath)) return undefined;
    const text = readFileSync(this.#globalFactsPath).toString("utf8");
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      const stored = parseGlobalFactLine(line);
      if (stored.uniqueKey === uniqueKey) return stored;
    }
    return undefined;
  }

  readGlobal(): AsyncIterable<GlobalFact> {
    return this.#readGlobal();
  }

  async runs(options: RunsOptions = {}): Promise<RunInfo[]> {
    return this.#withLock(() => this.#listRunsUnlocked(options.active === true));
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#stopNotifications();
    this.#inputIds.clear();
    this.#outcomes.clear();
    this.#listeners.clear();
  }

  /** Tells a listener in this process when a run changes. */
  subscribe(listener: (change: LogChange) => void): () => void {
    this.#listeners.add(listener);
    if (this.#stopWatch === undefined) {
      this.#snapshot = this.#takeRunSnapshot();
      this.#stopWatch = this.#subscriptionWatch.watch(this.#runsDirectory, () => {
        this.#notifyExternal();
      });
      // The watch is the fast path. This timer also stats the run files, so a
      // change the platform does not report still reaches a listener.
      this.#stopPoll = this.#subscriptionWatch.repeat(this.#subscriptionWatch.pollMs, () => {
        this.#notifyExternal();
      });
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#stopNotifications();
    };
  }

  #stopNotifications(): void {
    this.#stopWatch?.();
    this.#stopWatch = undefined;
    this.#stopPoll?.();
    this.#stopPoll = undefined;
    this.#snapshot = undefined;
  }

  #notify(change: LogChange): void {
    for (const listener of this.#listeners) listener(change);
  }

  /**
   * Reports files another process changed. The directory is flat, so one scan
   * after any event finds a new run, an appended batch and an end marker,
   * whatever name the platform reports for the change.
   */
  #notifyExternal(): void {
    if (this.#closed) return;
    let next: Map<string, { readonly size: number; readonly ended: boolean }>;
    try {
      next = this.#takeRunSnapshot();
    } catch {
      return;
    }
    const previous = this.#snapshot;
    this.#snapshot = next;
    if (previous === undefined) return;
    const changed = new Set<string>();
    for (const [runId, run] of next) {
      const before = previous.get(runId);
      if (before === undefined || before.size !== run.size) changed.add(runId);
    }
    // A run that was active and no longer is has ended.
    for (const runId of previous.keys()) if (!next.has(runId)) changed.add(runId);
    for (const runId of changed) {
      try {
        const info = this.#runInfoUnlocked(runId);
        this.#notify({ runId, object: info.object });
      } catch {
        // Still being written; the next event or a read picks it up.
      }
    }
  }

  /**
   * The size of every active run's file. Ended runs never change, so they are
   * not looked at: the cost follows the active runs, not the history.
   */
  #takeRunSnapshot(): Map<string, { readonly size: number; readonly ended: boolean }> {
    const snapshot = new Map<string, { readonly size: number; readonly ended: boolean }>();
    for (const runId of this.#withLock(() => [...this.#syncActiveUnlocked()])) {
      try {
        snapshot.set(runId, {
          size: statSync(this.#runPath(runId)).size,
          ended: false,
        });
      } catch {
        // Removed since the directory was read.
      }
    }
    return snapshot;
  }

  async *#read(runId: string): AsyncGenerator<Fact> {
    this.#assertOpen();
    const path = this.#runPath(runId);
    let handle: Awaited<ReturnType<typeof openAsync>>;
    try {
      handle = await openAsync(path, "r");
    } catch (error) {
      if (isErrno(error, "ENOENT")) throw new RunNotFoundError(runId);
      throw error;
    }

    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const decoder = new TextDecoder();
      let pending = "";
      let position = 0;
      let sawHeader = false;
      let expectedSeq = 1;

      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        pending += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });

        while (true) {
          const newline = pending.indexOf("\n");
          if (newline < 0) break;
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line.length === 0) continue;

          const record = parseLine(line, runId);
          if (Array.isArray(record)) {
            if (!sawHeader) throw new CorruptLogError(runId, "a batch precedes the header");
            for (const fact of record) {
              if (fact.seq !== expectedSeq) {
                throw new CorruptLogError(
                  runId,
                  `sequence ${fact.seq} follows ${expectedSeq - 1}`,
                );
              }
              expectedSeq += 1;
              yield fact;
            }
          } else {
            if (sawHeader) throw new CorruptLogError(runId, "the header appears twice");
            sawHeader = true;
          }
        }
      }

      // Bytes without a trailing newline are a torn write; open() cuts them off.
      if (!sawHeader) throw new CorruptLogError(runId, "the log has no header");
    } finally {
      await handle.close();
    }
  }

  async *#readGlobal(): AsyncGenerator<GlobalFact> {
    this.#assertOpen();
    let handle: Awaited<ReturnType<typeof openAsync>>;
    try {
      handle = await openAsync(this.#globalFactsPath, "r");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return;
      throw error;
    }

    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const decoder = new TextDecoder();
      let pending = "";
      let position = 0;
      let expectedSeq = 1;

      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        pending += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });

        while (true) {
          const newline = pending.indexOf("\n");
          if (newline < 0) break;
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line.length === 0) continue;

          const fact = parseGlobalFactLine(line);
          if (fact.seq !== expectedSeq) {
            throw new CorruptLogError(
              "global",
              `sequence ${fact.seq} follows ${expectedSeq - 1}`,
            );
          }
          expectedSeq += 1;
          yield globalFactOf(fact);
        }
      }
    } finally {
      await handle.close();
    }
  }

  #lastGlobalSeqUnlocked(): number {
    if (!existsSync(this.#globalFactsPath)) return 0;
    const line = readLastLine(this.#globalFactsPath);
    if (line === null) return 0;
    return parseGlobalFactLine(line).seq;
  }

  #runPath(runId: string): string {
    return join(this.#runsDirectory, `${runId}.jsonl`);
  }

  #endPath(runId: string): string {
    return join(this.#runsDirectory, `${runId}.end`);
  }

  #assertOpen(): void {
    if (this.#closed) throw new StoreClosedError();
  }

  #withLock<T>(fn: () => T): T {
    this.#assertOpen();
    return withFileLock(this.#lockPath, fn);
  }

  #lastSeqUnlocked(path: string, runId: string): number {
    const line = readLastLine(path);
    if (line === null) return 0;
    const record = parseLine(line, runId);
    if (!Array.isArray(record)) return 0;
    const last = record[record.length - 1];
    if (!last) throw new CorruptLogError(runId, "an empty batch was stored");
    return last.seq;
  }

  #runInfoUnlocked(runId: string): RunInfo {
    const path = this.#runPath(runId);
    if (!existsSync(path)) throw new RunNotFoundError(runId);
    const line = readFirstLine(path);
    if (line === null) {
      throw new CorruptLogError(runId, "the log has no complete header");
    }
    const header = parseHeader(parseLine(line, runId), runId);
    const endPath = this.#endPath(runId);
    const active = !existsSync(endPath);
    return {
      runId,
      flow: header.flow,
      object: header.object,
      active,
      startedAt: header.startedAt,
      endedAt: active ? null : this.#endedAt(endPath),
      lastSeq: this.#lastSeqUnlocked(path, runId),
      ...(header.access === undefined ? {} : { access: header.access }),
      startInputId: header.startInputId ?? null,
    };
  }

  #endedAt(path: string): number | null {
    try {
      const marker = JSON.parse(readFileSync(path, "utf8")) as Partial<EndMarker>;
      return typeof marker.endedAt === "number" ? marker.endedAt : null;
    } catch {
      return null;
    }
  }

  #allRunIds(): string[] {
    return readdirSync(this.#runsDirectory)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.slice(0, -".jsonl".length));
  }

  /**
   * The ids of the active runs. They come from the runs index, an append-only
   * file with a line for every run start and end, written under the same lock
   * as the run's own file. A call reads the bytes added since the last one:
   * none when nothing happened, so a quiet tick lists no directory and reads no
   * file. No time or modification date is compared, so a change cannot be
   * missed. Without an index, or with one that was cut or cannot be read, the
   * set is built from one read of the directory and the index is written anew.
   */
  #syncActiveUnlocked(): ReadonlySet<string> {
    let stat: BigIntStats | undefined;
    try {
      stat = statSync(this.#indexPath, { bigint: true });
    } catch {
      stat = undefined;
    }
    if (stat === undefined) return this.#rebuildActiveUnlocked();
    // An index shorter than what was already read was cut.
    if (Number(stat.size) < this.#indexBytes) return this.#rebuildActiveUnlocked();
    if (this.#indexIno !== stat.ino) {
      // A new file under the name: read it from its start.
      this.#activeIds.clear();
      this.#indexBytes = 0;
      this.#indexIno = stat.ino;
    }
    const size = Number(stat.size);
    if (size === this.#indexBytes) return this.#activeIds;
    const fd = openSync(this.#indexPath, "r");
    let chunk: Buffer;
    try {
      chunk = Buffer.allocUnsafe(size - this.#indexBytes);
      readAllAtSync(fd, chunk, this.#indexBytes);
    } finally {
      closeSync(fd);
    }
    const end = chunk.lastIndexOf(0x0a) + 1;
    const lines = chunk.subarray(0, end).toString("utf8").split("\n");
    for (const line of lines) {
      if (line.length === 0) continue;
      const kind = line.slice(0, 2);
      const runId = line.slice(2);
      if ((kind !== "s " && kind !== "e ") || runId.length === 0) {
        return this.#rebuildActiveUnlocked();
      }
      if (kind === "s ") this.#activeIds.add(runId);
      else this.#activeIds.delete(runId);
    }
    this.#indexBytes += end;
    return this.#activeIds;
  }

  /** One read of the directory; writes the index again from what it found. */
  #rebuildActiveUnlocked(): ReadonlySet<string> {
    const names = readdirSync(this.#runsDirectory);
    const ended = new Set(names.filter((name) => name.endsWith(".end")));
    const lines: string[] = [];
    this.#activeIds.clear();
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const runId = name.slice(0, -".jsonl".length);
      lines.push(`s ${runId}\n`);
      if (ended.has(`${runId}.end`)) lines.push(`e ${runId}\n`);
      else this.#activeIds.add(runId);
    }
    const temporary = `${this.#indexPath}.tmp`;
    writeFileSynced(temporary, lines.join(""));
    renameSync(temporary, this.#indexPath);
    const stat = statSync(this.#indexPath, { bigint: true });
    this.#indexIno = stat.ino;
    this.#indexBytes = Number(stat.size);
    return this.#activeIds;
  }

  #listRunsUnlocked(activeOnly: boolean): RunInfo[] {
    const runs: RunInfo[] = [];
    const runIds = activeOnly ? [...this.#syncActiveUnlocked()] : this.#allRunIds();
    for (const runId of runIds) {
      let info: RunInfo;
      try {
        info = this.#runInfoUnlocked(runId);
      } catch (error) {
        if (error instanceof RunNotFoundError) continue;
        throw error;
      }
      if (!activeOnly || info.active) runs.push(info);
    }
    runs.sort(
      (left, right) =>
        left.startedAt - right.startedAt || left.runId.localeCompare(right.runId),
    );
    return runs;
  }

  #refreshInputsUnlocked(): void {
    truncateTornLine(this.#inputsPath);
    const size = existsSync(this.#inputsPath) ? statSync(this.#inputsPath).size : 0;
    if (size < this.#inputBytes) {
      this.#rebuildInputs();
      return;
    }
    if (size === this.#inputBytes) return;

    const fd = openSync(this.#inputsPath, "r");
    try {
      const buffer = Buffer.allocUnsafe(size - this.#inputBytes);
      readAllAtSync(fd, buffer, this.#inputBytes);
      this.#consumeInputLines(buffer.toString("utf8"), this.#inputBytes);
    } finally {
      closeSync(fd);
    }
    this.#inputBytes = size;
  }

  #consumeInputLines(text: string, base: number): void {
    let offset = base;
    for (const line of text.split("\n")) {
      const start = offset;
      offset += Buffer.byteLength(line) + 1;
      if (line.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new CorruptLogError("inputs", "an input line is not JSON");
      }
      const record = value as Partial<StoredInput>;
      if (record.type !== "input" || typeof record.inputId !== "string") {
        throw new CorruptLogError("inputs", "an input line has no input id");
      }
      this.#inputIds.set(record.inputId, {
        start,
        length: Buffer.byteLength(line) + 1,
      });
    }
  }

  #rebuildInputs(): void {
    this.#inputIds.clear();
    if (!existsSync(this.#inputsPath)) {
      this.#inputBytes = 0;
      return;
    }
    // Count the bytes actually consumed, not a later stat: an append between a
    // read and a stat must stay visible to the next refresh.
    const buffer = readFileSync(this.#inputsPath);
    this.#consumeInputLines(buffer.toString("utf8"), 0);
    this.#inputBytes = buffer.length;
  }

  #rememberOutcome(stored: StoredOutcome): void {
    const key = outcomeKey(stored.inputId, stored.kind);
    const previous = this.#outcomes.get(key);
    this.#outcomes.set(key, stored);
    if (previous !== undefined) {
      this.#outcomeList = this.#outcomeList.filter((item) => item !== previous);
    }
    const last = this.#outcomeList[this.#outcomeList.length - 1];
    this.#outcomeList.push(stored);
    if (last !== undefined && last.seq > stored.seq) {
      this.#outcomeList.sort((left, right) => left.seq - right.seq);
    }
  }

  #asOutcome(stored: StoredOutcome): InputOutcome {
    return {
      inputId: stored.inputId,
      kind: stored.kind,
      payload: stored.payload,
      seq: stored.seq,
      time: stored.time,
    };
  }

  #refreshOutcomesUnlocked(): void {
    truncateTornLine(this.#outcomesPath);
    const size = existsSync(this.#outcomesPath) ? statSync(this.#outcomesPath).size : 0;
    if (size < this.#outcomeBytes) {
      this.#rebuildOutcomes();
      return;
    }
    if (size === this.#outcomeBytes) return;

    const fd = openSync(this.#outcomesPath, "r");
    try {
      const buffer = Buffer.allocUnsafe(size - this.#outcomeBytes);
      readAllAtSync(fd, buffer, this.#outcomeBytes);
      this.#consumeOutcomeLines(buffer.toString("utf8"));
    } finally {
      closeSync(fd);
    }
    this.#outcomeBytes = size;
  }

  #consumeOutcomeLines(text: string): void {
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      const stored = parseOutcomeLine(line);
      if (stored === undefined) {
        throw new CorruptLogError("outcomes", "an outcome line is not valid");
      }
      this.#rememberOutcome(stored);
      this.#outcomeSeq = Math.max(this.#outcomeSeq, stored.seq);
    }
  }

  #rebuildOutcomes(): void {
    this.#outcomes.clear();
    this.#outcomeList = [];
    this.#outcomeSeq = 0;
    if (!existsSync(this.#outcomesPath)) {
      this.#outcomeBytes = 0;
      return;
    }
    const buffer = readFileSync(this.#outcomesPath);
    this.#consumeOutcomeLines(buffer.toString("utf8"));
    this.#outcomeBytes = buffer.length;
  }

  #recover(): void {
    // Rebuild inside the lock: a writer that appends during the rebuild would
    // otherwise let the rebuild miss a line and record the larger size.
    this.#withLock(() => {
      for (const name of readdirSync(this.#runsDirectory)) {
        const path = join(this.#runsDirectory, name);
        if (name.endsWith(".tmp")) {
          rmSync(path, { force: true });
        } else if (name.endsWith(".jsonl")) {
          truncateTornLine(path);
        }
      }
      truncateTornLine(this.#inputsPath);
      truncateTornLine(this.#outcomesPath);
      truncateTornLine(this.#globalFactsPath);
      this.#rebuildInputs();
      this.#rebuildOutcomes();
    });
  }

  recover(): void {
    this.#recover();
  }
}

function ensureSchema(directory: string): void {
  const path = join(directory, SCHEMA_FILE);
  if (!existsSync(path)) {
    createExclusive(path, `${JSON.stringify({ schema_version: SCHEMA_VERSION })}\n`);
    fsyncDirectory(directory);
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new SchemaVersionError(`store ${directory} has an unreadable ${SCHEMA_FILE}`);
  }
  const version =
    typeof value === "object" && value !== null
      ? (value as { schema_version?: unknown }).schema_version
      : undefined;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new SchemaVersionError(`store ${directory} has no valid schema_version`);
  }
  if (version > SCHEMA_VERSION) {
    throw new SchemaVersionError(
      `store ${directory} uses schema_version ${version}, but this build supports ${SCHEMA_VERSION}; ` +
        "upgrade operad to open it",
    );
  }
  if (version < SCHEMA_VERSION) {
    // Version 2 added an optional `access` field to the run header; every
    // version-1 record stays readable, so only the marker changes.
    if (version !== 1) {
      throw new SchemaVersionError(
        `store ${directory} uses schema_version ${version}, but this build requires ${SCHEMA_VERSION}`,
      );
    }
    writeFileSynced(path, `${JSON.stringify({ schema_version: SCHEMA_VERSION })}\n`);
    fsyncDirectory(directory);
  }
}

export function openJsonlLogBackend(
  directory: string,
  options: LogBackendOptions = {},
): LogBackend {
  const runsDirectory = join(directory, RUNS_DIR);
  ensureDirectory(runsDirectory);

  ensureSchema(directory);

  const lockPath = join(directory, LOCK_FILE);
  closeSync(openSync(lockPath, "a"));

  const backend = new JsonlLogBackend(
    directory,
    options.clock ?? Date.now,
    options.runId ?? randomUUID,
    resolveSubscriptionWatch(options),
  );
  backend.recover();
  return backend;
}

export const jsonlBackend: LogBackendFactory = {
  name: "jsonl",
  open: openJsonlLogBackend,
};

export default jsonlBackend;
