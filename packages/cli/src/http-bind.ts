/**
 * Starting the listeners of a serve that took over from another one. The old
 * serve has released its addresses before the new one starts, but the system
 * may need a moment to hand them back, so a failed bind is tried again for a
 * bounded time before the new code gives up.
 */

import { ConfigError } from "@operad-io/engine";

export interface BindRetryOptions {
  /** How long to keep trying, in milliseconds. */
  readonly retryMs: number;
  /** The wait between two tries. */
  readonly stepMs: number;
  readonly now: () => number;
  readonly wait: (ms: number) => Promise<void>;
  /** Called with each failure that will be tried again. */
  readonly onRetry?: ((error: unknown) => void) | undefined;
}

/** The new code could not listen in time; the old code has to serve. */
export class BindFailed extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "BindFailed";
  }
}

/** Runs `start` until it succeeds or `retryMs` has passed; a bad configuration is not retried. */
export async function startWithRetry<T>(
  start: () => Promise<T>,
  options: BindRetryOptions,
): Promise<T> {
  const deadline = options.now() + options.retryMs;
  for (;;) {
    try {
      return await start();
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      if (options.now() >= deadline) throw new BindFailed(error);
      options.onRetry?.(error);
    }
    await options.wait(options.stepMs);
  }
}
