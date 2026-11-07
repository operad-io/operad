/**
 * The pi harness, hub side: one `agent` step that starts the child program
 * `worker.ts` under Bun, writes one JSON object to its stdin and reads the last
 * `result` line of its stdout, plus the `harness-pi:prompt` flow. The step has
 * the params, result names and facts of `harness-radian/agent`, so a flow
 * changes harness by changing `use`. pi's library is imported only by the child
 * program, never by the hub.
 */

import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  JsonlLog,
  MAX_LINE_CHARS,
  runAgent,
  systemClock,
  type AgentRunOutcome,
  type Clock,
  type ToolEvent,
} from "@operad-io/harness-process";
import { THINKING_LEVELS, type WorkerResult } from "./protocol.ts";

/** How long an agent may run before the step stops it. */
export const DEFAULT_WALL_TIME_SECS = 3600;

/** How long an agent may go without a new output line. */
export const DEFAULT_STALL_SECS = 600;

/** One run of the step may take this long; it is above every allowed wall time. */
export const STEP_TIMEOUT_SECS = 8 * 3600;

/** The longest wall time a run may ask for: the step timeout minus a margin. */
export const MAX_WALL_TIME_SECS = STEP_TIMEOUT_SECS - 300;

export const DEFAULT_AUTH_PATH = "~/.pi/agent/auth.json";
export const DEFAULT_MODELS_PATH = "~/.pi/agent/models.json";

/** How many of the worker's last stderr lines a failure reason carries. */
const REASON_STDERR_LINES = 5;

const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));

/**
 * Reads one worker line and reports the tool call it starts or settles. The
 * worker writes pi's `tool_execution_start` and `tool_execution_end` under
 * `type`.
 */
export function piToolEvent(line: string): ToolEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value.type === "tool_execution_start") return "tool-start";
  if (value.type === "tool_execution_end") return "tool-end";
  return undefined;
}

/** What a test injects: the clock and the program the step starts. */
export interface PiHarnessOptions {
  readonly clock?: Clock | undefined;
  /** The executable; defaults to the running Bun. */
  readonly command?: string | undefined;
  /** The arguments before the worker input; defaults to `worker.ts`. */
  readonly args?: readonly string[] | undefined;
}

/** The settings a config.json section may set for this plugin. */
const PLUGIN_SETTINGS = {
  type: "object" as const,
  properties: {
    model: {
      type: "string" as const,
      minLength: 3,
      description: "The model as provider/id; unset uses pi's default model.",
    },
    thinkingLevel: {
      type: "string" as const,
      enum: THINKING_LEVELS,
      description: "The reasoning level; unset uses pi's default.",
    },
    authPath: {
      type: "string" as const,
      minLength: 1,
      default: DEFAULT_AUTH_PATH,
      description: "pi's credentials file.",
    },
    modelsPath: {
      type: "string" as const,
      minLength: 1,
      default: DEFAULT_MODELS_PATH,
      description: "pi's custom models file.",
    },
    wallTimeSecs: {
      type: "number" as const,
      minimum: 1,
      maximum: MAX_WALL_TIME_SECS,
      default: DEFAULT_WALL_TIME_SECS,
      description: "The longest one agent run may take.",
    },
    stallSecs: {
      type: "number" as const,
      minimum: 1,
      default: DEFAULT_STALL_SECS,
      description: "How long an agent may be silent while no tool call is open.",
    },
  },
  additionalProperties: false as const,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function paramsObject(params: unknown, at: string): Record<string, unknown> {
  if (!isRecord(params)) throw new Error(`${at}: params: must be an object`);
  return params;
}

function text(value: unknown, at: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${at}: must be a non-empty string`);
  }
  return value;
}

function optionalText(value: unknown, at: string): string | undefined {
  return value === undefined ? undefined : text(value, at);
}

function secs(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${at}: must be a positive number of seconds`);
  }
  return value;
}

