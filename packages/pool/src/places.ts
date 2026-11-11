/**
 * The places a `pool/agent` run holds. The engine's step limiter only blocks;
 * the pool must ask "is there room" for several workers and take the first,
 * so the counts live here. One serve process owns one home, so one book per
 * plugin instance is the home-wide count.
 */

/** One worker's two counts: its own in the flow and its harness at home. */
export interface Claim {
  readonly own: string;
  readonly ownLimit: number;
  readonly home: string;
  readonly homeLimit: number | undefined;
  /** Who takes the place, so a waiter can say who holds it (a task id). */
  readonly holder?: string | undefined;
}

/** What `claim` answers: a place held for claim `index`, or what is full. */
export type ClaimResult =
  | { readonly kind: "taken"; readonly index: number; readonly release: () => Promise<void> }
  | {
      readonly kind: "blocked";
      /** For each claim, the count that is full. */
      readonly full: readonly ("flow" | "home")[];
      /** For each claim, who holds the places of the count that is full. */
      readonly holders: readonly (readonly string[])[];
      /** Pass to `changed`: a release after it wakes the waiter. */
      readonly stamp: number;
    };

/** Where the places live: in memory (a test) or in the home (the plugin). */
export interface Places {
  /** Atomically takes the first claim that has room in both counts. */
  claim(claims: readonly Claim[]): Promise<ClaimResult>;
  /**
   * Resolves true once something may have been released after `since`, false
   * when `signal` aborts first. A true answer may be spurious; ask again.
   */
  changed(since: number, signal: AbortSignal): Promise<boolean>;
}

export class PlaceBook implements Places {
  private readonly held = new Map<string, number>();
  private readonly labels = new Map<string, string[]>();
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

  claim(claims: readonly Claim[]): Promise<ClaimResult> {
    const full: ("flow" | "home")[] = [];
    const holders: (readonly string[])[] = [];
    for (const [index, claim] of claims.entries()) {
      if (!this.hasRoom(claim.own, claim.ownLimit)) {
        full.push("flow");
        holders.push(this.labels.get(claim.own) ?? []);
      } else if (!this.hasRoom(claim.home, claim.homeLimit)) {
        full.push("home");
        holders.push(this.labels.get(claim.home) ?? []);
      } else {
        const give = this.take([claim.own, claim.home], claim.holder);
        return Promise.resolve({
          kind: "taken",
          index,
          release: () => {
            give();
            return Promise.resolve();
          },
        });
      }
    }
    return Promise.resolve({ kind: "blocked", full, holders, stamp: this.version });
  }

  /** Holds one place under each key and returns the call that gives them back. */
  take(keys: readonly string[], holder?: string): () => void {
    for (const key of keys) {
      this.held.set(key, this.used(key) + 1);
      if (holder !== undefined) this.labels.set(key, [...(this.labels.get(key) ?? []), holder]);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of keys) {
        const left = this.used(key) - 1;
        if (left <= 0) this.held.delete(key);
        else this.held.set(key, left);
        if (holder !== undefined) {
          const rest = [...(this.labels.get(key) ?? [])];
          const at = rest.indexOf(holder);
          if (at >= 0) rest.splice(at, 1);
          if (rest.length === 0) this.labels.delete(key);
          else this.labels.set(key, rest);
        }
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
