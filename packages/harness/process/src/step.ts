/**
 * What the hub side of every process harness does the same way: read the
 * step's params, check the directory, read the worker's `result` line and turn
 * the run's outcome into a step result.
 */

import { directoryError } from "@operad-io/engine";
import type { AgentCompaction, AgentResultData, CostQuality, PluginStepResult } from "@operad-io/engine";
import { MAX_SKIPPED_LINE_CHARS, type AgentRunOutcome } from "./process.ts";
import { standardUsage, type RawCounts, type UsageSource } from "./usage.ts";
import { isRecord } from "@operad-io/engine";

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
    readonly quality?: CostQuality;
    readonly incomplete?: true;
  } | null;
  readonly finalMessage: string | null;
  /** Set when this run compacted the session: tokens before and after, and whether a memory flush ran first. */
  readonly compaction?: AgentCompaction | undefined;
  /** The model that did the work, when the worker reports it. */
  readonly model?: string | null;
  /** The context at the end of a finished reply, when the worker can tell. */
  readonly context?: {
    readonly used: number;
    readonly window?: number;
  } | undefined;
  readonly reason?: string;
  readonly message?: string;
  /** Set when the worker saw a rate limit: it is a usage limit whatever the text says. */
  readonly modelError?: {
    readonly kind: string;
    readonly status?: number | null;
    readonly retry_after_secs?: number | null;
    /** When the model gave the error, in epoch milliseconds, when the worker can tell. */
    readonly reported_at?: number | null;
  };
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

/** A positive number in a setting, or undefined when it is unset; names the field when it is not. */
export function optionalPositive(value: unknown, at: string, integer: boolean): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${at}: must be a positive ${integer ? "integer" : "number"}`);
  }
  return value;
}

export function stringListParam(value: unknown, at: string): readonly string[] {
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

export { directoryError };

/** Reads a worker's `result` value, or undefined when it is another line. */
export function resultValue<Result extends AgentWorkerResult>(value: unknown): Result | undefined {
  if (!isRecord(value) || value.type !== "result") return undefined;
  const name = value.result;
  if (name !== "done" && name !== "failed" && name !== "cancelled") return undefined;
  return value as unknown as Result;
}

const UNAVAILABLE = /\b429\b|\b(?:503|529)\b|overloaded|rate[ _-]?limit|too many requests/i;
const USAGE_LIMIT = /usage[ _-]?limit|quota|exceeded your (?:current )?(?:usage|plan|quota)|insufficient[ _-]credit|out of credits/i;
/** A provider's own retry-after or reset wait: the number and its unit. */
const RETRY_AFTER = /\b(?:retry[- ]after|try again (?:in|after)|retry in|available(?: again)? in|resets? in)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|mo(?:nths?)?)?(?![a-z])/i;

/**
 * The seconds a model's message says to wait, from a retry-after or reset
 * phrase. A bare number after such a phrase is seconds. Undefined when the
 * message gives no such wait; a date or a time of day is not read, because its
 * day is unknown.
 */
export function retryAfterSecsOf(message: string): number | undefined {
  const found = RETRY_AFTER.exec(message);
  if (found === null) return undefined;
  const unit = found[2];
  // A word after the number is a unit this parser does not know, not seconds.
  if (
    unit === undefined &&
    /^\s*[a-z]/i.test(message.slice(found.index + found[0].length))
  ) {
    return undefined;
  }
  const value = Number(found[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unitName = (unit ?? "s").toLowerCase();
  const factor =
    unitName.startsWith("millisecond") || unitName === "ms"
      ? 1 / 1000
      : unitName.startsWith("min") || unitName === "m"
        ? 60
        : unitName.startsWith("h")
          ? 60 * 60
          : unitName.startsWith("mo")
            ? 30 * 24 * 60 * 60
            : unitName.startsWith("w")
              ? 7 * 24 * 60 * 60
              : unitName.startsWith("d")
                ? 24 * 60 * 60
                : 1;
  const seconds = Math.ceil(value * factor);
  return seconds > 0 ? seconds : undefined;
}

/**
 * The `modelError` of a worker failure with reason `model_error`, in the shape
 * `radian` gives. `kind` comes from the message: a usage limit is
 * `usage_limit`, a 429 or an overloaded provider is `unavailable`, anything else
 * is `protocol`. A usage-limit message wins over a 429 in the same text. A wait
 * the message names is `retry_after_secs`; without one it is null.
 */
export function modelErrorOf(message: string): Record<string, unknown> {
  const status = /\b(429|503|529)\b/.exec(message);
  let kind: "unavailable" | "usage_limit" | "protocol" = "protocol";
  if (USAGE_LIMIT.test(message)) kind = "usage_limit";
  else if (UNAVAILABLE.test(message)) kind = "unavailable";
  return {
    kind,
    status: status === null ? null : Number(status[1]),
    retry_after_secs: retryAfterSecsOf(message) ?? null,
    message,
  };
}

/** A worker's end-of-reply context, when it has a whole token count. */
export function contextOf(value: unknown): { readonly used: number; readonly window?: number } | undefined {
  if (!isRecord(value)) return undefined;
  const used = value.used;
  if (typeof used !== "number" || !Number.isInteger(used) || used < 0) return undefined;
  const window = value.window;
  const known = typeof window === "number" && Number.isInteger(window) && window > 0 ? window : undefined;
  return { used, ...(known === undefined ? {} : { window: known }) };
}

/** A worker's compaction note, when it has one in the shape the chat reads. */
function compactionOf(value: unknown): AgentCompaction | undefined {
  if (!isRecord(value)) return undefined;
  const before = value.before;
  const after = value.after;
  if (typeof before !== "number" || !Number.isFinite(before)) return undefined;
  return {
    reason: value.reason === "manual" ? "manual" : "threshold",
    before,
    ...(typeof after === "number" && Number.isFinite(after) ? { after } : {}),
    flushed: value.flushed === true,
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
  const context = contextOf(result?.context);
  const compaction = compactionOf(result?.compaction);
  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    sessionId: result?.sessionId ?? null,
    finalMessage: result?.finalMessage ?? null,
    ...(result?.message === undefined ? {} : { message: result.message }),
    usage: standardUsage(who, result?.usage, cost),
    ...(context === undefined ? {} : { context }),
    ...(compaction === undefined ? {} : { compacted: true as const, compaction }),
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
      message: `the harness printed a line longer than ${MAX_SKIPPED_LINE_CHARS} characters without ending`,
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
    const byText = modelErrorOf(message);
    const given = result.modelError;
    const positive = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : undefined;
    const retryAfterSecs =
      positive(given?.retry_after_secs) ?? positive(byText["retry_after_secs"]);
    const modelError =
      given !== undefined
        ? {
            kind: given.kind,
            status: positive(given.status) ?? positive(byText["status"]) ?? null,
            retry_after_secs: retryAfterSecs ?? null,
            ...(retryAfterSecs === undefined
              ? {}
              : { reported_at: positive(given.reported_at) ?? Date.now() }),
            message,
          }
        : {
            ...byText,
            ...(retryAfterSecs === undefined
              ? {}
              : { reported_at: Date.now() }),
          };
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
