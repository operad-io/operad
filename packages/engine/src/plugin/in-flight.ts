/**
 * Work that reads a store and must be over before the store is closed. After
 * `drain` no new work starts, and work still running at the end of the wait is
 * dropped quietly by its caller (`draining` tells it so).
 *
 * Nothing pending is lost or wrong in the window: a drained registry belongs
 * to a context that is ending, its answers are read again from the next
 * context's registry, and work that was in flight when the wait began either
 * finishes with the right items or is dropped whole, never half-read: a late
 * failure keeps only the items already complete.
 */
export class InFlight {
  private readonly running = new Set<Promise<unknown>>();
  private stopped = false;

  /** True once `drain` was called: nothing new starts and a late failure is not news. */
  get draining(): boolean {
    return this.stopped;
  }

  /** Runs `work` counted as in flight. */
  async track<T>(work: () => Promise<T>): Promise<T> {
    const promise = work();
    const settled = promise.then(
      () => undefined,
      () => undefined,
    );
    this.running.add(settled);
    void settled.then(() => this.running.delete(settled));
    return await promise;
  }

  /** Stops new work and waits for the work in flight, at most `timeoutMs`. */
  async drain(timeoutMs: number): Promise<void> {
    this.stopped = true;
    if (this.running.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([Promise.all([...this.running]), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** How long a reload or a stop waits for work that reads the old store. */
export const DRAIN_TIMEOUT_MS = 5000;
