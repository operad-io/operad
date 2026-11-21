/** A clock the test fires, for a test only. */

import type { Clock } from "../platform/index.ts";

interface Timer {
  readonly handler: () => void;
  readonly ms: number;
  readonly deadline: number;
  live: boolean;
}

interface Waiter {
  readonly predicate: () => boolean;
  readonly resolve: () => void;
}

export interface ManualClock extends Clock {
  /** Fires every timeout still scheduled; returns how many there were. */
  fireTimeouts(): number;
  /** Alias of `fireTimeouts`, for a test that only wants the timers it made. */
  fireTimers(): number;
  /** Fires only the timeouts set for `ms`; the others stay armed. */
  fireTimeoutsOf(ms: number): number;
  /** Fires every timeout whose requested delay is at most `maxMs`. */
  fireUpTo(maxMs?: number): number;
  /** Fires every timeout whose requested delay is above `minMs` and at most `maxMs`. */
  fireBetween(minMs: number, maxMs: number): number;
  /** Moves time forward, firing only the timeouts that are then due. */
  advance(ms: number): number;
  /** Moves time to `ms` from the start, for a test that names a deadline. */
  advanceTo(ms: number): number;
  /** Resolves once `predicate` holds; every timer change rechecks it. */
  when(predicate: () => boolean): Promise<void>;
  /** How many timeouts are scheduled right now. */
  readonly pending: number;
  /** How many timeouts have been scheduled, a new one after each output line. */
  readonly scheduled: number;
  /** How many grace waits were requested. */
  readonly sleeps: number;
  /** How many timers were cancelled, which shows a stall timer was reset. */
  readonly clears: number;
  /** Every timer set so far, with `live` false once fired or cleared. */
  readonly timers: readonly {
    readonly handler: () => void;
    readonly ms: number;
    readonly live: boolean;
  }[];
}

/**
 * A clock a test drives: timeouts run only when the test fires them, and a
 * grace wait returns at once. No test waits for real time: a test that needs
 * to know a timer exists asks `when` and is woken by a timer change.
 */
export function manualClock(): ManualClock {
  const timers = new Set<Timer>();
  const waiters: Waiter[] = [];
  let sleeps = 0;
  let scheduled = 0;
  let clears = 0;
  let now = 0;

  const notify = (): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter === undefined || !waiter.predicate()) continue;
      waiters.splice(index, 1);
      waiter.resolve();
    }
  };

  const fire = (due: readonly Timer[]): number => {
    for (const timer of due) {
      timer.live = false;
      timers.delete(timer);
    }
    for (const timer of due) timer.handler();
    notify();
    return due.length;
  };

  const clock: ManualClock = {
    setTimeout(handler, ms = 0) {
      const timer = { handler, ms, deadline: now + ms, live: true };
      timers.add(timer);
      scheduled += 1;
      notify();
      return timer;
    },
    clearTimeout(handle) {
      clears += 1;
      const timer = handle as Timer;
      timer.live = false;
      timers.delete(timer);
      notify();
    },
    sleep() {
      sleeps += 1;
      return Promise.resolve();
    },
    fireTimeouts() {
      return fire([...timers]);
    },
    fireTimers() {
      return fire([...timers]);
    },
    fireTimeoutsOf(ms) {
      return fire([...timers].filter((timer) => timer.ms === ms));
    },
    fireUpTo(maxMs = Number.POSITIVE_INFINITY) {
      return fire([...timers].filter((timer) => timer.ms <= maxMs));
    },
    fireBetween(minMs, maxMs) {
      return fire(
        [...timers].filter((timer) => timer.ms > minMs && timer.ms <= maxMs),
      );
    },
    advance(ms) {
      now += ms;
      const due = [...timers]
        .filter((timer) => timer.deadline <= now)
        .sort((left, right) => left.deadline - right.deadline);
      return fire(due);
    },
    advanceTo(ms) {
      if (ms <= now) return 0;
      return clock.advance(ms - now);
    },
    when(predicate) {
      if (predicate()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.push({ predicate, resolve });
      });
    },
    get pending() {
      return timers.size;
    },
    get scheduled() {
      return scheduled;
    },
    get sleeps() {
      return sleeps;
    },
    get clears() {
      return clears;
    },
    get timers() {
      return [...timers];
    },
  };
  return clock;
}
