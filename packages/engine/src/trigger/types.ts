/** The words a source sends, and the words a step sees. */

import type { JsonValue } from "../log/types.ts";

/** An event deeper than this is recorded and starts nothing. */
export const MAX_TRIGGER_HOPS = 8;

export type TriggerMode = "observe" | "candidate" | "auto";

/** What a source, the CLI or a step sends. */
export interface TriggerEvent {
  readonly source: string;
  readonly key: string;
  readonly type: string;
  readonly object?: string;
  readonly summary?: string;
  /** External material: written to a file, never put into a prompt. */
  readonly data?: JsonValue;
  readonly link?: string;
  /** Outside events are 0; an event a run emits is the starting event's + 1. */
  readonly hops: number;
}

/** One routing rule from `triggers.json`. */
export interface TriggerRule {
  readonly source: string;
  readonly type: string;
  readonly start: {
    readonly flow: string;
    readonly params?: JsonValue;
  };
  /** A fixed object key, or `"$event.object"`. */
  readonly object: string;
  readonly mode: TriggerMode;
  readonly schedule?: string;
}

/** What a step sees as `ctx.trigger`; read-only, and file paths only. */
export interface TriggerView {
  readonly source: string;
  readonly key: string;
  readonly type: string;
  readonly link?: string;
  readonly hops: number;
  readonly summary?: string;
  readonly data?: string;
}

export interface StartRequest {
  readonly flow: string;
  readonly params?: JsonValue;
  /** The run's object key, such as `task:42` or `flow:dev/run`. */
  readonly object: string;
  readonly trigger?: TriggerEvent;
  /** Internal: an event already recorded through the log's input store. */
  readonly inputId?: string;
  /** The access profile the run starts with, opaque to the kernel. */
  readonly access?: JsonValue;
}

/** What starting one run did. */
export type StartResult =
  | {
      readonly kind: "started";
      readonly runId: string;
      readonly duplicate: boolean;
    }
  | {
      readonly kind: "active";
      readonly runId: string;
      readonly duplicate: boolean;
    }
  | {
      readonly kind: "recorded";
      readonly duplicate: boolean;
    }
  | {
      readonly kind: "observed";
      readonly duplicate: boolean;
    }
  | {
      readonly kind: "candidate";
      readonly pendingId: string;
      readonly duplicate: boolean;
    }
  | {
      readonly kind: "skipped";
      readonly reason: string;
      readonly duplicate: boolean;
    };

/** What handling one event did. */
export interface TriggerResult {
  readonly kind:
    | "started"
    | "active"
    | "recorded"
    | "observed"
    | "candidate"
    | "skipped";
  readonly inputId: string;
  readonly duplicate: boolean;
  readonly runId?: string;
  readonly pendingId?: string;
  readonly flow?: string;
  readonly object?: string;
  readonly reason?: string;
}

/** A candidate the pending view offers to start or dismiss. */
export interface TriggerCandidate {
  readonly pendingId: string;
  readonly inputId: string;
  readonly flow: string;
  readonly params?: JsonValue;
  readonly object: string;
  readonly event: TriggerEvent;
  readonly status: "pending" | "started" | "dismissed";
  readonly runId?: string;
  readonly at: number;
}

/** An event routed to a flow that cannot start yet, and why. */
export interface RefusedStart {
  readonly inputId: string;
  readonly flow: string;
  readonly object: string;
  readonly reason: string;
}

/** An event a step sends; the kernel adds the source, run scope and hops. */
export interface StepEvent {
  readonly type: string;
  readonly key: string;
  readonly object?: string;
  readonly summary?: string;
  readonly data?: JsonValue;
}

/** An event a source plugin sends; the kernel adds nothing but validation. */
export interface SourceEvent {
  readonly source?: string;
  readonly key: string;
  readonly type: string;
  readonly object?: string;
  readonly summary?: string;
  readonly data?: JsonValue;
  readonly link?: string;
}

/** One stored event, kept even when no rule matches. */
export interface StoredTriggerEvent {
  readonly inputId: string;
  readonly event: TriggerEvent;
  readonly at: number;
}
