/**
 * Tells a check result that says nothing about the code from one that does,
 * and runs a check so that the first kind is handled without the worker.
 *
 * A check result is "not the code" when any of these holds (the rules live
 * here and nowhere else):
 *
 * 1. `limit`: the command was stopped at the gate's command time limit
 *    (the shell step's reason `timeout`).
 * 2. `signal`: the command ended by a signal nobody in the task sent: the
 *    shell step's reason `signal`, or an exit status of 128+n (129 to 192), as
 *    a shell reports a child that a signal killed. A cancel is a different
 *    reason (`cancelled`) and never lands here.
 * 3. `test-timeout`: the log names at least one failed test, and every one of
 *    them failed at the test timeout or later, within 5% below it. The test
 *    timeout is the `--timeout` of the failing command line, else 30 s. One
 *    failure that took less than that, or no failed test line at all, is an
 *    assertion (or some other failure): the worker's business.
 * 4. `rerun-passed`: every test that failed in the first run passed on its
 *    rerun. The check then passes; the kind tells the flaky-test count whether
 *    the machine was to blame (see `isLoaded`).
 *
 * For a result of kind 1 to 3, `runCheckSteadily` waits until the machine's
 * 1-minute load average is below the limit (`check.loadLimit`, default the
 * number of cores), runs the check once more by itself, and reports a second
 * result of that kind as `notCode`, which the steps turn into a wait for a
 * person.
 */

import { machineLoad, type MachineLoad } from "@operad-io/engine/platform";
import { waitFor } from "./gate.ts";
import { readSince, type CheckRun } from "./rerun.ts";
import { isRecord } from "./model.ts";

/** The kind of a "not the code" result. */
export type NotCodeKind = "limit" | "signal" | "test-timeout" | "rerun-passed";

export interface NotCode {
  readonly kind: NotCodeKind;
  /** What happened, as a waiting line says it ("check timed out"). */
  readonly what: string;
}

/** The test timeout when the command line names none (the repository's bunfig). */
export const DEFAULT_TEST_TIMEOUT_MS = 30_000;

/** How far below the timeout a failure may end and still count as a timeout. */
export const TEST_TIMEOUT_MARGIN = 0.05;

/** How often the wait for a quiet machine looks at the load again. */
export const LOAD_POLL_MS = 30_000;

/** Test-only: a load reader and a wait in place of the real ones. */
export const notCodeTestHooks: {
  load?: (() => MachineLoad) | undefined;
  wait?: ((ms: number, signal: AbortSignal | undefined) => Promise<boolean>) | undefined;
} = {};

export function currentLoad(): MachineLoad {
  return (notCodeTestHooks.load ?? machineLoad)();
}

/** The load limit: the setting, else the number of cores. */
export function loadLimitOf(configured: number | undefined, load: MachineLoad): number {
  return configured ?? load.cores;
}

/** True when the machine is too busy to trust a check: load at or above the limit. */
export function isLoaded(load: MachineLoad, configured: number | undefined): boolean {
  return load.load1 >= loadLimitOf(configured, load);
}

export interface FailedTest {
  readonly name: string;
  readonly ms: number;
}

const FAIL_LINE = /^\(fail\) (.+?) \[(\d+(?:\.\d+)?)(ms|s)\]\s*$/;

/** The failed tests a bun log lists, each once, with how long it ran. */
export function failedTests(log: string): FailedTest[] {
  const seen = new Map<string, number>();
  for (const line of log.replace(/\r\n/g, "\n").split("\n")) {
    const found = FAIL_LINE.exec(line);
    if (found === null) continue;
    const name = found[1] ?? "";
    const amount = Number(found[2]);
    const ms = found[3] === "s" ? amount * 1000 : amount;
    if (!seen.has(name)) seen.set(name, ms);
  }
  return [...seen].map(([name, ms]) => ({ name, ms }));
}

/** The `--timeout` of a command line in milliseconds; the default when it names none. */
export function testTimeoutOf(line: string | undefined): number {
  const found = /--timeout(?:=|\s+)(\d+)/.exec(line ?? "");
  const ms = found === null ? NaN : Number(found[1]);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TEST_TIMEOUT_MS;
}

/** What the classifier is given about one finished check. */
export interface CheckFacts {
  /** The shell step's result: `pass`, `fail` or another. */
  readonly result: string | undefined;
  /** The shell step's reason for a failure: `exit`, `signal`, `timeout`, `cancelled`. */
  readonly reason?: string | undefined;
  readonly exitCode?: number | null | undefined;
  readonly signal?: string | null | undefined;
  /** The failing command line. */
  readonly line?: string | undefined;
  /** The check's own output, from where its last run began. */
  readonly log: string;
  /** The check failed once and passed when it, or its failed tests, ran again. */
  readonly rerunPassed?: boolean | undefined;
}

