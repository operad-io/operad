/**
 * The radian harness: one `agent` step that runs `radian exec` in a directory
 * and reads its closing Result record, plus the `radian:prompt` flow
 * that runs one prompt. Only the plugin interface and the process helper are
 * used; the kernel never knows how radian is started.
 */

import pkg from "../package.json" with { type: "json" };
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mapRadianCall } from "./refusal.ts";
export { radianRefusal } from "./refusal.ts";
import { firstErrorLine, match, readProfile, secretValuesOf, summarizeCall, type AccessProfile } from "@operad-io/access-match";
import {
  isRecord,
  paramsObject,
  defineFlow,
  definePlugin,
  type AgentResultData,
  type PluginStepResult,
  type StepContext,
} from "@operad-io/engine";
import {
  CONCURRENCY_SETTING,
  askNote,
  eventNote,
  directoryError,
  findCommand,
  flagValue,
  JsonlLog,
  deliverLine,
  MAX_LINE_CHARS,
  OPERAD_SERVER,
  operadToolsOf,
  mountedServersOf,
  optionalText,
  secs,
  serverCommand,
  standardUsage,
  stringListParam,
  text,
  type RawCost,
  type RawCounts,
  type UsageSource,
  modelLimit,
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

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Radian's own tool names, read as the access-match tool the profile judges:
 * `shell` is a bash command, `patch` an edit, `glob` a find, and any other tool
 * with a `path` is a read of it. The log still names the radian tool.
 */
function summarizeRadianCall(
  profile: AccessProfile,
  toolName: string,
  args: unknown,
  cwd: string,
  secrets: readonly string[],
): string | undefined {
  if (!isRecord(args)) return undefined;
  const lower = toolName.toLowerCase();
  const { mapped, input } = mapRadianCall(toolName, args);
  const summary = summarizeCall(profile, mapped, input, cwd, { secrets, keepLines: true });
  const denied = `${mapped} denied by the access profile`;
  if (summary !== undefined && summary.startsWith(denied)) return `${toolName}${summary.slice(mapped.length)}`;
  // Unknown tools keep the plain summary of their main argument.
  if (mapped === "read" && lower !== "read") return summarizeCall({}, toolName, args, cwd, { secrets });
  return summary;
}

/**
 * Turns radian's tool journal lines into the log lines the other harnesses
 * write: `tool_execution_start` with the command or path summary and its start
 * time, `tool_execution_end` with the duration and an error's first line. Any
 * other line, and a tool line it cannot read, is returned as radian wrote it.
 * The summary is cut, has secret values masked, and says only that the call
 * was denied where the run's access profile refuses it.
 */
export function radianLogLine(
  line: string,
  now: () => number,
  open: Map<string, { at: number; name: string; denied?: boolean }>,
  cwd: string,
  profile: AccessProfile = {},
  secrets: readonly string[] = [],
): string {
  const kind = radianToolEvent(line);
  if (kind === undefined) return line;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return line;
  }
  if (!isRecord(value)) return line;
  const nested = isRecord(value.data) ? value.data : isRecord(value.payload) ? value.payload : {};
  const field = (keys: readonly string[]): string | undefined =>
    firstString(value as Record<string, unknown>, keys) ?? firstString(nested, keys);
  const id = field(["toolCallId", "tool_call_id", "callId", "call_id", "id"]) ?? "";
  const name = field(["toolName", "tool_name", "tool", "name"]);
  if (kind === "tool-start") {
    const at = now();
    const toolName = name ?? "tool";
    const args = value.input ?? value.args ?? value.arguments ?? nested.input ?? nested.args ?? nested.arguments;
    const summary = summarizeRadianCall(profile, toolName, args, cwd, secrets);
    open.set(id, { at, name: toolName, denied: summary?.includes(" denied by the access profile") === true });
    return JSON.stringify({
      type: "tool_execution_start",
      toolCallId: id,
      toolName,
      at,
      ...(summary === undefined ? {} : { input: summary }),
    });
  }
  const begun = open.get(id);
  open.delete(id);
  // Radian settles a call as data.result: `is_error` and content blocks of
  // `{ text: { text } }`. Only the first error line of that text is kept.
  const settled = isRecord(nested.result) ? nested.result : {};
  const isError =
    value.isError === true || nested.isError === true || value.is_error === true || settled.is_error === true;
  const blocks = Array.isArray(settled.content) ? settled.content : [];
  const first: unknown = blocks[0];
  const blockText =
    isRecord(first) && isRecord(first.text) && typeof first.text.text === "string" ? first.text.text : undefined;
  const error =
    isError && begun?.denied !== true
      ? firstErrorLine(field(["error", "message"]) ?? blockText, { secrets })
      : undefined;
  return JSON.stringify({
    type: "tool_execution_end",
    toolCallId: id,
    toolName: name ?? begun?.name ?? "tool",
    isError,
    durationMs: begun === undefined ? 0 : Math.max(0, now() - begun.at),
    ...(error === undefined ? {} : { error }),
  });
}

