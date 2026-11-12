/**
 * The pi harness, hub side: one `agent` step that starts the child program
 * `worker.ts` under Bun, writes one JSON object to its stdin and reads the last
 * `result` line of its stdout, plus the `pi:prompt` flow. The step has
 * the params, result names and facts of `radian/agent`, so a flow
 * changes harness by changing `use`. pi's library is imported only by the child
 * program, never by the hub.
 */

import { secretValuesOf } from "@operad-io/access-match";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isRecord,
  paramsObject,
  defineFlow,
  definePlugin,
  type PluginStepResult,
  type StepContext,
} from "@operad-io/engine";
import {
  ALLOW_ALWAYS,
  accessWithAlwaysAllow,
  alwaysAllowFromGrant,
  appendAlwaysAllow,
  answerGrant,
  askToolEvent,
  canAsk,
  createCallAsker,
  CONCURRENCY_SETTING,
  eventNote,
  askNote,
  flagValue,
  hasGrants,
  inboxOf,
  imageInputsOf,
  operadToolsOf,
  JsonlLog,
  deliverLine,
  modelLimit,
  standardUsage,
  type UsageSource,
  directoryError,
  optionalText,
  parseResult,
  parseStepFlags,
  personStarted,
  readAlwaysAllow,
  resultFor,
  secs,
  stringListParam,
  text,
  type StepFlagSpec,
  runAgent,
  systemClock,
  type Clock,
  type ToolEvent,
} from "@operad-io/harness-process";
import { DEFAULT_PI_COMMAND, findPi, PI_FLOOR } from "./pi-install.ts";
import {
  DEFAULT_BASH_TIMEOUT_SECS,
  THINKING_LEVELS,
  type WorkerResult,
  type WorkerThinkingLevel,
} from "./protocol.ts";

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

/** The models a chat may pick with this agent, and the one used when none is set. */
export const PI_MODELS = {
  list: ["anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5", "anthropic/claude-haiku-5-5"],
  default: "anthropic/claude-sonnet-5-5",
} as const;

/** The efforts a chat may pick with this agent, mapped to its thinking levels. */
export const PI_EFFORTS = {
  list: THINKING_LEVELS,
  default: "medium",
  flag: "--thinking",
} as const;

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
    command: {
      type: "string" as const,
      minLength: 1,
      default: DEFAULT_PI_COMMAND,
      description:
        "The pi command: a name on PATH or a path. It must lead into an installed @earendil-works/pi-coding-agent; point it at the package's bin when `pi` is a wrapper script.",
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
    bashTimeoutSecs: {
      type: "integer" as const,
      minimum: 1,
      default: DEFAULT_BASH_TIMEOUT_SECS,
      description:
        "The longest one bash call may run, in seconds. A longer call is stopped and the model gets an error; the run goes on.",
    },
    concurrency: CONCURRENCY_SETTING,
  },
  additionalProperties: false as const,
};

