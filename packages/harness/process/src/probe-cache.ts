/**
 * A short-lived answer from a probe, shared by every caller that asks for the
 * same key at the same time. Harnesses use it around a child process that is
 * slow enough for two clients to ask at once, such as a login check.
 */

export interface CachedProbeOptions {
  /** The time now in milliseconds. */
  readonly now: () => number;
  /** How long one answer is kept. */
  readonly ttlMs: number;
}

/**
 * Creates a cache for one kind of probe. A fresh answer is returned without
 * running the probe; a miss starts one probe per key, which concurrent callers
 * share, and keeps its answer, including an absent one.
 */
export function createCachedProbe<T>(
  options: CachedProbeOptions,
): (key: string, probe: () => Promise<T>) => Promise<T> {
  const cache = new Map<string, { readonly at: number; readonly value: T }>();
  const pending = new Map<string, Promise<T>>();
  return (key, probe) => {
    const kept = cache.get(key);
    if (kept !== undefined && options.now() - kept.at < options.ttlMs) {
      return Promise.resolve(kept.value);
    }
    const running = pending.get(key);
    if (running !== undefined) return running;
    const loading = Promise.resolve()
      .then(probe)
      .then((value) => {
        cache.set(key, { at: options.now(), value });
        return value;
      })
      .finally(() => {
        pending.delete(key);
      });
    pending.set(key, loading);
    return loading;
  };
}
