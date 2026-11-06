import { randomUUID } from "node:crypto";
import { open as openAsync } from "node:fs/promises";
import { join } from "node:path";
import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
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
import { withFileLock } from "./file-lock.ts";
import { assertJsonValue } from "./json-value.ts";
import { SCHEMA_VERSION } from "./schema.ts";
import type {
  AppendResult,
  Fact,
  JsonValue,
  LogBackend,
  LogBackendFactory,
  LogBackendOptions,
  NewFact,
  RecordInputResult,
  RunInfo,
  RunsOptions,
} from "./types.ts";

const SCHEMA_FILE = "schema.json";
const LOCK_FILE = ".lock";
const INPUTS_FILE = "inputs.jsonl";
const RUNS_DIR = "runs";
const NEWLINE = 0x0a;

interface RunHeader {
  readonly type: "run";
  readonly schemaVersion: number;
  readonly runId: string;
  readonly flow: string;
  readonly object: string;
  readonly startedAt: number;
}

interface StoredInput {
  readonly type: "input";
  readonly inputId: string;
  readonly runId: string;
  readonly source: string;
  readonly sourceKey: string;
  readonly payload: JsonValue;
  readonly time: number;
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
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if (isErrno(error, "EEXIST")) return false;
    throw error;
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
  return {
    runId,
    seq: record.seq as number,
    kind: record.kind,
    payload: record.payload as JsonValue,
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

class JsonlLogBackend implements LogBackend {
  readonly #directory: string;
  readonly #runsDirectory: string;
  readonly #inputsPath: string;
  readonly #lockPath: string;
  readonly #clock: () => number;
  readonly #inputIds = new Set<string>();
  #inputBytes = 0;
  #closed = false;

  constructor(directory: string, clock: () => number) {
    this.#directory = directory;
    this.#runsDirectory = join(directory, RUNS_DIR);
    this.#inputsPath = join(directory, INPUTS_FILE);
    this.#lockPath = join(directory, LOCK_FILE);
    this.#clock = clock;
  }

  async startRun(flow: string, object: string): Promise<RunInfo> {
    assertName(flow, "flow");
    assertName(object, "object");
    return this.#withLock(() => {
      const active = this.#listRunsUnlocked(true).find(
        (run) => run.flow === flow && run.object === object,
      );
      if (active) throw new ActiveRunError(flow, object, active.runId);

      const runId = randomUUID();
      const startedAt = this.#clock();
      const header: RunHeader = {
        type: "run",
        schemaVersion: SCHEMA_VERSION,
        runId,
        flow,
        object,
        startedAt,
      };
      if (!createExclusive(this.#runPath(runId), `${JSON.stringify(header)}\n`)) {
        throw new Error(`run id ${runId} already exists`);
      }
      fsyncDirectory(this.#runsDirectory);
      return {
        runId,
        flow,
        object,
        active: true,
        startedAt,
        endedAt: null,
        lastSeq: 0,
      };
    });
  }

  async endRun(runId: string): Promise<void> {
    assertRunId(runId);
    this.#withLock(() => {
      const path = this.#runPath(runId);
      if (!existsSync(path)) throw new RunNotFoundError(runId);
      const endPath = this.#endPath(runId);
      if (existsSync(endPath)) return;
      const marker: EndMarker = { endedAt: this.#clock() };
      writeFileSynced(endPath, `${JSON.stringify(marker)}\n`);
      fsyncDirectory(this.#runsDirectory);
    });
  }

  async recordInput(
    runId: string,
    source: string,
    sourceKey: string,
    payload: JsonValue,
  ): Promise<RecordInputResult> {
    assertRunId(runId);
    assertName(source, "source");
    assertName(sourceKey, "sourceKey");
    assertJsonValue(payload, "input payload");
    return this.#withLock(() => {
      const info = this.#runInfoUnlocked(runId);
      if (!info.active) throw new RunEndedError(runId);
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
      appendLineSynced(this.#inputsPath, `${JSON.stringify(record)}\n`);
      this.#inputIds.add(inputId);
      this.#inputBytes = statSync(this.#inputsPath).size;
      return { duplicate: false, inputId };
    });
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
      return { lastSeq: lastSeq + stored.length, facts: stored };
    });
  }

  read(runId: string): AsyncIterable<Fact> {
    assertRunId(runId);
    return this.#read(runId);
  }

  async runs(options: RunsOptions = {}): Promise<RunInfo[]> {
    return this.#withLock(() => this.#listRunsUnlocked(options.active === true));
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#inputIds.clear();
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

  #listRunsUnlocked(activeOnly: boolean): RunInfo[] {
    const runs: RunInfo[] = [];
    for (const name of readdirSync(this.#runsDirectory)) {
      if (!name.endsWith(".jsonl")) continue;
      const runId = name.slice(0, -".jsonl".length);
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
      this.#consumeInputLines(buffer.toString("utf8"));
    } finally {
      closeSync(fd);
    }
    this.#inputBytes = size;
  }

  #consumeInputLines(text: string): void {
    for (const line of text.split("\n")) {
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
      this.#inputIds.add(record.inputId);
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
    this.#consumeInputLines(buffer.toString("utf8"));
    this.#inputBytes = buffer.length;
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
      this.#rebuildInputs();
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
    throw new SchemaVersionError(
      `store ${directory} uses schema_version ${version}, but this build requires ${SCHEMA_VERSION}`,
    );
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

  const backend = new JsonlLogBackend(directory, options.clock ?? Date.now);
  backend.recover();
  return backend;
}

export const jsonlBackend: LogBackendFactory = {
  name: "jsonl",
  open: openJsonlLogBackend,
};

export default jsonlBackend;
