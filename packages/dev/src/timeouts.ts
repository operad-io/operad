/**
 * How long work, verify, review and integrate may take: above the worker's
 * two-hour wall time and the reviewer's one-hour timeout in `.operad/dev.json`.
 */
export const STEP_TIMEOUT_SECS = 3 * 60 * 60;

/**
 * How long one `dev/review_due` run waits. It stays clear of the step timeout,
 * so a `reviewer.retrySecs` longer than that timeout is waited in pieces: the
 * step ends before the runner stops it, and the flow comes back to the same
 * wait. Only the last piece is followed by a real review.
 */
export const REVIEW_WAIT_CHUNK_MS = (STEP_TIMEOUT_SECS - 60) * 1000;

/**
 * The longest one review wait lasts. The waits double from
 * `reviewer.retrySecs`, so an outage of an hour or two is waited out in a
 * handful of tries instead of dozens.
 */
export const MAX_REVIEW_WAIT_SECS = 30 * 60;

/**
 * How long the `n`th wait (1-based) of a review round lasts: `retrySecs`, then
 * double each time, up to `MAX_REVIEW_WAIT_SECS` (or `retrySecs` itself when
 * that is longer).
 */
export function reviewWaitMs(retrySecs: number, n: number): number {
  const cap = Math.max(retrySecs, MAX_REVIEW_WAIT_SECS);
  const doublings = Math.min(Math.max(n - 1, 0), 30);
  return Math.min(retrySecs * 2 ** doublings, cap) * 1000;
}

/**
 * How many times one review round may wait for an unavailable model before it
 * waits for a person instead. It was 36 waits of a flat `retrySecs` (about 72
 * minutes at the default 120 seconds); it is now 6 waits that double (2, 4, 8,
 * 16, 30 and 30 minutes: about 90 minutes at the default). The count is the
 * number of primary runs of the round recorded as unavailable in the task's
 * review runs, so a crash and a replay agree on it.
 */
export const MAX_REVIEW_WAITS = 6;

/**
 * How many times one attempt's work step may wait for an unavailable model
 * before the failure goes to a person. The work wait stays flat at
 * `reviewer.retrySecs`.
 */
export const MAX_WORK_WAITS = 36;

/**
 * The most the visits of one step may add up to in a dev run: the kernel's
 * default of ten for ordinary loops plus one visit of `work` and of
 * `work_retry` for each allowed work wait.
 *
 * The count is for the whole run, not for one rework or attempt. A long model
 * outage that spans several reworks (each wait is a visit of `work_retry` or
 * `review_retry`) can therefore use the budget up and end the run with
 * `visit_limit_reached` before any one attempt reaches its own wait bound.
 */
export const DEV_MAX_VISITS = 10 + MAX_WORK_WAITS;
