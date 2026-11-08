/**
 * Live updates, apart from any screen: which fetches an event asks for, the
 * clock that spaces them, and how a failed request is read as a state of the
 * connection.
 */

import { TuiError, TuiUnreachableError } from "./client.ts";
import { sameObject, type TuiConnection } from "./state.ts";

/** At most one batch of refetches per this many milliseconds. */
export const LIVE_DEBOUNCE_MS = 250;

/** What the shell needs from time: one timer that can be cancelled. */
export interface TuiClock {
  /** Calls `run` once after `ms`; the returned function cancels it. */
  after(run: () => void, ms: number): () => void;
}

/** The real clock. */
export const systemClock: TuiClock = {
  after(run, ms) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

/** What to fetch again after one or more events. */
export interface Refetch {
  /** Every open list and the open object (a `reset`). */
  readonly all: boolean;
  /** Pending and Running; they refetch on any event. */
  readonly lists: boolean;
  /** Ids whose row is fetched again in the open lists. */
  readonly rows: readonly string[];
  /** The open object, its row and its live sections. */
  readonly object: boolean;
}

/** Nothing to fetch. */
export const NO_REFETCH: Refetch = { all: false, lists: false, rows: [], object: false };

/** What an event is read against. */
export interface LiveEvent {
  readonly kind: "change" | "reset";
  readonly id?: string | undefined;
}

/** The targets one event asks for, given the object that is open. */
export function refetchTargets(
  event: LiveEvent,
  openId: string | undefined,
): Refetch {
  if (event.kind === "reset") {
    return { all: true, lists: true, rows: [], object: openId !== undefined };
  }
  const id = event.id;
  if (id === undefined) return { ...NO_REFETCH, lists: true };
  return {
    all: false,
    lists: true,
    rows: [id],
    object: openId !== undefined && sameObject(openId, id),
  };
}

/** Two sets of targets as one. */
export function mergeRefetch(a: Refetch, b: Refetch): Refetch {
  return {
    all: a.all || b.all,
    lists: a.lists || b.lists,
    rows: [...new Set([...a.rows, ...b.rows])],
    object: a.object || b.object,
  };
}

/**
 * Collects targets and hands them over once per window. The first push opens
 * the window; pushes inside it join the same batch.
 */
export class LiveBatcher {
  private batch: Refetch = NO_REFETCH;
  private cancel: (() => void) | undefined;

  constructor(
    private readonly clock: TuiClock,
    private readonly flush: (targets: Refetch) => void,
    private readonly windowMs = LIVE_DEBOUNCE_MS,
  ) {}

  push(targets: Refetch): void {
    this.batch = mergeRefetch(this.batch, targets);
    if (this.cancel !== undefined) return;
    this.cancel = this.clock.after(() => {
      const ready = this.batch;
      this.batch = NO_REFETCH;
      this.cancel = undefined;
      this.flush(ready);
    }, this.windowMs);
  }

  /** Drops the batch and the timer. */
  stop(): void {
    this.cancel?.();
    this.cancel = undefined;
    this.batch = NO_REFETCH;
  }
}

/** What a failed request says about the server; undefined says nothing. */
export function connectionOf(error: unknown): TuiConnection | undefined {
  if (error instanceof TuiUnreachableError) return "unreachable";
  return error instanceof TuiError && error.status === 401 ? "unauthorized" : undefined;
}