function optionalPositiveInteger(value: unknown, at: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${at}: must be a positive integer`);
  }
  return value;
}

/** The spelling of this harness's step `args`; the parsing is harness-process's. */
const STEP_FLAGS: StepFlagSpec<WorkerThinkingLevel> = {
  levelFlag: "--thinking",
  levels: THINKING_LEVELS,
  modelHint: "<provider/id>",
  dashValues: true,
  modelProblem: (value) =>
    /^[^/\s]+\/\S+$/.test(value) ? undefined : `args: "--model ${value}": the value must be provider/id`,
};

/** Expands a leading `~` to the user's home directory. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(path);
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
    name: "pi:prompt",
    entry: "agent",
    steps: [
      {
        id: "agent",
        kind: "plugin",
        params: { use: "pi/agent", params: {} },
        replay: "unsafe",
        next: { done: "done", failed: "failed", interrupted: "cancelled", waiting: "person" },
      },
      {
        // A question about a call ran out of grace. The answer sends the run
        // back to the agent, which continues the session with it.
        id: "person",
        kind: "wait_person",
        params: {
          prompt: "The agent asked about a call.",
          choices: ["allow_once", "allow_always", "reject_once"],
        },
        replay: "safe",
        next: {
          allow_once: "agent",
          allow_always: "agent",
          reject_once: "agent",
          interrupted: "cancelled",
        },
      },
      { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
      { id: "failed", kind: "end", params: { status: "failed" }, replay: "safe" },
      { id: "cancelled", kind: "end", params: { status: "cancelled" }, replay: "safe" },
    ],
  });

  return definePlugin({
    name: "pi",
    kind: "harness",
    version: "0.0.0",
    models: PI_MODELS,
    efforts: PI_EFFORTS,
    settings: PLUGIN_SETTINGS,
    steps: [
      {
        name: "agent",
        // A question's answer comes back as `resumeSession` and `askAnswer`.
        resumable: true,
        // `waiting`: a question about a call was not answered within the grace.
        results: ["done", "failed", "interrupted", "waiting"],
        // The deny and ask fields are applied in the worker's tool_call hook.
        enforces: ["denyPaths", "denyCommands", "askCommands", "askPaths", "readPaths", "alwaysAllow"],
        timeoutSecs: STEP_TIMEOUT_SECS,
        // The model the step uses: its `--model` argument, else the setting.
        limit: modelLimit("pi", (params, settings) => {
          const fromArgs = isRecord(params)
            ? flagValue(params.args, "--model")
            : undefined;
          const model = fromArgs ?? settings.model;
          return typeof model === "string" && model.length > 0 ? model : undefined;
        }),
        async run(ctx: StepContext, params: unknown): Promise<PluginStepResult> {
          const at = "pi/agent";
          const input = paramsObject(params, at);
          const flow = isRecord(ctx.params) ? ctx.params : {};

          const prompt = text(input.prompt ?? flow.prompt, `${at}: params.prompt`);
          const note = eventNote(ctx.trigger);
          const rawAskAnswer = input.askAnswer ?? flow.askAnswer;
          const answerNote = askNote(rawAskAnswer);
          const promptWithNote = [prompt, note, answerNote]
            .filter((part): part is string => part !== undefined)
            .join("\n\n");
          const cwd = text(input.cwd ?? flow.cwd, `${at}: params.cwd`);
          const flags = parseStepFlags(
            stringListParam(input.args === undefined ? flow.args : input.args, `${at}: params.args`),
            STEP_FLAGS,
          );
          // The model the step will use, known before anything can fail.
          const knownModel =
            typeof flags === "string"
              ? flagValue(input.args === undefined ? flow.args : input.args, "--model") ??
                (typeof ctx.settings.model === "string" ? ctx.settings.model : undefined)
              : (flags.model ??
                (typeof ctx.settings.model === "string" ? ctx.settings.model : undefined));
          const early: UsageSource = { harness: "pi", model: knownModel ?? null };
          if (typeof flags === "string") {
            const message = `${at}: ${flags}`;
            const log = await ctx.logger.write(message);
            return {
              result: "failed",
              data: {
                reason: "invalid_args",
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
          }
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
          const bashTimeoutSecs = optionalPositiveInteger(
            ctx.settings.bashTimeoutSecs,
            `${at}: settings.bashTimeoutSecs`,
          );
          const model =
            flags.model ?? optionalText(ctx.settings.model, `${at}: settings.model`);
          const thinkingLevel =
            flags.level ??
            optionalText(input.effort, `${at}: params.effort`) ??
            optionalText(ctx.settings.thinkingLevel, `${at}: settings.thinkingLevel`);
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
                usage: standardUsage(early, undefined, null),
                log,
                durationMs: 0,
                stderr: [cwdProblem],
              },
            };
          }

          const agentDir = join(ctx.home, "harness", "pi");
          const sessionDir = join(agentDir, "sessions");
          await mkdir(sessionDir, { recursive: true });

          const piCommand = optionalText(ctx.settings.command, `${at}: settings.command`);
          const operadTools = operadToolsOf(input.operadTools ?? flow.operadTools);
          const storeSecrets = await secretValuesOf(ctx.secrets);
          const allowAlways = personStarted(ctx.trigger);
          if (allowAlways && isRecord(rawAskAnswer) && rawAskAnswer["choice"] === ALLOW_ALWAYS) {
            const entry = alwaysAllowFromGrant(ctx.access, cwd);
            if (entry !== undefined) {
              try {
                await appendAlwaysAllow(ctx.home, entry);
              } catch (error) {
                await ctx.logger.write(
                  `allow_always could not be written to the user access file: ${String(error)}; this call runs once`,
                );
              }
            }
          }
          let runAccess = accessWithAlwaysAllow(ctx.access, [], false);
          if (allowAlways) {
            const user = await readAlwaysAllow(ctx.home);
            if (user.problem !== undefined) await ctx.logger.write(user.problem);
            runAccess = accessWithAlwaysAllow(ctx.access, user.entries, true);
          }
          const stdin: Record<string, unknown> = {
            prompt: promptWithNote,
            cwd,
            authPath,
            modelsPath,
            agentDir,
            sessionDir,
            ...(piCommand === undefined ? {} : { piCommand }),
            ...(resumeSession === undefined ? {} : { resumeSession }),
            ...(model === undefined ? {} : { model }),
            ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
            ...(bashTimeoutSecs === undefined ? {} : { bashTimeoutSecs }),
            ...(operadTools === undefined ? {} : { operadTools }),
            ...(imageInputsOf(input.images ?? flow.images).length === 0
              ? {}
              : { images: imageInputsOf(input.images ?? flow.images) }),
            ...(runAccess === undefined ? {} : { access: runAccess }),
            ...(storeSecrets.length === 0 ? {} : { secretValues: storeSecrets }),
          };

          const inbox = inboxOf(params);
          const started = Date.now();
          const jsonl = new JsonlLog(ctx.logger, clock);
          let result: WorkerResult | undefined;
          // Ends the program when a question about a call runs out of grace.
          const stopper = new AbortController();
          const asker = createCallAsker({
            ask: (request) => ctx.ask(request),
            onStop: () => stopper.abort(),
            secrets: storeSecrets,
            ...(allowAlways ? { alwaysAllow: { home: ctx.home, cwd } } : {}),
            onLog: (message) => {
              void ctx.logger.write(message);
            },
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
            toolEvent: (line) => piToolEvent(line) ?? askToolEvent(line),
            async onLine(line, reply) {
              await answerGrant(line, (waitId) => ctx.useGrant(waitId), reply);
              await asker.handle(line, reply);
              const writing = jsonl.push(line);
              deliverLine(ctx.receiver, line, storeSecrets);
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
            { harness: "pi", model: model ?? null },
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
      const piCommand = optionalText(ctx.settings.command, "pi: settings.command");
      // The user's own pi: found and version-checked, not loaded.
      const pi = findPi(piCommand ?? DEFAULT_PI_COMMAND);
      if (options.command === undefined && !existsSync(process.execPath)) {
        throw new Error("bun was not found");
      }
      if (options.args === undefined && !existsSync(WORKER_PATH)) {
        throw new Error(`the worker program is missing: ${WORKER_PATH}`);
      }
      return `pi ${pi.version} at ${pi.dir} (floor ${PI_FLOOR}); the worker program is available`;
    },
  });
}

export default createPiHarnessPlugin();
