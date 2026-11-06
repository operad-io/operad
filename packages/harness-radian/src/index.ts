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
  type PluginLogger,
  type PluginStepResult,
  type StepContext,
} from "@operad-io/engine";
import {
  findCommand,
  runAgent,
  systemClock,
  type AgentRunOutcome,
  type Clock,
} from "./process.ts";

/** How long an agent may run before the step stops it. */
export const DEFAULT_WALL_TIME_SECS = 300;

/** How long an agent may go without a new output line. */
export const DEFAULT_STALL_SECS = 60;

/**
 * A prompt longer than this goes through stdin. It is well below the OS
 * argument limit, so the argv never approaches it.
 */
export const PROMPT_ARG_SAFE_BYTES = 128 * 1024;

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

/** Appends complete JSONL lines to the step's log without holding them all. */
class JsonlLog {
  private buffer = "";
  private chain: Promise<void> = Promise.resolve();
  private wrote = false;
  private readonly logger: PluginLogger;

  constructor(logger: PluginLogger) {
    this.logger = logger;
  }

  push(line: string): void {
    this.buffer += `${line}\n`;
    if (this.buffer.length >= 16 * 1024) this.flush();
  }

  async end(): Promise<void> {
    this.flush();
    if (!this.wrote) {
      this.chain = this.chain.then(() => this.logger.write("")).then(() => undefined);
    }
    await this.chain;
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    const text = this.buffer;
    this.buffer = "";
    this.wrote = true;
    this.chain = this.chain
      .then(() => this.logger.write(text))
      .then(() => undefined);
  }
}

interface ParsedResult {
  readonly sessionId: string | null;
  readonly finalMessage: string | null;
  readonly usage: HarnessUsage;
  readonly cost: HarnessCost | null;
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
  };
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
  if (outcome.exitCode !== 0) {
    const message =
      outcome.exitCode === null && outcome.signal !== null
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
    data: agentData(outcome, result, log, durationMs) as unknown as Record<
      string,
      unknown
    >,
  };
}

/**
 * Creates the radian harness plugin. The prompt flow uses the settings for
 * its limits; a direct `agent` step may override them.
 */
export function createRadianHarnessPlugin(settings: RadianHarnessSettings = {}) {
  const resolved: ResolvedSettings = {
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
    steps: [
      {
        name: "agent",
        results: ["done", "failed", "interrupted"],
        async run(ctx: StepContext, params: unknown): Promise<PluginStepResult> {
          const at = "harness-radian/agent";
          const input = paramsObject(params, at);
          const flow = isRecord(ctx.params) ? ctx.params : {};

          const prompt = text(input.prompt ?? flow.prompt, `${at}: params.prompt`);
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
            input.wallTimeSecs ?? resolved.wallTimeSecs,
            `${at}: params.wallTimeSecs`,
          );
          const stallSecs = secs(
            input.stallSecs ?? resolved.stallSecs,
            `${at}: params.stallSecs`,
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

          const command = radianArgs(cwd, args, prompt, resumeSession);
          const started = Date.now();
          const jsonl = new JsonlLog(ctx.logger);
          let result: ParsedResult | undefined;

          const outcome = await runAgent({
            command: resolved.command,
            args: command.args,
            cwd,
            stdin: command.stdin,
            wallMs: wallTimeSecs * 1000,
            stallMs: stallSecs * 1000,
            signal: ctx.signal,
            clock: resolved.clock,
            onLine(line) {
              jsonl.push(line);
              const parsed = parseResult(line);
              if (parsed !== undefined) result = parsed;
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
            resolved.command,
          );
        },
      },
    ],
    flows: [promptFlow],
    async check() {
      const found = await findCommand(resolved.command);
      if (found === undefined) {
        throw new Error(`${resolved.command} was not found on PATH`);
      }
      return `${resolved.command} is available`;
    },
  });
}

export default createRadianHarnessPlugin();
