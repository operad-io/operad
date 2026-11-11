/**
 * What the hub side of every process harness does the same way: read the
 * step's params, check the directory, read the worker's `result` line and turn
 * the run's outcome into a step result.
 */

import { stat } from "node:fs/promises";
import type { AgentResultData, PluginStepResult } from "@operad-io/engine";
import { MAX_LINE_CHARS, type AgentRunOutcome } from "./process.ts";
import { standardUsage, type RawCounts, type UsageSource } from "./usage.ts";

/** How many of the worker's last stderr lines a failure reason carries. */
const REASON_STDERR_LINES = 5;

/** The `result` line every worker program writes last; a harness adds its own fields. */
export interface AgentWorkerResult {
  readonly type: "result";
  readonly result: "done" | "failed" | "cancelled";
  readonly sessionId: string | null;
  readonly usage: RawCounts;
  /** `quality` is `estimated` for an API-price figure; `incomplete` when some message had no price. */
  readonly cost: {
    readonly micros: number;
    readonly quality?: "estimated" | "exact";
    readonly incomplete?: true;
  } | null;
  readonly finalMessage: string | null;
  /** The model that did the work, when the worker reports it. */
  readonly model?: string | null;
  readonly reason?: string;
  readonly message?: string;
  /** Set when the worker saw a rate limit: it is a usage limit whatever the text says. */
  readonly modelError?: { readonly kind: string };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function paramsObject(params: unknown, at: string): Record<string, unknown> {
  if (!isRecord(params)) throw new Error(`${at}: params: must be an object`);
  return params;
}

export function text(value: unknown, at: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${at}: must be a non-empty string`);
  }
  return value;
}

export function optionalText(value: unknown, at: string): string | undefined {
  return value === undefined ? undefined : text(value, at);
}

export function secs(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${at}: must be a positive number of seconds`);
  }
  return value;
}

