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
