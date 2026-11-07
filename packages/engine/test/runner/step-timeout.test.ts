import { afterEach, describe, expect, jest, test } from "bun:test";
import { StepTimeout } from "../../src/runner/runner.ts";

afterEach(() => jest.useRealTimers());

describe("a step's wall time", () => {
  test("runs out after its time", () => {
    jest.useFakeTimers();
    let fired = 0;
    new StepTimeout(100, () => (fired += 1));
    jest.advanceTimersByTime(99);
    expect(fired).toBe(0);
    jest.advanceTimersByTime(1);
    expect(fired).toBe(1);
  });

  test("stops while a question is open and goes on with what was left", () => {
    jest.useFakeTimers();
    let fired = 0;
    const timeout = new StepTimeout(100, () => (fired += 1));
    jest.advanceTimersByTime(60);
    timeout.pause();
    // Far longer than the whole time, and nothing fires.
    jest.advanceTimersByTime(10_000);
    expect(fired).toBe(0);
    timeout.resume();
    jest.advanceTimersByTime(39);
    expect(fired).toBe(0);
    jest.advanceTimersByTime(1);
    expect(fired).toBe(1);
  });

  test("stays stopped until every open question is over", () => {
    jest.useFakeTimers();
    let fired = 0;
    const timeout = new StepTimeout(100, () => (fired += 1));
    timeout.pause();
    timeout.pause();
    timeout.resume();
    jest.advanceTimersByTime(10_000);
    expect(fired).toBe(0);
    timeout.resume();
    jest.advanceTimersByTime(100);
    expect(fired).toBe(1);
  });

  test("a cleared timeout never fires", () => {
    jest.useFakeTimers();
    let fired = 0;
    const timeout = new StepTimeout(100, () => (fired += 1));
    timeout.clear();
    timeout.pause();
    timeout.resume();
    jest.advanceTimersByTime(1000);
    expect(fired).toBe(0);
  });
});
