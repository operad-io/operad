/**
 * The claude harness, hub side: one `agent` step that starts the child program
 * `worker.ts` under Bun, writes one JSON object to its stdin and reads the last
 * `result` line of its stdout, plus the `harness-claude:prompt` flow. The step
 * has the params, result names and facts of `harness-pi/agent`, so a flow
 * changes harness by changing `use`. The Agent SDK is imported only by the
 * child program, never by the hub.
 */

import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  defineFlow,
  definePlugin,
  type AgentResultData,
  type PluginStepResult,
  type StepContext,
} from "@operad-io/engine";
import {
  answerGrant,
  CONCURRENCY_SETTING,
  eventNote,
  askNote,
  flagValue,
  hasGrants,
  JsonlLog,
  modelLimit,
  standardUsage,
  type UsageSource,
  MAX_LINE_CHARS,
  runAgent,
  systemClock,
  type AgentRunOutcome,
  type Clock,
  type ToolEvent,
} from "@operad-io/harness-process";
import { CLAUDE_FLOOR, DEFAULT_CLAUDE_COMMAND, inspectClaude, sdkVersion } from "./claude-install.ts";
import { EFFORT_LEVELS, type WorkerEffort, type WorkerResult } from "./protocol.ts";

/** How long an agent may run before the step stops it. */
export const DEFAULT_WALL_TIME_SECS = 3600;

/** How long an agent may go without a new output line. */
export const DEFAULT_STALL_SECS = 600;

/** One run of the step may take this long; it is above every allowed wall time. */
export const STEP_TIMEOUT_SECS = 8 * 3600;

/** The longest wall time a run may ask for: the step timeout minus a margin. */
export const MAX_WALL_TIME_SECS = STEP_TIMEOUT_SECS - 300;

/** How many of the worker's last stderr lines a failure reason carries. */
const REASON_STDERR_LINES = 5;

const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));

/** The name the plugin goes by in usage and limit keys. */
const HARNESS = "harness-claude";

/**
 * Reads one worker line and reports the tool call it starts or settles. The
 * worker writes `tool_execution_start` and `tool_execution_end` under `type`.
 */
