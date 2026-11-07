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
 * How many times one review round may wait for an unavailable model before it
 * waits for a person instead: 36 waits of the default 120 seconds are about 72
 * minutes. The count is the number of primary runs of the round recorded as
 * unavailable in the task's review runs, so a crash and a replay agree on it.
 */
export const MAX_REVIEW_WAITS = 36;

/**
 * The most the visits of one step may add up to in a dev run: the kernel's
 * default of ten for ordinary loops plus one visit of `review` and of
 * `review_retry` for each allowed review wait.
 */
export const DEV_MAX_VISITS = 10 + MAX_REVIEW_WAITS;
