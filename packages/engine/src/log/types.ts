/** The public shapes of the append-only fact log. */

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

export interface RunInfo {
  readonly runId: string;
  readonly flow: string;
  readonly object: string;
  readonly active: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly lastSeq: number;
}

export interface RecordInputResult {
  readonly duplicate: boolean;
  readonly inputId: string;
}

export interface AppendResult {
  readonly lastSeq: number;
  readonly facts: readonly Fact[];
}

export interface RunsOptions {
  readonly active?: boolean;
}

export interface LogBackendOptions {
  /** The clock every stored time comes from. Defaults to `Date.now`. */
  readonly clock?: () => number;
  /**
   * How often an open subscription re-reads storage for another process's
   * write, in milliseconds. Defaults to 500. The watch is the fast path; this
   * check is the one that cannot miss a write the watch does not report.
   */
  readonly pollMs?: number;
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
  /** Start a run, unless the same flow/object pair already has an active one. */
  startRun(flow: string, object: string): Promise<RunInfo>;
  /** End an active run. Ending an ended run is a no-op. */
  endRun(runId: string): Promise<void>;
  /**
   * Record one input for a run. A repeated (source, sourceKey) is a duplicate:
   * `duplicate` is true and nothing is written.
   */
  recordInput(
    runId: string,
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
  close(): Promise<void>;
}

/** A backend implementation, as a storage directory plus its name. */
export interface LogBackendFactory {
  readonly name: string;
  open(directory: string, options?: LogBackendOptions): LogBackend | Promise<LogBackend>;
}
