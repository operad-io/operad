/**
 * The places a `pool/agent` run holds. The engine's step limiter only blocks;
 * the pool must ask "is there room" for several workers and take the first,
 * so the counts live here. One serve process owns one home, so one book per
 * plugin instance is the home-wide count.
 */

export class PlaceBook {
  private readonly held = new Map<string, number>();
  private version = 0;
  private readonly listeners = new Set<() => void>();

  /** How many places are held under `key`. */
  used(key: string): number {
    return this.held.get(key) ?? 0;
  }

  /** True when `key` has room for one more under `limit`; no limit means room. */
  hasRoom(key: string, limit: number | undefined): boolean {
    return limit === undefined || this.used(key) < limit;
  }

  /** Holds one place under each key and returns the call that gives them back. */
  take(keys: readonly string[]): () => void {
    for (const key of keys) this.held.set(key, this.used(key) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of keys) {
        const left = this.used(key) - 1;
        if (left <= 0) this.held.delete(key);
        else this.held.set(key, left);
      }
      this.version += 1;
      for (const listener of [...this.listeners]) listener();
    };
  }

  /** A number that changes whenever a place is released. */
  stamp(): number {
    return this.version;
  }

  /**
   * Resolves true once a place has been released after `since`, or false when
   * `signal` aborts first. Nothing is left registered afterwards.
   */
  changed(since: number, signal: AbortSignal): Promise<boolean> {
    if (this.version !== since) return Promise.resolve(true);
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (value: boolean): void => {
        this.listeners.delete(onRelease);
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onRelease = (): void => done(true);
      const onAbort = (): void => done(false);
      this.listeners.add(onRelease);
      signal.addEventListener("abort", onAbort, { once: true });
      this.parked();
    });
  }

  /** The number of steps parked in `changed`. */
  waiting(): number {
    return this.listeners.size;
  }

  /** Resolves once `count` steps are parked in `changed`; no polling. */
  whenWaiting(count: number): Promise<void> {
    if (this.listeners.size >= count) return Promise.resolve();
    return new Promise((resolve) => this.parkWatchers.push({ count, resolve }));
  }

  private readonly parkWatchers: { count: number; resolve: () => void }[] = [];

  private parked(): void {
    for (const watcher of [...this.parkWatchers]) {
      if (this.listeners.size < watcher.count) continue;
      this.parkWatchers.splice(this.parkWatchers.indexOf(watcher), 1);
      watcher.resolve();
    }
  }
}
