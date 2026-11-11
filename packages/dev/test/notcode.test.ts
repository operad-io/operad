import { afterEach, describe, expect, test } from "bun:test";
import {
  classifyCheck,
  failedTests,
  isLoaded,
  notCodeTestHooks,
  runCheckSteadily,
  testTimeoutOf,
  type CheckFacts,
  type NotCodeKind,
} from "../src/notcode.ts";
import type { CheckRun } from "../src/rerun.ts";
import { classifyStop, isConnectionError, STOP_REASONS } from "../src/stops.ts";
import { validateDevSettings } from "../src/settings.ts";

afterEach(() => {
  notCodeTestHooks.load = undefined;
  notCodeTestHooks.wait = undefined;
});

const fail = (extra: Partial<CheckFacts>): CheckFacts => ({ result: "fail", reason: "exit", log: "", ...extra });
const slowLog = "(fail) a > slow [30001.20ms]\n(fail) b > slow [30010.00ms]\n";

describe("classifyCheck", () => {
  const table: readonly [string, CheckFacts, NotCodeKind | undefined][] = [
    ["a command stopped at the gate's time limit", fail({ reason: "timeout" }), "limit"],
    ["a command killed by a signal", fail({ reason: "signal", signal: "SIGKILL" }), "signal"],
    ["an exit status of 128+n", fail({ exitCode: 143 }), "signal"],
    ["an exit status of 1", fail({ exitCode: 1 }), undefined],
    ["an exit status past 128+64", fail({ exitCode: 200 }), undefined],
    ["every failed test at the timeout", fail({ log: slowLog }), "test-timeout"],
    ["a test just under the timeout, within the margin", fail({ log: "(fail) a [29000.00ms]\n" }), "test-timeout"],
    ["one failed test that was quick", fail({ log: `${slowLog}(fail) c [4.00ms]\n` }), undefined],
    ["a failed test far under the timeout", fail({ log: "(fail) a [20000.00ms]\n" }), undefined],
    ["a failure with no failed test line", fail({ log: "error: cannot find module\n" }), undefined],
    ["the timeout named on the command line", fail({ line: "bun test --timeout 120000 x", log: slowLog }), undefined],
    ["a failure that was not rerun and was cancelled", fail({ reason: "cancelled" }), undefined],
    ["a pass on rerun", { result: "pass", log: "", rerunPassed: true }, "rerun-passed"],
    ["a plain pass", { result: "pass", log: "" }, undefined],
  ];
  for (const [name, facts, kind] of table) {
    test(`${name}: ${kind ?? "the code"}`, () => {
      expect(classifyCheck(facts)?.kind).toBe(kind);
    });
  }

  test("the log lists each failed test once, with its time", () => {
    expect(failedTests("(fail) x > y [1.5s]\n(fail) x > y [1.5s]\nnoise")).toEqual([{ name: "x > y", ms: 1500 }]);
    expect(testTimeoutOf("bun test --timeout=5000")).toBe(5000);
    expect(testTimeoutOf(undefined)).toBe(30000);
  });

  test("a machine is loaded at or above the limit; the default limit is the cores", () => {
    expect(isLoaded({ load1: 10, cores: 10 }, undefined)).toBe(true);
    expect(isLoaded({ load1: 9.9, cores: 10 }, undefined)).toBe(false);
    expect(isLoaded({ load1: 3, cores: 10 }, 2)).toBe(true);
  });
});

function run(extra: Record<string, unknown>, result = "fail"): CheckRun {
  return {
    outcome: { result, data: extra },
    hostError: undefined,
    rerun: false,
    note: undefined,
    passedOnRerun: [],
  };
}