function stringList(value: unknown, at: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${at}: must be an array of strings`);
  }
}

/** Expands a leading `~` to the user's home directory. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(path);
}

async function directoryError(cwd: string): Promise<string | undefined> {
  try {
    const info = await stat(cwd);
    return info.isDirectory() ? undefined : `cwd is not a directory: ${cwd}`;
  } catch {
    return `cwd does not exist: ${cwd}`;
  }
}

/** Reads a `result` line of the worker, or undefined for any other line. */
function parseResult(line: string): WorkerResult | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.type !== "result") return undefined;
  const name = value.result;
  if (name !== "done" && name !== "failed" && name !== "cancelled") return undefined;
  return value as unknown as WorkerResult;
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

function agentData(
  outcome: AgentRunOutcome,
  result: WorkerResult | undefined,
  log: string,
  durationMs: number,
): AgentResultData {
  const usage: HarnessUsage = result?.usage ?? {};
  const cost: HarnessCost | null = result?.cost ?? null;
  return {
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    sessionId: result?.sessionId ?? null,
    finalMessage: result?.finalMessage ?? null,
    usage,
    cost,
    log,
    durationMs,
    stderr: outcome.stderrTail,
  };
}

function failure(
  kind: "failed" | "interrupted",
  outcome: AgentRunOutcome,
  result: WorkerResult | undefined,
  log: string,
  durationMs: number,
  extra: Readonly<Record<string, unknown>>,
): PluginStepResult {
  return {
    result: kind,
    data: { ...agentData(outcome, result, log, durationMs), ...extra },
  };
}

function resultFor(
  outcome: AgentRunOutcome,
  result: WorkerResult | undefined,
  log: string,
  durationMs: number,
  limits: { readonly wallTimeSecs: number; readonly stallSecs: number },
  command: string,
): PluginStepResult {
  const fail = (extra: Readonly<Record<string, unknown>>): PluginStepResult =>
    failure("failed", outcome, result, log, durationMs, extra);

  if (outcome.cancelled) {
    return failure("interrupted", outcome, result, log, durationMs, {
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
    if (outcome.exitCode === null && outcome.signal !== null) {
      return failure("interrupted", outcome, result, log, durationMs, {
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
    return failure("interrupted", outcome, result, log, durationMs, {
      reason: "cancelled",
      message: "the harness run was cancelled",
    });
  }
  if (result.result === "failed") {
    const message = result.message ?? "the harness failed";
    return fail({
      reason: result.reason ?? "exit",
      message,
      ...(result.reason === "model_error" ? { modelError: modelErrorOf(message) } : {}),
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
    data: agentData(outcome, result, log, durationMs) as unknown as Record<string, unknown>,
  };
}

/**
 * Creates the pi harness plugin. Its worker is `worker.ts` under the running
 * Bun; a test replaces the program with a fake that prints fixed lines.
 */
export function createPiHarnessPlugin(options: PiHarnessOptions = {}) {
  const clock = options.clock ?? systemClock;
  const command = options.command ?? process.execPath;
  const commandArgs = options.args ?? [WORKER_PATH];

  const promptFlow = defineFlow({
    name: "harness-pi:prompt",
    entry: "agent",
    steps: [
      {
        id: "agent",
        kind: "plugin",
        params: { use: "harness-pi/agent", params: {} },
        replay: "unsafe",
        next: { done: "done", failed: "failed", interrupted: "cancelled" },
      },
      { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
      { id: "failed", kind: "end", params: { status: "failed" }, replay: "safe" },
      { id: "cancelled", kind: "end", params: { status: "cancelled" }, replay: "safe" },
    ],
  });

  return definePlugin({
    name: "harness-pi",
    kind: "harness",
    version: "0.0.0",
    settings: PLUGIN_SETTINGS,
    steps: [
      {
        name: "agent",
        results: ["done", "failed", "interrupted"],
        // The deny fields are applied in the worker's tool_call hook.
        enforces: ["denyPaths", "denyCommands"],
        timeoutSecs: STEP_TIMEOUT_SECS,
        async run(ctx: StepContext, params: unknown): Promise<PluginStepResult> {
          const at = "harness-pi/agent";
          const input = paramsObject(params, at);
          const flow = isRecord(ctx.params) ? ctx.params : {};

          const prompt = text(input.prompt ?? flow.prompt, `${at}: params.prompt`);
          const note = eventNote(ctx.trigger);
          const promptWithNote = note === undefined ? prompt : `${prompt}\n\n${note}`;
          const cwd = text(input.cwd ?? flow.cwd, `${at}: params.cwd`);
          // pi has no command-line arguments; the list is accepted so a flow
          // written for another harness keeps its params.
          stringList(input.args === undefined ? flow.args : input.args, `${at}: params.args`);
          const resumeSession = optionalText(input.resumeSession, `${at}: params.resumeSession`);
          const wallTimeSecs = secs(
            input.wallTimeSecs ?? ctx.settings.wallTimeSecs ?? DEFAULT_WALL_TIME_SECS,
            `${at}: params.wallTimeSecs`,
          );
          if (wallTimeSecs > MAX_WALL_TIME_SECS) {
            throw new Error(`${at}: params.wallTimeSecs: must be at most ${MAX_WALL_TIME_SECS}`);
          }
          const stallSecs = secs(
            input.stallSecs ?? ctx.settings.stallSecs ?? DEFAULT_STALL_SECS,
            `${at}: params.stallSecs`,
          );
          const model = optionalText(ctx.settings.model, `${at}: settings.model`);
          const thinkingLevel = optionalText(
            ctx.settings.thinkingLevel,
            `${at}: settings.thinkingLevel`,
          );
          const authPath = expandHome(
            text(ctx.settings.authPath ?? DEFAULT_AUTH_PATH, `${at}: settings.authPath`),
          );
          const modelsPath = expandHome(
            text(ctx.settings.modelsPath ?? DEFAULT_MODELS_PATH, `${at}: settings.modelsPath`),
          );

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

          const agentDir = join(ctx.home, "harness", "pi");
          const sessionDir = join(agentDir, "sessions");
          await mkdir(sessionDir, { recursive: true });

          const stdin: Record<string, unknown> = {
            prompt: promptWithNote,
            cwd,
            authPath,
            modelsPath,
            agentDir,
            sessionDir,
            ...(resumeSession === undefined ? {} : { resumeSession }),
            ...(model === undefined ? {} : { model }),
            ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
            ...(isRecord(ctx.access) ? { access: ctx.access } : {}),
          };

          const started = Date.now();
          const jsonl = new JsonlLog(ctx.logger);
          let result: WorkerResult | undefined;

          const outcome = await runAgent({
            command,
            args: commandArgs,
            cwd,
            stdin: JSON.stringify(stdin),
            wallMs: wallTimeSecs * 1000,
            stallMs: stallSecs * 1000,
            signal: ctx.signal,
            clock,
            toolEvent: piToolEvent,
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
            { wallTimeSecs, stallSecs },
            command,
          );
        },
      },
    ],
    flows: [promptFlow],
    async check() {
      if (options.command === undefined && !existsSync(process.execPath)) {
        throw new Error("bun was not found");
      }
      if (options.args === undefined && !existsSync(WORKER_PATH)) {
        throw new Error(`the worker program is missing: ${WORKER_PATH}`);
      }
      return "the pi worker program is available";
    },
  });
}

export default createPiHarnessPlugin();