export function claudeToolEvent(line: string): ToolEvent | undefined {
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
export interface ClaudeHarnessOptions {
  readonly clock?: Clock | undefined;
  /** The executable; defaults to the running Bun. */
  readonly command?: string | undefined;
  /** The arguments before the worker input; defaults to `worker.ts`. */
  readonly args?: readonly string[] | undefined;
}

/** The settings a config.json section may set for this plugin. */
export const PLUGIN_SETTINGS = {
  type: "object" as const,
  properties: {
    model: {
      type: "string" as const,
      minLength: 1,
      description: "The model name claude takes (such as opus or sonnet); unset uses claude's default.",
    },
    effort: {
      type: "string" as const,
      enum: EFFORT_LEVELS,
      description: "The reasoning effort; unset uses claude's default.",
    },
    command: {
      type: "string" as const,
      minLength: 1,
      default: DEFAULT_CLAUDE_COMMAND,
      description: "The claude command: a name on PATH or a path.",
    },
    maxTurns: {
      type: "integer" as const,
      minimum: 1,
      description: "The most turns one run may take; unset means no limit.",
    },
    budgetUsd: {
      type: "number" as const,
      minimum: 0.01,
      description: "The most one run may spend, in US dollars; unset means no limit. For API-key logins.",
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
    concurrency: CONCURRENCY_SETTING,
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

function optionalNumber(value: unknown, at: string, integer: boolean): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${at}: must be a positive ${integer ? "integer" : "number"}`);
  }
  return value;
}

function stringList(value: unknown, at: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${at}: must be an array of strings`);
  }
  return value.filter((item): item is string => typeof item === "string");
}

/** What `args` of the step may set. */
interface StepFlags {
  readonly model?: string;
  readonly effort?: WorkerEffort;
}

/**
 * Reads `--model <name>` and `--effort <level>` from the step's `args`.
 * Anything else is an error message naming the entry: a flag silently ignored
 * would hide a wrong model.
 */
function parseStepFlags(args: readonly string[]): StepFlags | string {
  let model: string | undefined;
  let effort: WorkerEffort | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const entry = args[index] ?? "";
    if (entry !== "--model" && entry !== "--effort") {
      return `args: unknown entry "${entry}"; expected --model <name> or --effort <level>`;
    }
    const value = args[index + 1];
    // A flag that follows is not a value: `--model --effort high` has none.
    if (value === undefined || value.startsWith("-")) return `args: "${entry}" has no value`;
    index += 1;
    if (entry === "--model") {
      if (model !== undefined) return `args: "--model" is given twice`;
      if (value.trim().length === 0) return `args: "--model" has no value`;
      model = value;
    } else {
      if (effort !== undefined) return `args: "--effort" is given twice`;
      const known = EFFORT_LEVELS.find((level) => level === value);
      if (known === undefined) {
        return `args: "--effort ${value}": the value must be one of ${EFFORT_LEVELS.join(", ")}`;
      }
      effort = known;
    }
  }
  return {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
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
  who: UsageSource,
  outcome: AgentRunOutcome,
  result: WorkerResult | undefined,
  log: string,
  durationMs: number,
): AgentResultData {
  const cost =
    result?.cost === null || result?.cost === undefined
      ? null
      : { micros: result.cost.micros, estimated: result.cost.quality === "estimated" };
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

function failure(
  who: UsageSource,
  kind: "failed" | "interrupted",
  outcome: AgentRunOutcome,
  result: WorkerResult | undefined,
  log: string,
  durationMs: number,
  extra: Readonly<Record<string, unknown>>,
): PluginStepResult {
  return {
    result: kind,
    data: { ...agentData(who, outcome, result, log, durationMs), ...extra },
  };
}

function resultFor(
  who: UsageSource,
  outcome: AgentRunOutcome,
  result: WorkerResult | undefined,
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

/**
 * Creates the claude harness plugin. Its worker is `worker.ts` under the
 * running Bun; a test replaces the program with a fake that prints fixed lines.
 */
export function createClaudeHarnessPlugin(options: ClaudeHarnessOptions = {}) {
  const clock = options.clock ?? systemClock;
  const command = options.command ?? process.execPath;
  const commandArgs = options.args ?? [WORKER_PATH];

  const promptFlow = defineFlow({
    name: "harness-claude:prompt",
    entry: "agent",
    steps: [
      {
        id: "agent",
        kind: "plugin",
        params: { use: "harness-claude/agent", params: {} },
        replay: "unsafe",
        next: { done: "done", failed: "failed", interrupted: "cancelled" },
      },
      { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
      { id: "failed", kind: "end", params: { status: "failed" }, replay: "safe" },
      { id: "cancelled", kind: "end", params: { status: "cancelled" }, replay: "safe" },
    ],
  });

  return definePlugin({
    name: HARNESS,
    kind: "harness",
    version: "0.0.0",
    settings: PLUGIN_SETTINGS,
    steps: [
      {
        name: "agent",
        // A question's answer comes back as `resumeSession` and `askAnswer`.
        resumable: true,
        results: ["done", "failed", "interrupted"],
        // The deny fields are applied in the worker's canUseTool.
        enforces: ["denyPaths", "denyCommands"],
        timeoutSecs: STEP_TIMEOUT_SECS,
        // The model the step uses: its `--model` argument, else the setting.
        limit: modelLimit(HARNESS, (params, settings) => {
          const fromArgs = isRecord(params) ? flagValue(params.args, "--model") : undefined;
          const model = fromArgs ?? settings.model;
          return typeof model === "string" && model.length > 0 ? model : undefined;
        }),
        async run(ctx: StepContext, params: unknown): Promise<PluginStepResult> {
          const at = "harness-claude/agent";
          const input = paramsObject(params, at);
          const flow = isRecord(ctx.params) ? ctx.params : {};

          const prompt = text(input.prompt ?? flow.prompt, `${at}: params.prompt`);
          const note = eventNote(ctx.trigger);
          const answerNote = askNote(input.askAnswer ?? flow.askAnswer);
          const promptWithNote = [prompt, note, answerNote]
            .filter((part): part is string => part !== undefined)
            .join("\n\n");
          const cwd = text(input.cwd ?? flow.cwd, `${at}: params.cwd`);
          const flags = parseStepFlags(
            stringList(input.args === undefined ? flow.args : input.args, `${at}: params.args`),
          );
          const settingModel = typeof ctx.settings.model === "string" ? ctx.settings.model : undefined;
          // The model the step will use, known before anything can fail.
          const knownModel =
            typeof flags === "string"
              ? (flagValue(input.args === undefined ? flow.args : input.args, "--model") ?? settingModel)
              : (flags.model ?? settingModel);
          const early: UsageSource = { harness: HARNESS, model: knownModel ?? null };
          const refuse = async (reason: string, message: string): Promise<PluginStepResult> => {
            const log = await ctx.logger.write(message);
            return {
              result: "failed",
              data: {
                reason,
                message,
                exitCode: null,
                signal: null,
                sessionId: null,
                finalMessage: null,
                usage: standardUsage(early, undefined, null),
                log,
                durationMs: 0,
                stderr: [message],
              },
            };
          };
          if (typeof flags === "string") return refuse("invalid_args", `${at}: ${flags}`);

          const resumeSession = optionalText(
            input.resumeSession ?? flow.resumeSession,
            `${at}: params.resumeSession`,
          );
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
          const model = flags.model ?? optionalText(ctx.settings.model, `${at}: settings.model`);
          const effort = flags.effort ?? optionalText(ctx.settings.effort, `${at}: settings.effort`);
          const maxTurns = optionalNumber(ctx.settings.maxTurns, `${at}: settings.maxTurns`, true);
          const budgetUsd = optionalNumber(ctx.settings.budgetUsd, `${at}: settings.budgetUsd`, false);

          const cwdProblem = await directoryError(cwd);
          if (cwdProblem !== undefined) return refuse("cwd", cwdProblem);

          const claudeCommand = optionalText(ctx.settings.command, `${at}: settings.command`);
          const stdin: Record<string, unknown> = {
            prompt: promptWithNote,
            cwd,
            ...(claudeCommand === undefined ? {} : { command: claudeCommand }),
            ...(resumeSession === undefined ? {} : { resumeSession }),
            ...(model === undefined ? {} : { model }),
            ...(effort === undefined ? {} : { effort }),
            ...(maxTurns === undefined ? {} : { maxTurns }),
            ...(budgetUsd === undefined ? {} : { budgetUsd }),
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
            // The program may ask to use a one-time permission; it needs a reply.
            interactive: hasGrants(ctx.access),
            wallMs: wallTimeSecs * 1000,
            stallMs: stallSecs * 1000,
            signal: ctx.signal,
            clock,
            toolEvent: claudeToolEvent,
            async onLine(line, reply) {
              await answerGrant(line, (waitId) => ctx.useGrant(waitId), reply);
              const writing = jsonl.push(line);
              const parsed = parseResult(line);
              if (parsed !== undefined) result = parsed;
              return writing;
            },
          });
          await jsonl.end();

          return resultFor(
            // The step's own model, else the one claude reports having used.
            { harness: HARNESS, model: model ?? result?.model ?? null },
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
    async check(ctx) {
      const claudeCommand = optionalText(ctx.settings.command, `${HARNESS}: settings.command`);
      // The user's own claude: found, version-checked and asked who is logged
      // in. Only the login kind is reported.
      const claude = inspectClaude(claudeCommand);
      if (options.command === undefined && !existsSync(process.execPath)) {
        throw new Error("bun was not found");
      }
      if (options.args === undefined && !existsSync(WORKER_PATH)) {
        throw new Error(`the worker program is missing: ${WORKER_PATH}`);
      }
      const sdk = await sdkVersion();
      return (
        `claude ${claude.version} at ${claude.path} (floor ${CLAUDE_FLOOR}); ` +
        `agent sdk ${sdk ?? "unknown"}; login ${claude.login}; the worker program is available`
      );
    },
  });
}

export default createClaudeHarnessPlugin();
