/**
 * What a harness's `modelError` says, as dev reads it. A harness reports the
 * kind, the model's own message and, when it knows it, how long to wait.
 */

import { isRecord } from "@operad-io/engine";
import { MAX_MODEL_RETRY_SECS } from "./timeouts.ts";

export interface ModelErrorInfo {
  /** `unavailable` or `usage_limit`; another kind is not a model outage. */
  readonly kind: string;
  /** The model's own message, when it gave one. */
  readonly message?: string;
  /** How long the model said to wait, in seconds; absent when it did not say. */
  readonly retryAfterSecs?: number;
  /** When the model reported the wait, in epoch milliseconds; absent when unknown. */
  readonly reportedAt?: number;
}

/** A positive epoch time, or undefined when the value is not one. */
function positiveTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function retryAfterSecs(value: unknown): number | undefined {
  return positiveTime(value);
}

/** A normalized model error, or undefined when the value is not one. */
export function readModelError(value: unknown): ModelErrorInfo | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind !== "unavailable" && value.kind !== "usage_limit") {
    return undefined;
  }
  const message =
    typeof value.message === "string" && value.message.length > 0
      ? value.message
      : undefined;
  const retry = retryAfterSecs(value.retry_after_secs);
  const reported = positiveTime(value.reported_at);
  return {
    kind: value.kind,
    ...(message === undefined ? {} : { message }),
    ...(retry === undefined ? {} : { retryAfterSecs: retry }),
    ...(reported === undefined ? {} : { reportedAt: reported }),
  };
}

/** The model error a harness step put in its result data, when it put one. */
export function modelErrorIn(
  data: Readonly<Record<string, unknown>> | undefined,
): ModelErrorInfo | undefined {
  return readModelError(data?.modelError);
}

/**
 * True when dev must not retry the run on its own. A usage limit is not an
 * outage to wait out: the account cannot serve until its period ends. A
 * retry-after longer than half an hour is the same kind of wait, and a person
 * decides whether to switch the worker or wait for the model.
 */
export function modelWaitsForPerson(error: ModelErrorInfo): boolean {
  return (
    error.kind === "usage_limit" ||
    (error.retryAfterSecs !== undefined &&
      error.retryAfterSecs > MAX_MODEL_RETRY_SECS)
  );
}
