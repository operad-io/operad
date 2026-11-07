/**
 * The radian harness: one `agent` step that runs `radian exec` in a directory
 * and reads its closing Result record, plus the `harness-radian:prompt` flow
 * that runs one prompt. Only the plugin interface and the process helper are
 * used; the kernel never knows how radian is started.
 */

import { stat } from "node:fs/promises";
import {
  defineFlow,
  definePlugin,
  type AgentResultData,
  type HarnessCost,
  type HarnessUsage,
  type PluginStepResult,
  type StepContext,
} from "@operad-io/engine";
import {
  eventNote,
  findCommand,
  JsonlLog,
  MAX_LINE_CHARS,
  runAgent,
  systemClock,
  type AgentRunOutcome,
  type Clock,
  type ToolEvent,
} from "@operad-io/harness-process";

export { EVENT_NOTE_TEMPLATE, eventNote } from "@operad-io/harness-process";

/** How long an agent may run before the step stops it. */
export const DEFAULT_WALL_TIME_SECS = 300;

/** How long an agent may go without a new output line. */
export const DEFAULT_STALL_SECS = 600;

/**
 * A prompt longer than this goes through stdin. It is well below the OS
 * argument limit, so the argv never approaches it.
 */
export const PROMPT_ARG_SAFE_BYTES = 128 * 1024;

/**
 * Reads one radian JSONL line and reports the tool call it starts or settles.
 * Radian writes the event under `event` and a type under `type`.
 */
export function radianToolEvent(line: string): ToolEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const event = typeof value.event === "string" ? value.event : value.type;
  if (event === "ToolExecutionStarted") return "tool-start";
  if (event === "ToolExecutionSettled") return "tool-end";
  return undefined;
}

/** Settings for one radian harness plugin. A test injects a clock. */
export interface RadianHarnessSettings {
  /** The command name or path; defaults to `radian`. */
  readonly command?: string | undefined;
  /** The default wall-time limit in seconds. */
  readonly wallTimeSecs?: number | undefined;
  /** The default stall limit in seconds. */
  readonly stallSecs?: number | undefined;
  readonly clock?: Clock | undefined;
}

interface ResolvedSettings {
  readonly command: string;
  readonly wallTimeSecs: number;
  readonly stallSecs: number;
  readonly clock: Clock;
}

/** The settings a config.json section may set for this plugin. */
const PLUGIN_SETTINGS = {
  type: "object" as const,
  properties: {
    command: {
      type: "string" as const,
      description: "The radian executable to run.",
    },
    wallTimeSecs: {
      type: "number" as const,
      description: "The longest one agent run may take.",
    },
    stallSecs: {
      type: "number" as const,
      description: "How long an agent may be silent between tool calls.",
    },
  },
  additionalProperties: false as const,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function paramsObject(params: unknown, at: string): Record<string, unknown> {
  if (!isRecord(params)) {
    throw new Error(`${at}: params: must be an object`);
  }
  return params;
}

function text(value: unknown, at: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${at}: must be a non-empty string`);
  }
  return value;
}

function secs(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${at}: must be a positive number of seconds`);
  }
  return value;
}

