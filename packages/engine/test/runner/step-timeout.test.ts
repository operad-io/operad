import { describe, expect, test } from "bun:test";
import { StepTimeout, type TimeoutClock } from "../../src/runner/runner.ts";

/** A clock the test moves by hand. */
function manualClock(): TimeoutClock & { advance(ms: number): void } {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { due: number; fire: () => void }>();
  return {
    now: () => now,
    set: (fire, ms) => {
      next += 1;
      timers.set(next, { due: now + ms, fire });
      return next;
    },
    clear: (handle) => {
      timers.delete(handle as number);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= now) {
          timers.delete(id);
          timer.fire();
        }
      }
    },
  };
}

describe("a step's wall time", () => {
  test("runs out after its time", () => {
    const clock = manualClock();
    let fired = 0;
    new StepTimeout(100, () => (fired += 1), clock);
    clock.advance(99);
    expect(fired).toBe(0);
    clock.advance(1);
    expect(fired).toBe(1);
  });

  test("stops while a question is open and goes on with what was left", () => {
    const clock = manualClock();
    let fired = 0;
    const timeout = new StepTimeout(100, () => (fired += 1), clock);
    clock.advance(60);
    timeout.pause();
    // Far longer than the whole time, and nothing fires.
    clock.advance(10_000);
    expect(fired).toBe(0);
    timeout.resume();
    clock.advance(39);
    expect(fired).toBe(0);
    clock.advance(1);
    expect(fired).toBe(1);
  });

  test("stays stopped until every open question is over", () => {
    const clock = manualClock();
    let fired = 0;
    const timeout = new StepTimeout(100, () => (fired += 1), clock);
    timeout.pause();
    timeout.pause();
    timeout.resume();
    clock.advance(10_000);
    expect(fired).toBe(0);
    timeout.resume();
    clock.advance(100);
    expect(fired).toBe(1);
  });

  test("a cleared timeout never fires", () => {
    const clock = manualClock();
    let fired = 0;
    const timeout = new StepTimeout(100, () => (fired += 1), clock);
    timeout.clear();
    timeout.pause();
    timeout.resume();
    clock.advance(1000);
    expect(fired).toBe(0);
  });
});