/** Whether a check result says nothing about the code, and what it says instead. */
export function classifyCheck(facts: CheckFacts): NotCode | undefined {
  if (facts.result === "pass") {
    return facts.rerunPassed === true
      ? { kind: "rerun-passed", what: "a test passed on rerun" }
      : undefined;
  }
  if (facts.result !== "fail") return undefined;
  if (facts.reason === "timeout") return { kind: "limit", what: "check timed out" };
  const code = facts.exitCode;
  if (
    facts.reason === "signal" ||
    (facts.reason === "exit" && typeof code === "number" && code > 128 && code <= 192)
  ) {
    const number = typeof code === "number" && code > 128 ? `signal ${code - 128}` : undefined;
    const name = facts.signal ?? number ?? "a signal";
    return { kind: "signal", what: `check was killed by ${name}` };
  }
  if (facts.reason !== "exit") return undefined;
  const failed = failedTests(facts.log);
  if (failed.length === 0) return undefined;
  const timeout = testTimeoutOf(facts.line);
  const floor = timeout * (1 - TEST_TIMEOUT_MARGIN);
  if (failed.every((test) => test.ms >= floor)) {
    return { kind: "test-timeout", what: "tests timed out" };
  }
  return undefined;
}

/** The facts of a finished check, read from its outcome and its log. */
export function factsOf(checked: CheckRun): CheckFacts {
  const outcome = checked.outcome;
  const data = outcome !== undefined && isRecord(outcome.data) ? outcome.data : {};
  const log = typeof data.log === "string" ? data.log : undefined;
  const start = typeof data.logStart === "number" ? data.logStart : 0;
  return {
    result: checked.hostError === undefined ? outcome?.result : "host-error",
    reason: typeof data.reason === "string" ? data.reason : undefined,
    exitCode: typeof data.exitCode === "number" ? data.exitCode : null,
    signal: typeof data.signal === "string" ? data.signal : null,
    line: typeof data.line === "string" ? data.line : undefined,
    log: log === undefined ? "" : readSince(log, start),
    rerunPassed: checked.hostError === undefined && checked.rerun && outcome?.result === "pass",
  };
}

/** The kind of a finished check, or undefined when it says something about the code. */
export function classifyRun(checked: CheckRun): NotCode | undefined {
  return classifyCheck(factsOf(checked));
}

/** True for the kinds that a quiet machine and another run may undo. */
function worthAnotherRun(found: NotCode | undefined): found is NotCode {
  return found !== undefined && found.kind !== "rerun-passed";
}

/** The waiting line for a check that came out the same way twice. */
export function notCodeCause(found: NotCode, load: MachineLoad): string {
  return `${found.what} twice under load ${Math.round(load.load1)} on ${load.cores} cores`;
}

/** The load when one run of a command started and when it ended. */
export interface CheckLoad {
  readonly start: MachineLoad;
  readonly end: MachineLoad;
}

export interface SteadyCheck {
  readonly checked: CheckRun;
  /** Set when the check ended "not the code" twice: a person decides. */
  readonly notCode?: { readonly cause: string; readonly kind: NotCodeKind } | undefined;
  /** How many times the check ran (1 or 2). */
  readonly runs: number;
  /** The busiest the machine was when the check started and when each run ended. */
  readonly load: MachineLoad;
  /** The load at the start and the end of each run of the command. */
  readonly loads: readonly CheckLoad[];
  /** Set when the run was cancelled while it waited for the load. */
  readonly cancelled?: boolean | undefined;
}

/** Waits until the load is below the limit; false when cancelled. */
async function waitForQuiet(
  limit: number | undefined,
  signal: AbortSignal | undefined,
  onLog: (text: string) => Promise<unknown> | unknown,
): Promise<boolean> {
  const wait = notCodeTestHooks.wait ?? waitFor;
  let said = false;
  for (;;) {
    if (signal?.aborted === true) return false;
    const load = currentLoad();
    if (!isLoaded(load, limit)) return true;
    if (!said) {
      said = true;
      try {
        await onLog(
          `check was not the code; waiting for the load (${load.load1}) to fall below ${loadLimitOf(limit, load)} on ${load.cores} cores`,
        );
      } catch {
        // A note that could not be written does not change the wait.
      }
    }
    if (!(await wait(LOAD_POLL_MS, signal))) return false;
  }
}

/**
 * Runs a check. A result that is not the code waits for a quiet machine and
 * runs once more; the second run's result stands, and a second result that is
 * not the code is reported in `notCode`.
 */
export async function runCheckSteadily(input: {
  readonly run: () => Promise<CheckRun>;
  readonly limit: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly log?: ((text: string) => Promise<unknown> | unknown) | undefined;
}): Promise<SteadyCheck> {
  const firstStart = currentLoad();
  let peak = firstStart;
  const sample = (): MachineLoad => {
    const now = currentLoad();
    if (now.load1 > peak.load1) peak = now;
    return now;
  };
  const first = await input.run();
  const firstEnd = sample();
  const loads: CheckLoad[] = [{ start: firstStart, end: firstEnd }];
  if (!worthAnotherRun(classifyRun(first))) {
    return { checked: first, runs: 1, load: peak, loads };
  }
  if (!(await waitForQuiet(input.limit, input.signal, input.log ?? (() => {})))) {
    return { checked: first, runs: 1, load: peak, loads, cancelled: true };
  }
  const secondStart = sample();
  const second = await input.run();
  const after = sample();
  loads.push({ start: secondStart, end: after });
  const found = classifyRun(second);
  if (!worthAnotherRun(found)) {
    return { checked: second, runs: 2, load: peak, loads };
  }
  return {
    checked: second,
    runs: 2,
    load: peak,
    loads,
    notCode: { cause: notCodeCause(found, after), kind: found.kind },
  };
}