/**
 * The model a step passes to radian as `<provider>/<model>`, from `--provider`
 * and `--model` in its args. A model that already names a provider (it has a
 * `/`) is not prefixed again; a step without `--model` has none.
 */
export function radianModel(args: unknown): string | undefined {
  const model = flagValue(args, "--model");
  if (model === undefined) return undefined;
  const provider = flagValue(args, "--provider");
  return provider === undefined || model.includes("/") ? model : `${provider}/${model}`;
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
  /** Milliseconds now, for tool call start times and durations; a test injects it. */
  readonly now?: (() => number) | undefined;
}

interface ResolvedSettings {
  readonly command: string;
  readonly wallTimeSecs: number;
  readonly stallSecs: number;
  readonly clock: Clock;
  readonly now: () => number;
}

/** The models a chat may pick with this agent, and the one used when none is set. */
export const RADIAN_MODELS = { list: [], default: null } as const;

/** radian cannot honour an effort a chat picks, so it declares none. */
export const RADIAN_EFFORTS = { list: [], default: null } as const;

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
    concurrency: CONCURRENCY_SETTING,
  },
  additionalProperties: false as const,
};

interface ParsedResult {
  readonly sessionId: string | null;
  readonly finalMessage: string | null;
  /** radian's own counts and cost, as it prints them. */
  readonly counts: RawCounts;
  readonly cost: RawCost | null;
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

  const counts = isRecord(value.usage) ? (value.usage as RawCounts) : {};
  const cost: RawCost | null =
    isRecord(value.cost) &&
    typeof value.cost.micros === "number" &&
    Number.isFinite(value.cost.micros)
      ? {
          micros: value.cost.micros,
          incomplete: value.cost.incomplete === true,
          estimated: value.cost.estimated === true,
        }
      : null;
  return {
    sessionId: typeof value.session_id === "string" ? value.session_id : null,
    finalMessage: typeof value.text === "string" ? value.text : null,
    counts,
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
  who: UsageSource,
  outcome: AgentRunOutcome,
  result: ParsedResult | undefined,
  log: string,
  durationMs: number,
  extra: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    ...agentData(who, outcome, result, log, durationMs),
    ...modelErrorData(result),
    ...extra,
  };
}

function agentData(
  who: UsageSource,
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
    usage: standardUsage(who, result?.counts, result?.cost),
    log,
    durationMs,
    stderr: outcome.stderrTail,
  };
}

/** Whether the profile has a rule radian's calls must be judged by. */
function hasProfileRules(profile: AccessProfile): boolean {
  return (
    profile.readOnly === true ||
    [profile.denyPaths, profile.denyCommands, profile.askCommands, profile.askPaths].some((rules) => (rules?.length ?? 0) > 0)
  );
}

const HOOK_PATH = fileURLToPath(new URL("./hook.ts", import.meta.url));