describe("runCheckSteadily", () => {
  test("a timeout waits for a quiet machine, runs once more, and the second result stands", async () => {
    let load = 18;
    notCodeTestHooks.load = () => ({ load1: load, cores: 10 });
    let waits = 0;
    notCodeTestHooks.wait = async () => {
      waits += 1;
      if (waits === 2) load = 4;
      return true;
    };
    const results = [run({ reason: "timeout" }), run({}, "pass")];
    let calls = 0;
    const steady = await runCheckSteadily({ run: async () => results[calls++] as CheckRun, limit: undefined });
    expect(calls).toBe(2);
    expect(waits).toBe(2);
    expect(steady.checked.outcome?.result).toBe("pass");
    expect(steady.notCode).toBeUndefined();
  });

  test("a second timeout goes to a person, after the load stayed high past an hour", async () => {
    let load = 18.4;
    notCodeTestHooks.load = () => ({ load1: load, cores: 10 });
    let waits = 0;
    notCodeTestHooks.wait = async () => {
      waits += 1;
      // The check may not run while the load is high, however long that lasts.
      if (waits === 3) load = 2;
      return true;
    };
    let calls = 0;
    const steady = await runCheckSteadily({
      run: async () => {
        calls += 1;
        // The second run sees the same high load the waiting line names.
        if (calls === 2) load = 18;
        return run({ reason: "timeout" });
      },
      limit: undefined,
    });
    expect(waits).toBe(3);
    expect(calls).toBe(2);
    expect(steady.notCode?.cause).toBe("check timed out twice under load 18 on 10 cores");
  });

  test("an assertion failure runs once and does not wait", async () => {
    notCodeTestHooks.load = () => ({ load1: 18, cores: 10 });
    notCodeTestHooks.wait = async () => {
      throw new Error("must not wait");
    };
    let calls = 0;
    const steady = await runCheckSteadily({
      run: async () => (calls++, run({ log: undefined, reason: "exit", exitCode: 1 })),
      limit: undefined,
    });
    expect(calls).toBe(1);
    expect(steady.notCode).toBeUndefined();
  });

  test("a cancel while waiting stops without a second run", async () => {
    notCodeTestHooks.load = () => ({ load1: 18, cores: 10 });
    notCodeTestHooks.wait = async () => false;
    let calls = 0;
    const steady = await runCheckSteadily({ run: async () => (calls++, run({ reason: "timeout" })), limit: undefined });
    expect(calls).toBe(1);
    expect(steady.cancelled).toBe(true);
  });
});

describe("runCheckSteadily records the load", () => {
  test("the start and the end of the command, each as it was read", async () => {
    const readings = [30, 1];
    let index = 0;
    notCodeTestHooks.load = () => ({
      load1: readings[Math.min(index++, readings.length - 1)] ?? 0,
      cores: 10,
    });
    const steady = await runCheckSteadily({
      run: async () => run({ reason: "exit", exitCode: 1 }),
      limit: undefined,
    });
    expect(steady.loads).toEqual([
      { start: { load1: 30, cores: 10 }, end: { load1: 1, cores: 10 } },
    ]);
  });
});

describe("a model connection error is a stop outside the task's work", () => {
  test("the host's words for a dropped connection are recognised", () => {
    expect(isConnectionError("The socket connection was closed unexpectedly")).toBe(true);
    expect(isConnectionError("read ECONNRESET")).toBe(true);
    expect(isConnectionError("the model said no")).toBe(false);
    expect(isConnectionError(undefined)).toBe(false);
  });

  test("the retry step treats it as environment", () => {
    const verdict = classifyStop({ step: "work", result: "failed", reason: STOP_REASONS.connection });
    expect(verdict.kind).toBe("environment");
    expect(verdict.cause).toContain("connection");
  });
});

describe("check.loadLimit", () => {
  test("is unset by default and takes a positive number", () => {
    expect(validateDevSettings({ name: "x" }).check.loadLimit).toBeUndefined();
    expect(validateDevSettings({ name: "x", check: { loadLimit: 6.5 } }).check.loadLimit).toBe(6.5);
    expect(() => validateDevSettings({ name: "x", check: { loadLimit: 0 } })).toThrow(/loadLimit/);
  });
});