function stringList(value: unknown, at: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${at}: must be an array of strings`);
  }
  return [...value];
}

function optionalText(value: unknown, at: string): string | undefined {
  if (value === undefined) return undefined;
  return text(value, at);
}

/** The reason a directory cannot be a working directory, if it cannot. */
async function directoryError(cwd: string): Promise<string | undefined> {
  try {
    const info = await stat(cwd);
    return info.isDirectory() ? undefined : `cwd is not a directory: ${cwd}`;
  } catch {
    return `cwd does not exist: ${cwd}`;
  }
}

interface ParsedResult {
  readonly sessionId: string | null;
  readonly finalMessage: string | null;
  readonly usage: HarnessUsage;
  readonly cost: HarnessCost | null;
  /** The `model_error` of a run that ended on a model failure, as data. */
  readonly modelError: Readonly<Record<string, unknown>> | null;
}

/** Reads the closing `Result` record of radian's JSONL, or undefined. */
function parseResult(line: string): ParsedResult | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.type !== "Result") return undefined;

  const usage = isRecord(value.usage) ? (value.usage as HarnessUsage) : {};
  let cost: HarnessCost | null = null;
  if (
    isRecord(value.cost) &&
    typeof value.cost.micros === "number" &&
    Number.isFinite(value.cost.micros)
  ) {
    cost = value.cost as unknown as HarnessCost;
  }
  return {
    sessionId: typeof value.session_id === "string" ? value.session_id : null,
    finalMessage: typeof value.text === "string" ? value.text : null,
    usage,
    cost,
    modelError: isRecord(value.model_error) ? value.model_error : null,
  };
}

/** `{ modelError }` when radian reported one, so a caller can classify it. */
function modelErrorData(
  result: ParsedResult | undefined,
): Record<string, unknown> {
  return result?.modelError == null ? {} : { modelError: result.modelError };
}

function failureData(
  outcome: AgentRunOutcome,
  result: ParsedResult | undefined,
  log: string,
  durationMs: number,
  extra: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    ...agentData(outcome, result, log, durationMs),
    ...modelErrorData(result),
    ...extra,
  };
}

function agentData(
  outcome: AgentRunOutcome,
  result: ParsedResult | undefined,
  log: string,
  durationMs: number,
): AgentResultData {
  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    sessionId: result?.sessionId ?? null,
    finalMessage: result?.finalMessage ?? null,
    usage: result?.usage ?? {},
    cost: result?.cost ?? null,
    log,
    durationMs,
    stderr: outcome.stderrTail,
  };
}

/** Builds the argv radian receives; the prompt itself may travel on stdin. */
function radianArgs(
  cwd: string,
  args: readonly string[],
  prompt: string,
  resumeSession: string | undefined,
): { readonly args: string[]; readonly stdin: string | undefined } {
  const argv = ["exec", "--workspace", cwd, "--output", "jsonl"];
  if (resumeSession !== undefined) argv.push("--resume", resumeSession);
  argv.push(...args);

  const stdin =
    Buffer.byteLength(prompt, "utf8") > PROMPT_ARG_SAFE_BYTES ? prompt : undefined;
  argv.push("-p", stdin === undefined ? prompt : "-");
  return { args: argv, stdin };
}

function resultFor(
  outcome: AgentRunOutcome,
  result: ParsedResult | undefined,
  log: string,
  durationMs: number,
  wallTimeSecs: number,
  stallSecs: number,
  command: string,
): PluginStepResult {
  if (outcome.cancelled) {
    return {
      result: "interrupted",
      data: failureData(outcome, result, log, durationMs, {
        reason: "cancelled",
        message: "the harness run was cancelled",
      }),
    };
  }
  if (outcome.missing) {
    return {
      result: "failed",
      data: failureData(outcome, result, log, durationMs, {
        reason: "missing",
        message: `${command} was not found on PATH`,
      }),
    };
  }
  if (outcome.spawnError !== undefined) {
    return {
      result: "failed",
      data: failureData(outcome, result, log, durationMs, {
        reason: "spawn",
        message: outcome.spawnError,
      }),
    };
  }
  if (outcome.wall) {
    return {
      result: "failed",
      data: failureData(outcome, result, log, durationMs, {
        reason: "wall",
        message: `the harness ran longer than ${wallTimeSecs}s`,
      }),
    };
  }
  if (outcome.stall) {
    return {
      result: "failed",
      data: failureData(outcome, result, log, durationMs, {
        reason: "stall",
        message: `the harness printed no new line for ${stallSecs}s`,
      }),
    };
  }
  if (outcome.lineTooLong) {
    return {
      result: "failed",
      data: failureData(outcome, result, log, durationMs, {
        reason: "line_too_long",
        message: `the harness printed a line longer than ${MAX_LINE_CHARS} characters`,
      }),
    };
  }
  if (outcome.exitCode !== 0) {
    const message =
      outcome.signal !== null
        ? `the harness was killed by ${outcome.signal}`
        : `the harness exited ${String(outcome.exitCode)}`;
    return {
      result: "failed",
      data: failureData(outcome, result, log, durationMs, {
        reason: "exit",
        message,
      }),
    };
  }
  if (result === undefined) {
    return {
      result: "failed",
      data: failureData(outcome, result, log, durationMs, {
        reason: "no_result",
        message: "the harness exited 0 without a Result record",
      }),
    };
  }
  return {
    result: "done",
    data: {
      ...agentData(outcome, result, log, durationMs),
      ...modelErrorData(result),
    } as unknown as Record<string, unknown>,
  };
}

/**
 * Creates the radian harness plugin. The prompt flow uses the settings for
 * its limits; a direct `agent` step may override them.
 */
export function createRadianHarnessPlugin(settings: RadianHarnessSettings = {}) {
  const defaults: ResolvedSettings = {
    command: settings.command ?? "radian",
    wallTimeSecs: settings.wallTimeSecs ?? DEFAULT_WALL_TIME_SECS,
    stallSecs: settings.stallSecs ?? DEFAULT_STALL_SECS,
    clock: settings.clock ?? systemClock,
  };

  const promptFlow = defineFlow({
    name: "harness-radian:prompt",
    entry: "agent",
    steps: [
      {
        id: "agent",
        kind: "plugin",
        params: { use: "harness-radian/agent", params: {} },
        replay: "unsafe",
        next: { done: "done", failed: "failed", interrupted: "cancelled" },
      },
      { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
      { id: "failed", kind: "end", params: { status: "failed" }, replay: "safe" },
      {
        id: "cancelled",
        kind: "end",
        params: { status: "cancelled" },
        replay: "safe",
      },
    ],
  });

  return definePlugin({
    name: "harness-radian",
    kind: "harness",
    version: "0.0.0",
    settings: PLUGIN_SETTINGS,
    steps: [
      {
        name: "agent",
        results: ["done", "failed", "interrupted"],
        async run(ctx: StepContext, params: unknown): Promise<PluginStepResult> {
          const at = "harness-radian/agent";
          const input = paramsObject(params, at);
          const flow = isRecord(ctx.params) ? ctx.params : {};

          const prompt = text(input.prompt ?? flow.prompt, `${at}: params.prompt`);
          const note = eventNote(ctx.trigger);
          const promptWithNote =
            note === undefined ? prompt : `${prompt}\n\n${note}`;
          const cwd = text(input.cwd ?? flow.cwd, `${at}: params.cwd`);
          const args = stringList(
            input.args === undefined ? flow.args : input.args,
            `${at}: params.args`,
          );
          const resumeSession = optionalText(
            input.resumeSession,
            `${at}: params.resumeSession`,
          );
          const wallTimeSecs = secs(
            input.wallTimeSecs ?? ctx.settings.wallTimeSecs ?? defaults.wallTimeSecs,
            `${at}: params.wallTimeSecs`,
          );
          const stallSecs = secs(
            input.stallSecs ?? ctx.settings.stallSecs ?? defaults.stallSecs,
            `${at}: params.stallSecs`,
          );
          const commandName =
            ctx.settings.command === undefined
              ? defaults.command
              : text(ctx.settings.command, `${at}: settings.command`);

          const cwdProblem = await directoryError(cwd);
          if (cwdProblem !== undefined) {
            const log = await ctx.logger.write(cwdProblem);
            return {
              result: "failed",
              data: {
                reason: "cwd",
                message: cwdProblem,
                exitCode: null,
                signal: null,
                sessionId: null,
                finalMessage: null,
                usage: {},
                cost: null,
                log,
                durationMs: 0,
                stderr: [cwdProblem],
              },
            };
          }

          const command = radianArgs(cwd, args, promptWithNote, resumeSession);
          const started = Date.now();
          const jsonl = new JsonlLog(ctx.logger);
          let result: ParsedResult | undefined;

          const outcome = await runAgent({
            command: commandName,
            args: command.args,
            cwd,
            stdin: command.stdin,
            wallMs: wallTimeSecs * 1000,
            stallMs: stallSecs * 1000,
            signal: ctx.signal,
            clock: defaults.clock,
            toolEvent: radianToolEvent,
            onLine(line) {
              const writing = jsonl.push(line);
              const parsed = parseResult(line);
              if (parsed !== undefined) result = parsed;
              return writing;
            },
          });
          await jsonl.end();

          return resultFor(
            outcome,
            result,
            ctx.logger.path,
            Date.now() - started,
            wallTimeSecs,
            stallSecs,
            commandName,
          );
        },
      },
    ],
    flows: [promptFlow],
    async check(ctx) {
      const command =
        ctx.settings.command === undefined
          ? defaults.command
          : text(ctx.settings.command, "harness-radian: settings.command");
      const found = await findCommand(command);
      if (found === undefined) {
        throw new Error(`${command} was not found on PATH`);
      }
      return `${command} is available`;
    },
  });
}

export default createRadianHarnessPlugin();
