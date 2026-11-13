/**
 * Runs a check line list through `shell/check` and, when it fails, once more.
 * A test that crossed its timeout while several checks ran at once is not the
 * task's fault; a second run tells the two apart without parsing any output.
 * A timeout is not rerun: a hang stays a hang.
 */

import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isRecord, messageOf, type PluginStepResult, type StepContext, type StepRunOptions } from "@operad-io/engine";

import type { CheckCommand, FailedRerun } from "./settings.ts";
import {
  CheckPlaceCancelled,
  withCheckPlace,
  type CheckPlaces,
} from "./places.ts";

export interface CheckRun {
  readonly outcome: PluginStepResult | undefined;
  readonly hostError: string | undefined;
  /** Set when the first run failed and the check ran again. */
  readonly rerun: boolean;
  /** A short note for a pass that needed the rerun, otherwise undefined. */
  readonly note: string | undefined;
  /** The tests that failed in a first run and passed when run alone. */
  readonly passedOnRerun: readonly string[];
  /** The `failed` settings of the command whose match found each of those tests. */
  readonly failedBy?: ReadonlyMap<string, FailedRerun> | undefined;
}

/** The line drawn between the two runs in the check log. */
export const RERUN_SEPARATOR = "===== check failed; running it once more =====";

async function once(
  runStep: NonNullable<StepContext["runStep"]>,
  params: Readonly<Record<string, unknown>>,
  options: StepRunOptions,
  places: CheckPlaces | undefined,
): Promise<Pick<CheckRun, "outcome" | "hostError">> {
  try {
    const run = (): Promise<PluginStepResult> =>
      Promise.resolve(runStep("shell/check", params, options));
    return {
      outcome: await (places === undefined ? run() : withCheckPlace(places, run)),
      hostError: undefined,
    };
  } catch (error) {
    if (error instanceof CheckPlaceCancelled) {
      return {
        outcome: { result: "interrupted", data: { reason: "cancelled" } },
        hostError: undefined,
      };
    }
    return { outcome: undefined, hostError: messageOf(error) };
  }
}

function dataOf(outcome: PluginStepResult | undefined): Record<string, unknown> {
  return outcome !== undefined && isRecord(outcome.data) ? outcome.data : {};
}

/** The step's log path, when the outcome names one. */
function logOf(outcome: PluginStepResult | undefined): string | undefined {
  const log = dataOf(outcome).log;
  return typeof log === "string" ? log : undefined;
}

/** Where the step's own output began in the shared log; 0 when it does not say. */
function logStartOf(outcome: PluginStepResult | undefined): number {
  const start = dataOf(outcome).logStart;
  return typeof start === "number" ? start : 0;
}

