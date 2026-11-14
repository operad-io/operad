/** The public shapes of the append-only fact log. */

import type { Database } from "bun:sqlite";
import type { ImmediateWriter } from "../platform/sqlite-open.ts";
import type { FollowOptions } from "../platform/watch.ts";

/** A value that JSON can represent without losing anything. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * What caused a fact: the sequence number of an earlier fact in the same run,
 * or the id returned by `recordInput`.
 */
export type FactCause = number | string;

/** A fact before the backend gives it a run id, a sequence number and a time. */
export interface NewFact {
  readonly kind: string;
  readonly payload: JsonValue;
  readonly cause: FactCause;
}

/** A fact as it is stored and read. */
export interface Fact extends NewFact {
  readonly runId: string;
  readonly seq: number;
  readonly time: number;
}

/** A fact that belongs to no run, such as an event the kernel only observed. */
export interface GlobalFact extends NewFact {
  readonly seq: number;
  readonly time: number;
  /** The key `appendGlobal` was given, when it was given one. */
  readonly uniqueKey?: string;
}

export interface RunInfo {
  readonly runId: string;
  readonly flow: string;
  readonly object: string;
  readonly active: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly lastSeq: number;
  /** The access profile recorded when the run started, if any. */
  readonly access?: JsonValue | undefined;
  /** The input whose start created this run, or null for a plain start. */
  readonly startInputId: string | null;
}

/** One recorded input, as the log keeps it. */
export interface InputRecord {
  readonly inputId: string;
  readonly runId: string | null;
  readonly source: string;
  readonly sourceKey: string;
  readonly payload: JsonValue;
  readonly time: number;
}

export interface RecordInputResult {
  readonly duplicate: boolean;
  readonly inputId: string;
}

/**
 * What the kernel decided to do with a recorded input, keyed by
 * `(inputId, kind)`. The first write for a kind wins, so concurrent callers
 * cannot record two different outcomes for one event.
 */
export interface InputOutcome {
  readonly inputId: string;
  readonly kind: string;
  readonly payload: JsonValue;
  readonly seq: number;
  readonly time: number;
}

/** Inputs read after a position, with the position that continues the read. */
export interface InputsAfter {
  readonly inputs: readonly InputRecord[];
  readonly position: number;
}

export interface RecordOutcomeResult {
  readonly duplicate: boolean;
  readonly outcome: InputOutcome;
}

export interface AppendResult {
  readonly lastSeq: number;
  readonly facts: readonly Fact[];
}

export interface RunsOptions {
  readonly active?: boolean;
  /** Only the runs of this object key, such as `task:42`. */
  readonly object?: string;
}

export interface LogBackendOptions extends FollowOptions {
  /** The clock every stored time comes from. Defaults to `Date.now`. */
  readonly clock?: () => number;
  /**
   * Makes the id of each new run. Defaults to a random UUID. A copy of a log
   * passes the ids of the runs it copies.
   */
  readonly runId?: () => string;
  /**
   * How often an open subscription re-reads storage for another process's
   * write, in milliseconds. Defaults to 500. The watch is the fast path; this
   * check is the one that cannot miss a write the watch does not report.
   */
  readonly pollMs?: number;
  /** Called each time a subscription reads every run's last sequence. A test counts it. */
  readonly onSnapshot?: () => void;
  /**
   * Starts a repeating timer that calls `callback` every `ms` and returns a
   * stop function. Defaults to `setInterval`. A test passes a stub it fires by
   * hand, so no test waits on wall time.
   */
  readonly repeat?: (ms: number, callback: () => void) => () => void;
  /**
   * Watches a directory for another process's write and returns a stop
   * function. Defaults to `fs.watch`. A test passes a stub that never fires.
   */
  readonly watch?: (
    directory: string,
    onChange: (filename: string | null) => void,
  ) => () => void;
  /**
   * Test hook: wraps the connection an immediate write goes through, so a test
   * can act between reading `data_version` and taking the write lock.
   */
  readonly immediateWriter?:
    | ((database: Database) => ImmediateWriter)
    | undefined;
}

/** A change to a run: a start, an end, or one appended batch. */
export interface LogChange {
  readonly runId: string;
  /** The run's object key, such as `task:42`; undefined when it cannot be read. */
  readonly object: string | undefined;
}

/** Options for a log backend that can notify a local listener. */
export interface LogSubscription {
  subscribe(listener: (change: LogChange) => void): () => void;
}

export interface LogBackend extends Partial<LogSubscription> {
  /**
   * Start a run, unless the same flow/object pair already has an active one.
   * `startInputId` records the input that caused the start, so the log alone
   * can answer which run an event started; `access` is the run's profile.
   */
  startRun(
    flow: string,
    object: string,
    startInputId?: string | null,
    access?: JsonValue,
  ): Promise<RunInfo>;
  /** End an active run. Ending an ended run is a no-op. */
  endRun(runId: string): Promise<void>;
  /**
   * Record one input for a run, or a global input when `runId` is null. A
   * repeated (source, sourceKey) is a duplicate: `duplicate` is true and
   * nothing is written.
   */
  recordInput(
    runId: string | null,
    source: string,
    sourceKey: string,
    payload: JsonValue,
  ): Promise<RecordInputResult>;
  /**
   * Append one batch of facts. The whole batch is written or nothing is. The
   * run's last sequence must equal `expectedSeq`; the backend assigns the
   * following sequence numbers and the times.
   */
  append(
    runId: string,
    expectedSeq: number,
    facts: readonly NewFact[],
  ): Promise<AppendResult>;
  /** Stream the facts of a run in sequence order. */
  read(runId: string): AsyncIterable<Fact>;
  /** List runs, optionally only the active ones. */
  runs(options?: RunsOptions): Promise<RunInfo[]>;
  /**
   * Append one fact that belongs to no run. Global facts keep their order.
   * With a `uniqueKey`, the first fact for that key wins: a later call writes
   * nothing and returns the stored fact.
   */
  appendGlobal(fact: NewFact, uniqueKey?: string): Promise<GlobalFact>;
  /** Stream the global facts in sequence order. */
  readGlobal(): AsyncIterable<GlobalFact>;
  /** Stream every recorded input, oldest first. */
  readInputs(): AsyncIterable<InputRecord>;
  /**
   * The inputs recorded after a position, oldest first, and the position to
   * ask from next time. Position 0 is the start. A caller that remembers the
   * position reads only what is new, so its cost follows what changed.
   */
  readInputsAfter(position: number): Promise<InputsAfter>;
  /** One input by id, or undefined. */
  findInput(inputId: string): Promise<InputRecord | undefined>;
  /** The outcome stored for `(inputId, kind)`, or undefined. */
  readOutcome(inputId: string, kind: string): Promise<InputOutcome | undefined>;
  /** The outcomes with a sequence above `seq`, in order. */
  readOutcomesAfter(seq: number): Promise<InputOutcome[]>;
  /**
   * Record the kernel's outcome for an input. A repeated `(inputId, kind)` is
   * a duplicate: `duplicate` is true, nothing is written, and the stored
   * outcome is returned. Concurrent callers therefore agree on one outcome.
   */
  recordOutcome(
    inputId: string,
    kind: string,
    payload: JsonValue,
  ): Promise<RecordOutcomeResult>;
  /** Stream every recorded outcome in the order it was written. */
  readOutcomes(): AsyncIterable<InputOutcome>;
  close(): Promise<void>;
}

/** A backend implementation, as a storage directory plus its name. */
export interface LogBackendFactory {
  readonly name: string;
  open(directory: string, options?: LogBackendOptions): LogBackend | Promise<LogBackend>;
}
