/** A clock the test moves. */

import type { FakeClock } from "./types.ts";

interface Timer {
  readonly handle: object;
  readonly due: number;
  readonly handler: () => void;
}

/**
 * Time starts at `start` and moves only when `advance` is called. A timer set
 * for `ms` fires when the clock passes `now() + ms`; timers that fall due in
 * one `advance` fire in the order of their due times, and a timer set by a
 * handler is fired too when it falls inside the same advance.
 */
export function fakeClock(start = 0): FakeClock {
  let now = start;
  const timers: Timer[] = [];
  const waiters: Array<() => void> = [];

  const setTimer = (handler: () => void, ms: number): object => {
    const handle = {};
    timers.push({ handle, due: now + Math.max(0, ms), handler });
    for (const resolve of waiters.splice(0)) resolve();
    return handle;
  };

  return {
    now: () => now,
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        let next: Timer | undefined;
        for (const timer of timers) {
          if (timer.due <= target && (next === undefined || timer.due < next.due)) {
            next = timer;
          }
        }
        if (next === undefined) break;
        timers.splice(timers.indexOf(next), 1);
        now = Math.max(now, next.due);
        next.handler();
      }
      now = target;
    },
    get pending(): number {
      return timers.length;
    },
    whenTimer(): Promise<void> {
      if (timers.length > 0) return Promise.resolve();
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    setTimeout: setTimer,
    clearTimeout(handle: unknown): void {
      const index = timers.findIndex((timer) => timer.handle === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => {
        setTimer(resolve, ms);
      });
    },
  };
}