/** How many bytes the log holds now; a log that cannot be read holds none. */
function sizeOf(path: string | undefined): number {
  if (path === undefined) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** Draws the separator at `offset`, where the first run's output ended. */
function markRerun(
  path: string | undefined,
  offset: number,
  heading: string = RERUN_SEPARATOR,
): void {
  if (path === undefined) return;
  try {
    const bytes = readFileSync(path);
    const before = bytes.subarray(0, offset).toString("utf8");
    const after = bytes.subarray(offset).toString("utf8");
    const gap = before.endsWith("\n") || before.length === 0 ? "" : "\n";
    writeFileSync(path, `${before}${gap}${heading}\n${after}`);
  } catch {
    // A log that cannot be read stays as it is; the result does not depend on it.
  }
}

export async function runCheckWithRerun(
  runStep: NonNullable<StepContext["runStep"]>,
  params: Readonly<Record<string, unknown>>,
  options: StepRunOptions,
  rerun: number,
  places?: CheckPlaces,
  lineOffset = 0,
): Promise<CheckRun> {
  const first = await once(runStep, params, options, places);
  const firstData = dataOf(first.outcome);
  const failed = first.hostError !== undefined || first.outcome?.result === "fail";
  // Only a plain failure is rerun: not a cancel, not a hang.
  if (!failed || rerun <= 0 || firstData.reason === "timeout" || first.hostError !== undefined) {
    return { ...first, rerun: false, note: undefined, passedOnRerun: [] };
  }
  const label =
    typeof firstData.lineNumber === "number"
      ? `check line ${firstData.lineNumber + lineOffset}`
      : "the check";
  let last = first;
  let attempts = 0;
  for (let round = 0; round < rerun; round += 1) {
    const offset = sizeOf(logOf(last.outcome));
    last = await once(runStep, params, options, places);
    attempts += 1;
    markRerun(logOf(last.outcome), offset);
    if (
      last.hostError === undefined &&
      last.outcome?.result === "pass"
    ) {
      return {
        ...last,
        rerun: true,
        passedOnRerun: [],
        note: `${label} failed, passed on rerun${attempts > 1 ? ` ${attempts}` : ""}`,
      };
    }
    if (
      last.hostError !== undefined ||
      last.outcome?.result !== "fail" ||
      dataOf(last.outcome).reason === "timeout"
    ) {
      break;
    }
  }
  return { ...last, rerun: true, note: undefined, passedOnRerun: [] };
}

/* ---------------------------------------------------------------------------
 * Commands that rerun only their failed tests
 * ------------------------------------------------------------------------- */

/** `text` inside single quotes, safe for `sh -c`. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * A regex that matches exactly one test. A failure line joins describe blocks
 * with " > ", while bun's `-t` matches the names joined with a space, so the
 * separator is turned into a space.
 */
export function anchoredPattern(name: string): string {
  const joined = name.replace(/ > /g, " ");
  return `^${joined.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`;
}

/** The rerun command for one failed test. */
export function rerunCommand(template: string, name: string): string {
  return template
    .replace(/\{(name|pattern)\}/g, (_, kind: string) =>
      shellQuote(kind === "name" ? name : anchoredPattern(name)),
    );
}

/** The failed test names `failed.match` finds in `text`, each once, in order. */
export function failedNames(failed: FailedRerun, text: string): string[] {
  const names = new Set<string>();
  for (const found of text.matchAll(new RegExp(failed.match, "gm"))) {
    const name = found[1];
    if (name !== undefined && name.length > 0) names.add(name);
  }
  return [...names];
}

function withLineNumber(
  outcome: PluginStepResult | undefined,
  lineNumber: number,
  message?: string,
): PluginStepResult | undefined {
  if (outcome === undefined) return undefined;
  return {
    ...outcome,
    data: {
      ...dataOf(outcome),
      lineNumber,
      ...(message === undefined ? {} : { message }),
    },
  };
}

/** Reads the log from `offset` on; a log that cannot be read holds no names. */
export function readSince(path: string | undefined, offset: number): string {
  if (path === undefined) return "";
  try {
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      if (size <= offset) return "";
      const buffer = Buffer.allocUnsafe(size - offset);
      let read = 0;
      while (read < buffer.length) {
        const count = readSync(fd, buffer, read, buffer.length - read, offset + read);
        if (count === 0) break;
        read += count;
      }
      return buffer.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

function describePass(names: readonly string[]): string | undefined {
  return names.length === 0
    ? undefined
    : `passed on rerun: ${names.join("; ")}`;
}

/**
 * Runs a list of check commands. A list of plain strings is one `shell/check`
 * with the whole-list rerun. A command with `failed` runs alone; when it exits
 * non-zero and its log names a few failed tests, only those run again.
 */
export async function runCheckCommands(
  runStep: NonNullable<StepContext["runStep"]>,
  base: { readonly cwd: string; readonly timeoutSecs?: number },
  commands: readonly CheckCommand[],
  options: StepRunOptions,
  rerun: number,
  places?: CheckPlaces,
): Promise<CheckRun> {
  const runOf = (command: CheckCommand): string =>
    typeof command === "string" ? command : command.run;
  const failedOf = (command: CheckCommand): FailedRerun | undefined =>
    typeof command === "string" ? undefined : command.failed;
  const paramsFor = (lines: readonly string[]) => ({ ...base, lines });

  if (!commands.some((command) => failedOf(command) !== undefined)) {
    return runCheckWithRerun(
      runStep,
      paramsFor(commands.map(runOf)),
      options,
      rerun,
      places,
    );
  }

  const notes: string[] = [];
  const passed: string[] = [];
  const failedBy = new Map<string, FailedRerun>();
  let reran = false;
  let last: Pick<CheckRun, "outcome" | "hostError"> = {
    outcome: { result: "pass", data: { lines: 0, tail: [] } },
    hostError: undefined,
  };
  const finish = (
    result: Pick<CheckRun, "outcome" | "hostError">,
  ): CheckRun => ({
    ...result,
    rerun: reran,
    passedOnRerun: passed,
    failedBy,
    note: notes.length === 0 ? undefined : notes.join("; "),
  });

  let index = 0;
  while (index < commands.length) {
    const command = commands[index];
    if (command === undefined) break;
    const failed = failedOf(command);
    if (failed === undefined) {
      // A run of commands without `failed` keeps the whole-list rerun.
      let end = index;
      while (end < commands.length) {
        const next = commands[end];
        if (next === undefined || failedOf(next) !== undefined) break;
        end += 1;
      }
      const group = await runCheckWithRerun(
        runStep,
        paramsFor(commands.slice(index, end).map(runOf)),
        options,
        rerun,
        places,
        index,
      );
      reran = reran || group.rerun;
      if (group.note !== undefined) notes.push(group.note);
      const lineNumber = dataOf(group.outcome).lineNumber;
      const outcome =
        typeof lineNumber === "number"
          ? withLineNumber(group.outcome, lineNumber + index)
          : group.outcome;
      last = { outcome, hostError: group.hostError };
      if (group.hostError !== undefined || outcome?.result !== "pass") {
        return finish(last);
      }
      index = end;
      continue;
    }

    const lineNumber = index + 1;
    const first = await once(runStep, paramsFor([runOf(command)]), options, places);
    const firstData = dataOf(first.outcome);
    const numbered = {
      outcome: withLineNumber(first.outcome, lineNumber),
      hostError: first.hostError,
    };
    if (first.hostError === undefined && first.outcome?.result === "pass") {
      last = numbered;
      index += 1;
      continue;
    }
    if (
      first.hostError !== undefined ||
      first.outcome?.result !== "fail" ||
      firstData.reason !== "exit"
    ) {
      return finish(numbered);
    }
    const log = logOf(first.outcome);
    const names = failedNames(failed, readSince(log, logStartOf(first.outcome)));
    if (names.length === 0 || names.length > failed.max) return finish(numbered);

    reran = true;
    for (const name of names) {
      const rerunLine = rerunCommand(failed.rerun, name);
      const heading = `===== rerun of failed test: ${name} =====`;
      const before = sizeOf(log);
      const again = await once(runStep, paramsFor([rerunLine]), options, places);
      markRerun(logOf(again.outcome) ?? log, before, heading);
      const result = {
        outcome: withLineNumber(again.outcome, lineNumber),
        hostError: again.hostError,
      };
      if (again.hostError === undefined && again.outcome?.result === "pass") {
        passed.push(name);
        failedBy.set(name, failed);
        last = result;
        continue;
      }
      return finish({
        outcome: withLineNumber(
          again.outcome,
          lineNumber,
          `the failed test "${name}" failed again when run alone`,
        ),
        hostError: again.hostError,
      });
    }
    const note = describePass(passed);
    if (note !== undefined) notes.push(note);
    index += 1;
  }
  return finish(last);
}
