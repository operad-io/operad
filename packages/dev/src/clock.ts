/** The clock and other test seams dev's steps and waits share, so one test can move all of them. */

import type { ReviewRunReason, ReviewRunRecord, ReviewRunRole } from "./model.ts";

/** Test-only hooks: a child process crashes at a named point in a review. */
export const reviewTestHooks: {
  now?: (() => number) | undefined;
  /** Waits instead of the real timer, so a test can move the clock. */
  wait?:
    | ((ms: number, signal: AbortSignal | undefined) => Promise<boolean>)
    | undefined;
  beforeRun?:
    | ((run: { readonly role: ReviewRunRole; readonly reason: ReviewRunReason }) => void)
    | undefined;
  /** Runs after the reviewer answered and before its run is written. */
  afterCall?:
    | ((run: { readonly role: ReviewRunRole; readonly reason: ReviewRunReason }) => void)
    | undefined;
  afterRunSaved?: ((run: ReviewRunRecord) => void) | undefined;
  /** Runs after the reviewer wrote a valid report, before the store copy. */
  beforeCopy?: (() => void) | undefined;
  /** Runs while a workspace report is open, before the folders are checked again. */
  afterOpen?: (() => void) | undefined;
} = {};

/** The time now in milliseconds; a test may replace it. */
export function now(): number {
  return reviewTestHooks.now?.() ?? Date.now();
}
