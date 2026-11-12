/**
 * The claude harness, hub side: one `agent` step that starts the child program
 * `worker.ts` under Bun, writes one JSON object to its stdin and reads the last
 * `result` line of its stdout, plus the `claude:prompt` flow. The step
 * has the params, result names and facts of `pi/agent`, so a flow
 * changes harness by changing `use`. The Agent SDK is imported only by the
 * child program, never by the hub.
 */

import { secretValuesOf } from "@operad-io/access-match";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  answerGrant,
  askToolEvent,
  canAsk,
  createCallAsker,
  CONCURRENCY_SETTING,
  eventNote,
  askNote,
  flagValue,
  hasGrants,
  directoryError,
  inboxOf,
  optionalText,
  parseResult,
  parseStepFlags,
  resultFor,
  secs,
  stringListParam,
  text,
  imageInputsOf,
  operadToolsOf,
  mountedServersOf,
  JsonlLog,
  modelLimit,
  standardUsage,
  type UsageSource,
  runAgent,
  systemClock,
  type Clock,
  type ToolEvent,
} from "@operad-io/harness-process";
import { CLAUDE_FLOOR, DEFAULT_CLAUDE_COMMAND, inspectClaude, sdkVersion } from "./claude-install.ts";
import { DEFAULT_BASH_TIMEOUT_SECS, EFFORT_LEVELS, type WorkerResult } from "./protocol.ts";

/** How long an agent may run before the step stops it. */
export const DEFAULT_WALL_TIME_SECS = 3600;

/** How long an agent may go without a new output line. */
export const DEFAULT_STALL_SECS = 600;

/** One run of the step may take this long; it is above every allowed wall time. */
export const STEP_TIMEOUT_SECS = 8 * 3600;

/** The longest wall time a run may ask for: the step timeout minus a margin. */
export const MAX_WALL_TIME_SECS = STEP_TIMEOUT_SECS - 300;

const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));

/** The name the plugin goes by in usage and limit keys. */
const HARNESS = "claude";

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

