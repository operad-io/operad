/**
 * The `prepare` commands of dev.json: run in a checkout after it is created or
 * moved to a new commit, before a step uses it. A checkout without them is a
 * plain checkout: dev installs and links nothing itself.
 */

import { isRecord, messageOf, type StepContext, type StepRunOptions } from "@operad-io/engine";

import type { CommandRunner } from "./mainclone.ts";
import type { DevSettings } from "./settings.ts";

/** The reason a step reports when a prepare command failed. */
export const PREPARE_FAILED = "prepare failed";

export function stepOptions(ctx: StepContext, cwd: string): StepRunOptions {
  return {
    runId: ctx.runId,
    cwd,
    ...(ctx.object === undefined ? {} : { object: ctx.object }),
    params: ctx.params,
    access: ctx.access,
    ...(ctx.trigger === undefined ? {} : { trigger: ctx.trigger }),
    signal: ctx.signal,
  };
}

export interface PrepareFailure {
  /** Always `PREPARE_FAILED`. */
  readonly reason: typeof PREPARE_FAILED;
  /** `prepare failed`, then the log path or the host error. */
  readonly message: string;
  readonly log?: string;
}

/**
 * Runs `settings.prepare` in `path`. Returns undefined when it passed or there
 * is nothing to run, otherwise the failure.
 */
export async function runPrepare(
  ctx: StepContext,
  settings: DevSettings,
  path: string,
): Promise<PrepareFailure | undefined> {
  if (settings.prepare.length === 0) return undefined;
  const runStep = ctx.runStep;
  if (runStep === undefined) {
    return {
      reason: PREPARE_FAILED,
      message: `${PREPARE_FAILED}: the kernel did not offer a way to run the prepare commands`,
    };
  }
  try {
    const outcome = await runStep(
      "shell/check",
      {
        cwd: path,
        timeoutSecs: settings.gate.commandTimeoutSecs,
        lines: settings.prepare,
      },
      stepOptions(ctx, path),
    );
    if (outcome.result === "pass") return undefined;
    const data = isRecord(outcome.data) ? outcome.data : {};
    const log = typeof data.log === "string" ? data.log : undefined;
    return {
      reason: PREPARE_FAILED,
      message: `${PREPARE_FAILED}${log === undefined ? "" : `; log: ${log}`}`,
      ...(log === undefined ? {} : { log }),
    };
  } catch (error) {
    return {
      reason: PREPARE_FAILED,
      message: `${PREPARE_FAILED}: ${messageOf(error)}`,
    };
  }
}

/**
 * Runs one prepare line in the main clone through the same step a checkout's
 * prepare lines use, so the shell, the environment and the time limit are the
 * same.
 */
export function mainCloneRunner(ctx: StepContext, settings: DevSettings): CommandRunner {
  return async (cwd, line) => {
    const runStep = ctx.runStep;
    if (runStep === undefined) {
      return { ok: false, out: "the kernel did not offer a way to run the line" };
    }
    try {
      const outcome = await runStep(
        "shell/check",
        { cwd, timeoutSecs: settings.gate.commandTimeoutSecs, lines: [line] },
        stepOptions(ctx, cwd),
      );
      if (outcome.result === "pass") return { ok: true, out: "" };
      const data = isRecord(outcome.data) ? outcome.data : {};
      const tail = Array.isArray(data.tail)
        ? data.tail.filter((row): row is string => typeof row === "string")
        : [];
      const message = typeof data.message === "string" ? data.message : outcome.result;
      return { ok: false, out: tail.join("\n").trim() || message };
    } catch (error) {
      return { ok: false, out: messageOf(error) };
    }
  };
}
