/**
 * Runs a check line list through `shell/check` and, when it fails, once more.
 * A test that crossed its timeout while several checks ran at once is not the
 * task's fault; a second run tells the two apart without parsing any output.
 * A timeout is not rerun: a hang stays a hang.
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  messageOf,
  type PluginStepResult,
  type StepContext,
  type StepRunOptions,
} from "@operad-io/engine";
import { isRecord } from "./model.ts";

export interface CheckRun {
  readonly outcome: PluginStepResult | undefined;
  readonly hostError: string | undefined;
  /** Set when the first run failed and the check ran again. */
  readonly rerun: boolean;
  /** A short note for a pass that needed the rerun, otherwise undefined. */
  readonly note: string | undefined;
}

/** The line drawn between the two runs in the check log. */
export const RERUN_SEPARATOR = "===== check failed; running it once more =====";

async function once(
  runStep: NonNullable<StepContext["runStep"]>,
  params: Readonly<Record<string, unknown>>,
  options: StepRunOptions,
): Promise<Pick<CheckRun, "outcome" | "hostError">> {
  try {
    return {
      outcome: await runStep("shell/check", params, options),
      hostError: undefined,
    };
  } catch (error) {
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

/** How many bytes the log holds now; a log that cannot be read holds none. */
function sizeOf(path: string | undefined): number {
  if (path === undefined) return 0;
  try {
    return readFileSync(path).length;
  } catch {
    return 0;
  }
}

/** Draws the separator at `offset`, where the first run's output ended. */
function markRerun(path: string | undefined, offset: number): void {
  if (path === undefined) return;
  try {
    const bytes = readFileSync(path);
    const before = bytes.subarray(0, offset).toString("utf8");
    const after = bytes.subarray(offset).toString("utf8");
    const gap = before.endsWith("\n") || before.length === 0 ? "" : "\n";
    writeFileSync(path, `${before}${gap}${RERUN_SEPARATOR}\n${after}`);
  } catch {
    // A log that cannot be read stays as it is; the result does not depend on it.
  }
}

export async function runCheckWithRerun(
  runStep: NonNullable<StepContext["runStep"]>,
  params: Readonly<Record<string, unknown>>,
  options: StepRunOptions,
  rerun: number,
): Promise<CheckRun> {
  const first = await once(runStep, params, options);
  const firstData = dataOf(first.outcome);
  const failed = first.hostError !== undefined || first.outcome?.result === "fail";
  // Only a plain failure is rerun: not a cancel, not a hang.
  if (!failed || rerun <= 0 || firstData.reason === "timeout" || first.hostError !== undefined) {
    return { ...first, rerun: false, note: undefined };
  }
  const label =
    typeof firstData.lineNumber === "number"
      ? `check line ${firstData.lineNumber}`
      : "the check";
  let last = first;
  let attempts = 0;
  for (let round = 0; round < rerun; round += 1) {
    const offset = sizeOf(logOf(last.outcome));
    last = await once(runStep, params, options);
    attempts += 1;
    markRerun(logOf(last.outcome), offset);
    if (
      last.hostError === undefined &&
      last.outcome?.result === "pass"
    ) {
      return {
        ...last,
        rerun: true,
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
  return { ...last, rerun: true, note: undefined };
}