function quoted(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * Writes the profile and a radian config that runs the hook before every tool
 * call; returns the config's path. The user's own radian config (`RADIAN_CONFIG`
 * or the default file) is kept, because `--config` replaces it.
 */
async function writeHookConfig(base: string, profile: AccessProfile): Promise<string> {
  const profileFile = `${base}.profile.json`;
  const configFile = `${base}.config.toml`;
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(profileFile, JSON.stringify(profile));
  const own = process.env.RADIAN_CONFIG ?? `${process.env.HOME ?? ""}/.radian/config/config.toml`;
  let existing = "";
  try {
    existing = await readFile(own, "utf8");
  } catch {
    existing = "";
  }
  const command = `${quoted(process.execPath)} ${quoted(HOOK_PATH)} ${quoted(profileFile)}`;
  const hook = [
    "",
    "[[hooks.PreToolUse]]",
    'matcher = "*"',
    "[[hooks.PreToolUse.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
    "timeout = 30",
    "",
  ].join("\n");
  await writeFile(configFile, existing + hook);
  return configFile;
}

/** Builds the argv radian receives; the prompt itself may travel on stdin. */
function radianArgs(
  cwd: string,
  args: readonly string[],
  prompt: string,
  resumeSession: string | undefined,
  mcpConfig?: string | undefined,
  config?: string | undefined,
): { readonly args: string[]; readonly stdin: string | undefined } {
  const argv = ["exec", "--workspace", cwd, "--output", "jsonl"];
  if (resumeSession !== undefined) argv.push("--resume", resumeSession);
  if (mcpConfig !== undefined) argv.push("--mcp-config", mcpConfig);
  if (config !== undefined) argv.push("--config", config);
  argv.push(...args);

  const stdin =
    Buffer.byteLength(prompt, "utf8") > PROMPT_ARG_SAFE_BYTES ? prompt : undefined;
  argv.push("-p", stdin === undefined ? prompt : "-");
  return { args: argv, stdin };
}

function resultFor(
  who: UsageSource,
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
      data: failureData(who, outcome, result, log, durationMs, {
        reason: "cancelled",
        message: "the harness run was cancelled",
      }),
    };
  }
  if (outcome.missing) {
    return {
      result: "failed",
      data: failureData(who, outcome, result, log, durationMs, {
        reason: "missing",
        message: `${command} was not found on PATH`,
      }),
    };
  }
  if (outcome.spawnError !== undefined) {
    return {
      result: "failed",
      data: failureData(who, outcome, result, log, durationMs, {
        reason: "spawn",
        message: outcome.spawnError,
      }),
    };
  }
  if (outcome.wall) {
    return {
      result: "failed",
      data: failureData(who, outcome, result, log, durationMs, {
        reason: "wall",
        message: `the harness ran longer than ${wallTimeSecs}s`,
      }),
    };
  }
  if (outcome.stall) {
    return {
      result: "failed",
      data: failureData(who, outcome, result, log, durationMs, {
        reason: "stall",
        message: `the harness printed no new line for ${stallSecs}s`,
      }),
    };
  }
  if (outcome.lineTooLong) {
    return {
      result: "failed",
      data: failureData(who, outcome, result, log, durationMs, {
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
      data: failureData(who, outcome, result, log, durationMs, {
        reason: "exit",
        message,
      }),
    };
  }
  if (result === undefined) {
    return {
      result: "failed",
      data: failureData(who, outcome, result, log, durationMs, {
        reason: "no_result",
        message: "the harness exited 0 without a Result record",
      }),
    };
  }
  return {
    result: "done",
    data: {
      ...agentData(who, outcome, result, log, durationMs),
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
    now: settings.now ?? Date.now,
  };

  const promptFlow = defineFlow({
    name: "radian:prompt",
    entry: "agent",
    steps: [
      {
        id: "agent",
        kind: "plugin",
        params: { use: "radian/agent", params: {} },
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
    name: "radian",
    kind: "harness",
    version: pkg.version,
    models: RADIAN_MODELS,
    efforts: RADIAN_EFFORTS,
    settings: PLUGIN_SETTINGS,
    steps: [
      {
        name: "agent",
        // A question's answer comes back as `resumeSession` and `askAnswer`.
        resumable: true,
        // No hook sees radian's tool calls: `ctx.ask` refuses a question that
        // offers a one-time permission before it asks anyone.
        grants: false,
        results: ["done", "failed", "interrupted"],
        // The model is what the step passes to radian: `<provider>/<model>`.
        limit: modelLimit("radian", (params) =>
          isRecord(params) ? radianModel(params.args) : undefined,
        ),
        async run(ctx: StepContext, params: unknown): Promise<PluginStepResult> {
          const at = "radian/agent";
          const input = paramsObject(params, at);
          const flow = isRecord(ctx.params) ? ctx.params : {};

          const prompt = text(input.prompt ?? flow.prompt, `${at}: params.prompt`);
          const note = eventNote(ctx.trigger);
          const answerNote = askNote(input.askAnswer ?? flow.askAnswer);
          const promptWithNote = [prompt, note, answerNote]
            .filter((part): part is string => part !== undefined)
            .join("\n\n");
          const cwd = text(input.cwd ?? flow.cwd, `${at}: params.cwd`);
          const args = stringListParam(
            input.args === undefined ? flow.args : input.args,
            `${at}: params.args`,
          );
          const resumeSession = optionalText(
            input.resumeSession ?? flow.resumeSession,
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

          const readAccess = readProfile(ctx.access ?? {});
          const logSecrets = await secretValuesOf(ctx.secrets);
          const logProfile: AccessProfile = readAccess.ok ? readAccess.profile : {};

          const who: UsageSource = {
            harness: "radian",
            model: radianModel(args) ?? null,
          };

          // radian has no hook that sees a tool call, so it cannot let one
          // call through and no other: a one-time permission is refused.
          if (isRecord(ctx.access) && Array.isArray(ctx.access.grants) && ctx.access.grants.length > 0) {
            const message = `${at}: radian cannot enforce a one-time permission (no hook sees its tool calls); ask with pi, or without a grant`;
            const log = await ctx.logger.write(message);
            return {
              result: "failed",
              data: {
                reason: "grant_unsupported",
                message,
                exitCode: null,
                signal: null,
                sessionId: null,
                finalMessage: null,
                usage: standardUsage(who, undefined, null),
                log,
                durationMs: 0,
                stderr: [message],
              },
            };
          }

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
                usage: standardUsage(who, undefined, null),
                log,
                durationMs: 0,
                stderr: [cwdProblem],
              },
            };
          }

          // Operad's tools: radian starts the server named in this file.
          const operadTools = operadToolsOf(input.operadTools ?? flow.operadTools);
          // A bot's servers: each is started behind its guard, which holds the secrets.
          const mounted = mountedServersOf(input.mcpServers ?? flow.mcpServers);
          let mcpConfig: string | undefined;
          if (operadTools !== undefined || mounted !== undefined) {
            const servers: Record<string, unknown> = {};
            if (operadTools !== undefined) {
              const server = serverCommand(operadTools);
              servers[OPERAD_SERVER] = {
                command: server.command,
                args: server.args,
                env: { OPERAD_HOME: operadTools.home },
              };
            }
            for (const [name, server] of Object.entries(mounted ?? {})) {
              servers[name] = { command: server.command, args: server.args };
            }
            mcpConfig = `${ctx.logger.path}.mcp.json`;
            await mkdir(dirname(mcpConfig), { recursive: true });
            await writeFile(mcpConfig, JSON.stringify({ mcpServers: servers }));
          }
          // radian runs its own tools and has no way to ask, so the profile's
          // rules are given to it as a hook it runs before each call.
          const hookConfig = hasProfileRules(logProfile)
            ? await writeHookConfig(`${ctx.logger.path}.hook`, logProfile)
            : undefined;
          const command = radianArgs(cwd, args, promptWithNote, resumeSession, mcpConfig, hookConfig);
          const started = Date.now();
          const jsonl = new JsonlLog(ctx.logger, defaults.clock);
          let result: ParsedResult | undefined;
          const openTools = new Map<string, { at: number; name: string }>();

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
              const logged = radianLogLine(line, defaults.now, openTools, cwd, logProfile, logSecrets);
              const writing = jsonl.push(logged);
              deliverLine(ctx.receiver, logged, logSecrets);
              const parsed = parseResult(line);
              if (parsed !== undefined) result = parsed;
              return writing;
            },
          });
          await jsonl.end();

          // A resumed run continues the session it was given. Another id means
          // radian started afresh and the earlier conversation is lost.
          if (
            resumeSession !== undefined &&
            result !== undefined &&
            !outcome.cancelled &&
            outcome.exitCode === 0 &&
            result.sessionId !== resumeSession
          ) {
            return {
              result: "failed",
              data: failureData(who, outcome, result, ctx.logger.path, Date.now() - started, {
                reason: "session_missing",
                message: `radian did not continue the session ${resumeSession}; it answered with ${result.sessionId ?? "no session"}`,
              }),
            };
          }

          return resultFor(
            who,
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
          : text(ctx.settings.command, "radian: settings.command");
      const found = await findCommand(command);
      if (found === undefined) {
        throw new Error(`${command} was not found on PATH`);
      }
      return `${command} is available`;
    },
  });
}

export default createRadianHarnessPlugin();