export function stringList(value: unknown, at: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${at}: must be an array of strings`);
  }
  return value.filter((item): item is string => typeof item === "string");
}

/** The spelling of one harness's step `args`. */
export interface StepFlagSpec<Level extends string> {
  /** The flag that sets the reasoning level, such as `--effort`. */
  readonly levelFlag: string;
  readonly levels: readonly Level[];
  /** The model value as the usage line shows it, such as `<name>`. */
  readonly modelHint: string;
  /** An error for a model value this harness does not take; undefined when it takes it. */
  readonly modelProblem?: (value: string) => string | undefined;
  /** True when a value may start with `-`, so the model check names it; otherwise a flag after a flag is "no value". */
  readonly dashValues?: boolean;
}

/**
 * Reads `--model <name>` and the level flag from the step's `args`. Anything
 * else is an error message naming the entry: a flag silently ignored would hide
 * a wrong model.
 */
export function parseStepFlags<Level extends string>(
  args: readonly string[],
  spec: StepFlagSpec<Level>,
): { readonly model?: string; readonly level?: Level } | string {
  let model: string | undefined;
  let level: Level | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const entry = args[index] ?? "";
    if (entry !== "--model" && entry !== spec.levelFlag) {
      return `args: unknown entry "${entry}"; expected --model ${spec.modelHint} or ${spec.levelFlag} <level>`;
    }
    const value = args[index + 1];
    // A flag that follows is not a value: `--model --effort high` has none.
    if (value === undefined || (spec.dashValues !== true && value.startsWith("-"))) return `args: "${entry}" has no value`;
    index += 1;
    if (entry === "--model") {
      if (model !== undefined) return `args: "--model" is given twice`;
      if (value.trim().length === 0) return `args: "--model" has no value`;
      const problem = spec.modelProblem?.(value);
      if (problem !== undefined) return problem;
      model = value;
    } else {
      if (level !== undefined) return `args: "${spec.levelFlag}" is given twice`;
      const known = spec.levels.find((candidate) => candidate === value);
      if (known === undefined) {
        return `args: "${spec.levelFlag} ${value}": the value must be one of ${spec.levels.join(", ")}`;
      }
      level = known;
    }
  }
  return {
    ...(model === undefined ? {} : { model }),
    ...(level === undefined ? {} : { level }),
  };
}

export async function directoryError(cwd: string): Promise<string | undefined> {
  try {
    const info = await stat(cwd);
    return info.isDirectory() ? undefined : `cwd is not a directory: ${cwd}`;
  } catch {
    return `cwd does not exist: ${cwd}`;
  }
}

/** Reads a `result` line of the worker, or undefined for any other line. */
export function parseResult<Result extends AgentWorkerResult>(line: string): Result | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.type !== "result") return undefined;
  const name = value.result;
  if (name !== "done" && name !== "failed" && name !== "cancelled") return undefined;
  return value as unknown as Result;
}

const UNAVAILABLE = /\b429\b|\b(?:503|529)\b|overloaded|rate[ _-]?limit|too many requests/i;
const USAGE_LIMIT = /usage[ _-]?limit|quota|exceeded your (?:current )?(?:usage|plan|quota)|insufficient[ _-]credit|out of credits/i;

/**
 * The `modelError` of a worker failure with reason `model_error`, in the shape
 * `harness-radian` gives. `kind` comes from the message: a usage limit is
 * `usage_limit`, a 429 or an overloaded provider is `unavailable`, anything else
 * is `protocol`. A usage-limit message wins over a 429 in the same text.
 */
export function modelErrorOf(message: string): Record<string, unknown> {
  const status = /\b(429|503|529)\b/.exec(message);
  let kind: "unavailable" | "usage_limit" | "protocol" = "protocol";
  if (USAGE_LIMIT.test(message)) kind = "usage_limit";
  else if (UNAVAILABLE.test(message)) kind = "unavailable";
  return {
    kind,
    status: status === null ? null : Number(status[1]),
    retry_after_secs: null,
    message,
  };
}

export function agentData(
  who: UsageSource,
  outcome: AgentRunOutcome,
  result: AgentWorkerResult | undefined,
  log: string,
  durationMs: number,
): AgentResultData {
  const cost =
    result?.cost === null || result?.cost === undefined
      ? null
      : {
          micros: result.cost.micros,
          incomplete: result.cost.incomplete === true,
          estimated: result.cost.quality === "estimated",
        };
  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    sessionId: result?.sessionId ?? null,
    finalMessage: result?.finalMessage ?? null,
    usage: standardUsage(who, result?.usage, cost),
    log,
    durationMs,
    stderr: outcome.stderrTail,
  };
}

export function failure(
  who: UsageSource,
  kind: "failed" | "interrupted",
  outcome: AgentRunOutcome,
  result: AgentWorkerResult | undefined,
  log: string,
  durationMs: number,
  extra: Readonly<Record<string, unknown>>,
): PluginStepResult {
  return {
    result: kind,
    data: { ...agentData(who, outcome, result, log, durationMs), ...extra },
  };
}

export function resultFor(
  who: UsageSource,
  outcome: AgentRunOutcome,
  result: AgentWorkerResult | undefined,
  log: string,
  durationMs: number,
  limits: { readonly wallTimeSecs: number; readonly stallSecs: number },
  command: string,
): PluginStepResult {
  const fail = (extra: Readonly<Record<string, unknown>>): PluginStepResult =>
    failure(who, "failed", outcome, result, log, durationMs, extra);

  if (outcome.cancelled) {
    return failure(who, "interrupted", outcome, result, log, durationMs, {
      reason: "cancelled",
      message: "the harness run was cancelled",
    });
  }
  if (outcome.missing) {
    return fail({ reason: "missing", message: `${command} was not found on PATH` });
  }
  if (outcome.spawnError !== undefined) {
    return fail({ reason: "spawn", message: outcome.spawnError });
  }
  if (outcome.wall) {
    return fail({
      reason: "wall",
      message: `the harness ran longer than ${limits.wallTimeSecs}s`,
    });
  }
  if (outcome.stall) {
    return fail({
      reason: "stall",
      message: `the harness printed no new line for ${limits.stallSecs}s`,
    });
  }
  if (outcome.lineTooLong) {
    return fail({
      reason: "line_too_long",
      message: `the harness printed a line longer than ${MAX_LINE_CHARS} characters`,
    });
  }

  if (result === undefined) {
    const tail = outcome.stderrTail.slice(-REASON_STDERR_LINES).join(" | ");
    const detail = tail.length === 0 ? "" : `: ${tail}`;
    // A signal nobody here sent (kill -9, an out-of-memory kill) is an
    // interruption of the run, not a verdict of the agent.
    if (outcome.signal !== null) {
      return failure(who, "interrupted", outcome, result, log, durationMs, {
        reason: "signal",
        message: `the harness was killed by ${outcome.signal} without a Result line${detail}`,
      });
    }
    return fail({
      reason: "no_result",
      message: `the harness exited ${String(outcome.exitCode)} without a Result line${detail}`,
    });
  }

  if (result.result === "cancelled") {
    return failure(who, "interrupted", outcome, result, log, durationMs, {
      reason: "cancelled",
      message: "the harness run was cancelled",
    });
  }
  if (result.result === "failed") {
    const message = result.message ?? "the harness failed";
    // A rate limit the worker saw is a usage limit whatever the text says.
    const modelError =
      result.modelError !== undefined
        ? { kind: result.modelError.kind, status: null, retry_after_secs: null, message }
        : modelErrorOf(message);
    return fail({
      reason: result.reason ?? "exit",
      message,
      ...(result.reason === "model_error" ? { modelError } : {}),
    });
  }
  if (outcome.exitCode !== 0) {
    return fail({
      reason: "exit",
      message: `the harness exited ${String(outcome.exitCode)} after a done Result`,
    });
  }
  return {
    result: "done",
    data: agentData(who, outcome, result, log, durationMs) as unknown as Record<string, unknown>,
  };
}