/** The models a chat may pick with this agent, and the one used when none is set. */
export const CLAUDE_MODELS = {
  list: ["opus", "sonnet", "haiku"],
  default: "sonnet",
} as const;

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
    bashTimeoutSecs: {
      type: "integer" as const,
      minimum: 1,
      default: DEFAULT_BASH_TIMEOUT_SECS,
      description:
        "The longest one Bash call may run, in seconds. Nothing runs in the background, so a long gate runs in the foreground within this time.",
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

function optionalNumber(value: unknown, at: string, integer: boolean): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${at}: must be a positive ${integer ? "integer" : "number"}`);
  }
  return value;
}

/** The spelling of this harness's step `args`. */
const STEP_FLAGS = { levelFlag: "--effort", levels: EFFORT_LEVELS, modelHint: "<name>" } as const;

/**
 * Creates the claude harness plugin. Its worker is `worker.ts` under the
 * running Bun; a test replaces the program with a fake that prints fixed lines.
 */
export function createClaudeHarnessPlugin(options: ClaudeHarnessOptions = {}) {
  const clock = options.clock ?? systemClock;
  const command = options.command ?? process.execPath;
  const commandArgs = options.args ?? [WORKER_PATH];

  const promptFlow = defineFlow({
    name: "claude:prompt",
    entry: "agent",
    steps: [
      {
        id: "agent",
        kind: "plugin",
        params: { use: "claude/agent", params: {} },
        replay: "unsafe",
        next: { done: "done", failed: "failed", interrupted: "cancelled", waiting: "person" },
      },
      {
        // A question about a call ran out of grace. The answer sends the run
        // back to the agent, which continues the session with it.
        id: "person",
        kind: "wait_person",
        params: { prompt: "The agent asked about a call.", choices: ["allow_once", "reject_once"] },
        replay: "safe",
        next: { allow_once: "agent", reject_once: "agent", interrupted: "cancelled" },
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
    models: CLAUDE_MODELS,
    settings: PLUGIN_SETTINGS,
    steps: [
      {
        name: "agent",
        // A question's answer comes back as `resumeSession` and `askAnswer`.
        resumable: true,
        // `waiting`: a question about a call was not answered within the grace.
        results: ["done", "failed", "interrupted", "waiting"],
        // The deny and ask fields are applied in the worker's canUseTool.
        enforces: ["denyPaths", "denyCommands", "askCommands", "askPaths", "readPaths"],
        timeoutSecs: STEP_TIMEOUT_SECS,
        // The model the step uses: its `--model` argument, else the setting.
        limit: modelLimit(HARNESS, (params, settings) => {
          const fromArgs = isRecord(params) ? flagValue(params.args, "--model") : undefined;
          const model = fromArgs ?? settings.model;
          return typeof model === "string" && model.length > 0 ? model : undefined;
        }),
        async run(ctx: StepContext, params: unknown): Promise<PluginStepResult> {
          const at = "claude/agent";
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
            stringListParam(input.args === undefined ? flow.args : input.args, `${at}: params.args`),
            STEP_FLAGS,
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
          const effort = flags.level ?? optionalText(ctx.settings.effort, `${at}: settings.effort`);
          const maxTurns = optionalNumber(ctx.settings.maxTurns, `${at}: settings.maxTurns`, true);
          const budgetUsd = optionalNumber(ctx.settings.budgetUsd, `${at}: settings.budgetUsd`, false);
          const bashTimeoutSecs = optionalNumber(
            ctx.settings.bashTimeoutSecs,
            `${at}: settings.bashTimeoutSecs`,
            true,
          );

          const cwdProblem = await directoryError(cwd);
          if (cwdProblem !== undefined) return refuse("cwd", cwdProblem);

          const operadTools = operadToolsOf(input.operadTools ?? flow.operadTools);
          const mcpServers = mountedServersOf(input.mcpServers ?? flow.mcpServers);
          const images = imageInputsOf(input.images ?? flow.images);
          const claudeCommand = optionalText(ctx.settings.command, `${at}: settings.command`);
          const storeSecrets = await secretValuesOf(ctx.secrets);
          const stdin: Record<string, unknown> = {
            prompt: promptWithNote,
            cwd,
            ...(claudeCommand === undefined ? {} : { command: claudeCommand }),
            ...(resumeSession === undefined ? {} : { resumeSession }),
            ...(model === undefined ? {} : { model }),
            ...(effort === undefined ? {} : { effort }),
            ...(maxTurns === undefined ? {} : { maxTurns }),
            ...(budgetUsd === undefined ? {} : { budgetUsd }),
            ...(bashTimeoutSecs === undefined ? {} : { bashTimeoutSecs }),
            ...(operadTools === undefined ? {} : { operadTools }),
            ...(mcpServers === undefined ? {} : { mcpServers }),
            ...(images.length === 0 ? {} : { images }),
            ...(isRecord(ctx.access) ? { access: ctx.access } : {}),
            ...(storeSecrets.length === 0 ? {} : { secretValues: storeSecrets }),
          };

          const inbox = inboxOf(params);
          const started = Date.now();
          const jsonl = new JsonlLog(ctx.logger);
          let result: WorkerResult | undefined;
          // Ends the program when a question about a call runs out of grace.
          const stopper = new AbortController();
          const asker = createCallAsker({
            ask: (request) => ctx.ask(request),
            onStop: () => stopper.abort(),
            secrets: storeSecrets,
          });

          const outcome = await runAgent({
            command,
            args: commandArgs,
            cwd,
            stdin: JSON.stringify(stdin),
            // The program may ask to use a one-time permission; it needs a reply.
            interactive: hasGrants(ctx.access) || canAsk(ctx.access) || inbox !== undefined,
            inbox,
            wallMs: wallTimeSecs * 1000,
            stallMs: stallSecs * 1000,
            signal: AbortSignal.any([ctx.signal, stopper.signal]),
            clock,
            toolEvent: (line) => claudeToolEvent(line) ?? askToolEvent(line),
            async onLine(line, reply) {
              await answerGrant(line, (waitId) => ctx.useGrant(waitId), reply);
              await asker.handle(line, reply);
              const writing = jsonl.push(line);
              const parsed = parseResult<WorkerResult>(line);
              if (parsed !== undefined) result = parsed;
              return writing;
            },
          });
          await jsonl.end();

          // The grace passed with a question open: the program was ended on
          // purpose. The kernel turns this into the result `waiting`, and the
          // answer comes back with the session and a one-time grant.
          const unanswered = asker.stopped();
          if (unanswered !== undefined && !ctx.signal.aborted) throw unanswered.error;

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
