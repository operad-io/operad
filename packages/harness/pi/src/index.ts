/**
 * The pi harness, hub side: one `agent` step that starts the child program
 * `worker.ts` under Bun, writes one JSON object to its stdin and reads the last
 * `result` line of its stdout, plus the `pi:prompt` flow. The step has
 * the params, result names and facts of `radian/agent`, so a flow
 * changes harness by changing `use`. pi's library is imported only by the child
 * program, never by the hub.
 */

import pkg from "../package.json" with { type: "json" };
import { secretValuesOf } from "@operad-io/access-match";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isRecord,
  paramsObject,
  defineFlow,
  definePlugin,
  type HarnessModelContext,
  type HarnessModelInfo,
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
  keepKeyOf,
  hasGrants,
  inboxOf,
  imageInputsOf,
  operadToolsOf,
  JsonlLog,
  deliverLine,
  modelLimit,
  standardUsage,
  StepTimings,
  withTimings,
  type UsageSource,
  directoryError,
  optionalText,
  resultValue,
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
  type KeptRunOptions,
  type ToolEvent,
} from "@operad-io/harness-process";
import { authFileHasCredential } from "./auth-file.ts";
import {
  PI_LIST_TIMEOUT_MS,
  piModelInfo,
  piModelList,
  piModelListReady,
  piModelWindows,
} from "./model-list.ts";
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
  /** The time now in milliseconds; defaults to `Date.now`. It ages the cached catalogue. */
  readonly now?: (() => number) | undefined;
  /** How long `pi --list-models` may take; defaults to `PI_LIST_TIMEOUT_MS`. */
  readonly listTimeoutMs?: number | undefined;
  /** pi's settings file, where its default model is; defaults to `~/.pi/agent/settings.json`. */
  readonly piSettingsPath?: string | undefined;
  /** Test seam: how long a chat's worker is kept after a reply. */
  readonly keepMs?: number | undefined;
  /** Test seam: how long a kept worker may take to answer its first line. */
  readonly keptFirstLineMs?: number | undefined;
  /** Test seam: how many workers one home keeps. */
  readonly maxKept?: number | undefined;
}

/** pi's own default model, from its settings file; undefined when it names none. */
function piDefaultModel(settingsPath: string): string | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (!isRecord(value)) return undefined;
    const { defaultProvider, defaultModel } = value;
    if (typeof defaultProvider !== "string" || typeof defaultModel !== "string") return undefined;
    return defaultProvider === "" || defaultModel === "" ? undefined : `${defaultProvider}/${defaultModel}`;
  } catch {
    return undefined;
  }
}

/** What pi is likely to use: the model's provider, else its settings' default provider. */
function piProvider(model: unknown, settingsPath: string): string | undefined {
  if (typeof model === "string" && model.includes("/")) {
    const provider = model.slice(0, model.indexOf("/"));
    if (provider.length > 0) return provider;
  }
  try {
    const value: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (isRecord(value) && typeof value.defaultProvider === "string" && value.defaultProvider.length > 0) {
      return value.defaultProvider;
    }
  } catch {
    // No settings file, or one this cannot read: no provider is known.
  }
  return undefined;
}

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
      title: "Model",
      minLength: 3,
      description: "The model as provider/id; unset uses pi's default model.",
    },
    models: {
      type: "array" as const,
      title: "Model choices",
      items: { type: "string" as const, minLength: 3 },
      description:
        "The models a chat may pick, as provider/id; unset offers every model pi lists.",
    },
    thinkingLevel: {
      type: "string" as const,
      title: "Effort",
      enum: THINKING_LEVELS,
      description: "The reasoning level; unset uses pi's default.",
    },
    command: {
      type: "string" as const,
      title: "Pi command",
      minLength: 1,
      default: DEFAULT_PI_COMMAND,
      description:
        "The pi command: a name on PATH or a path. It must lead into an installed @earendil-works/pi-coding-agent; point it at the package's bin when `pi` is a wrapper script.",
    },
    authPath: {
      type: "string" as const,
      title: "Credentials file",
      minLength: 1,
      default: DEFAULT_AUTH_PATH,
      description: "pi's credentials file.",
    },
    modelsPath: {
      type: "string" as const,
      title: "Models file",
      minLength: 1,
      default: DEFAULT_MODELS_PATH,
      description: "pi's custom models file.",
    },
    wallTimeSecs: {
      type: "number" as const,
      title: "Run time limit",
      minimum: 1,
      maximum: MAX_WALL_TIME_SECS,
      default: DEFAULT_WALL_TIME_SECS,
      description: "The longest one agent run may take.",
    },
    stallSecs: {
      type: "number" as const,
      title: "Stall limit",
      minimum: 1,
      default: DEFAULT_STALL_SECS,
      description: "How long an agent may be silent while no tool call is open.",
    },
    bashTimeoutSecs: {
      type: "integer" as const,
      title: "Bash timeout",
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
  const now = options.now ?? Date.now;
  const listTimeoutMs = options.listTimeoutMs ?? PI_LIST_TIMEOUT_MS;
  const piSettingsPath =
    options.piSettingsPath ?? join(homedir(), ".pi", "agent", "settings.json");

  function modelsPathOf(settings: Readonly<Record<string, unknown>>): string {
    return typeof settings.modelsPath === "string" && settings.modelsPath !== ""
      ? settings.modelsPath
      : DEFAULT_MODELS_PATH;
  }

  function listOptions(
    piCommand: string,
    context: HarnessModelContext,
    modelsPath: string = DEFAULT_MODELS_PATH,
  ) {
    return {
      home: context.home,
      command: piCommand,
      now,
      timeoutMs: listTimeoutMs,
      log: context.log,
      registryPath: join(dirname(expandHome(modelsPath)), "models-store.json"),
    };
  }

  function stringList(value: unknown): readonly string[] | undefined {
    return Array.isArray(value) && value.every((item) => typeof item === "string")
      ? (value as readonly string[])
      : undefined;
  }

  function piCommandOf(settings: Readonly<Record<string, unknown>>): string {
    return typeof settings.command === "string" && settings.command !== ""
      ? settings.command
      : DEFAULT_PI_COMMAND;
  }

  /** The context windows pi's kept list gives for the models this chat may pick. */
  function windowsOf(
    options: ReturnType<typeof listOptions>,
    list: readonly string[],
  ): Readonly<Record<string, number>> | undefined {
    const known = piModelWindows(options);
    const windows: Record<string, number> = {};
    for (const model of list) {
      const window = known[model];
      if (window !== undefined) windows[model] = window;
    }
    return Object.keys(windows).length === 0 ? undefined : windows;
  }

  /** What pi's kept list says about the models this chat may pick. */
  function infoOf(
    options: ReturnType<typeof listOptions>,
    list: readonly string[],
  ): Readonly<Record<string, HarnessModelInfo>> | undefined {
    const known = piModelInfo(options);
    const info: Record<string, HarnessModelInfo> = {};
    for (const model of list) {
      const found = known[model];
      if (found !== undefined) info[model] = found;
    }
    return Object.keys(info).length === 0 ? undefined : info;
  }

  /** The models a chat may pick and the default among them, from the kept list. */
  function piModels(
    settings: Readonly<Record<string, unknown>>,
    context: HarnessModelContext,
  ): {
    list: readonly string[];
    default: string | null;
    windows?: Readonly<Record<string, number>> | undefined;
    info?: Readonly<Record<string, HarnessModelInfo>> | undefined;
  } {
    const command = piCommandOf(settings);
    const configured = stringList(settings.models);
    const options = listOptions(command, context, modelsPathOf(settings));
    const list = configured ?? piModelList(options);
    const wanted =
      typeof settings.model === "string" && settings.model !== ""
        ? settings.model
        : piDefaultModel(piSettingsPath);
    const windows = windowsOf(options, list);
    const info = infoOf(options, list);
    return {
      list,
      default: wanted !== undefined && list.includes(wanted) ? wanted : null,
      ...(windows === undefined ? {} : { windows }),
      ...(info === undefined ? {} : { info }),
    };
  }

  /**
   * The models a chat may pick, waiting for pi's first list when the home has
   * none yet. A configured `models` setting asks nothing and wins as it always did.
   */
  async function piModelsReady(
    settings: Readonly<Record<string, unknown>>,
    context: HarnessModelContext,
  ): Promise<{
    list: readonly string[];
    default: string | null;
    windows?: Readonly<Record<string, number>> | undefined;
    info?: Readonly<Record<string, HarnessModelInfo>> | undefined;
  }> {
    const command = piCommandOf(settings);
    const configured = stringList(settings.models);
    const options = listOptions(command, context, modelsPathOf(settings));
    const list = configured ?? (await piModelListReady(options));
    const wanted =
      typeof settings.model === "string" && settings.model !== ""
        ? settings.model
        : piDefaultModel(piSettingsPath);
    const windows = windowsOf(options, list);
    const info = infoOf(options, list);
    return {
      list,
      default: wanted !== undefined && list.includes(wanted) ? wanted : null,
      ...(windows === undefined ? {} : { windows }),
      ...(info === undefined ? {} : { info }),
    };
  }

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
          choices: ["allow_once", "reject_once"],
          lateChoices: ["allow_always"],
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
    version: pkg.version,
    models: piModels,
    modelsReady: piModelsReady,
    efforts: PI_EFFORTS,
    capabilities: { loadsSkills: true, takesMessagesMidRun: true, accessLevels: ["plan", "ask", "edits", "full"] },
    signedIn: async (settings) => {
      const authPath = expandHome(
        typeof settings.authPath === "string" ? settings.authPath : DEFAULT_AUTH_PATH,
      );
      return authFileHasCredential(authPath, piProvider(settings.model, piSettingsPath));
    },
    settings: PLUGIN_SETTINGS,
    steps: [
      {
        name: "agent",
        // A question's answer comes back as `resumeSession` and `askAnswer`.
        resumable: true,
        // `waiting`: a question about a call was not answered within the grace.
        results: ["done", "failed", "interrupted", "waiting"],
        // The deny and ask fields are applied in the worker's tool_call hook.
        enforces: ["level", "denyPaths", "denyCommands", "askCommands", "askPaths", "readPaths", "alwaysAllow"],
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
          const timings = new StepTimings(now);
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
            const timing = timings.finish();
            return withTimings({
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
                durationMs: timing.totalMs,
                stderr: [message],
              },
            }, timing);
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

          const piCommand = optionalText(ctx.settings.command, `${at}: settings.command`);
          // A configured model pi does not list is reported once, here.
          const configured = stringList(ctx.settings.models);
          if (configured !== undefined && model !== undefined && configured.includes(model)) {
            const listed = piModelList(
              listOptions(
                piCommand ?? DEFAULT_PI_COMMAND,
                {
                  home: ctx.home,
                  log: (message) => {
                    void ctx.logger.write(message);
                  },
                },
                typeof ctx.settings.modelsPath === "string"
                  ? ctx.settings.modelsPath
                  : DEFAULT_MODELS_PATH,
              ),
            );
            if (listed.length > 0 && !listed.includes(model)) {
              await ctx.logger.write(`pi/agent: the model "${model}" is in settings.models but pi does not list it`);
            }
          }

          const cwdProblem = await directoryError(cwd);
          if (cwdProblem !== undefined) {
            const log = await ctx.logger.write(cwdProblem);
            const timing = timings.finish();
            return withTimings({
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
                durationMs: timing.totalMs,
                stderr: [cwdProblem],
              },
            }, timing);
          }

          const agentDir = join(ctx.home, "harness", "pi");
          const sessionDir = join(agentDir, "sessions");
          await mkdir(sessionDir, { recursive: true });

          const operadTools = operadToolsOf(input.operadTools ?? flow.operadTools);
          const skills = stringListParam(
            input.skills === undefined ? flow.skills : input.skills,
            `${at}: params.skills`,
          );
          const ownSettings = input.useOwnSettings ?? flow.useOwnSettings;
          if (ownSettings !== undefined && typeof ownSettings !== "boolean") {
            throw new Error(`${at}: params.useOwnSettings: must be a boolean`);
          }
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
            ...(skills.length === 0 ? {} : { skills }),
            ...(ownSettings === true ? { useOwnSettings: true } : {}),
            ...(runAccess === undefined ? {} : { access: runAccess }),
            ...(storeSecrets.length === 0 ? {} : { secretValues: storeSecrets }),
          };

          const keepRequested = input.keepWorker === true;
          const keep: KeptRunOptions | undefined =
            keepRequested && ctx.object !== undefined
              ? {
                  home: ctx.home,
                  name: "pi",
                  scope: `${ctx.object.type}:${ctx.object.id}`,
                  key: keepKeyOf({
                    ...stdin,
                    mcpServers: input.mcpServers ?? flow.mcpServers,
                  }),
                  ...(options.keepMs === undefined ? {} : { timeoutMs: options.keepMs }),
                  ...(options.keptFirstLineMs === undefined ? {} : { firstLineMs: options.keptFirstLineMs }),
                  ...(options.maxKept === undefined ? {} : { max: options.maxKept }),
                }
              : undefined;

          const inbox = inboxOf(params);
          const jsonl = new JsonlLog(ctx.logger, clock, now);
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
            ...(keep === undefined ? {} : { keep }),
            wallMs: wallTimeSecs * 1000,
            stallMs: stallSecs * 1000,
            signal: AbortSignal.any([ctx.signal, stopper.signal]),
            clock,
            toolEvent: (line) => piToolEvent(line) ?? askToolEvent(line),
            async onLine(line, reply) {
              const received = jsonl.stamp(line);
              timings.record(received.value, received.at);
              await answerGrant(received.text, (waitId) => ctx.useGrant(waitId), reply);
              await asker.handle(received.text, reply);
              const writing = jsonl.pushStamped(received);
              deliverLine(ctx.receiver, received.text, storeSecrets);
              const parsed = resultValue<WorkerResult>(received.value);
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

          const timing = timings.finish();
          const stepResult = resultFor(
            { harness: "pi", model: model ?? null },
            outcome,
            result,
            ctx.logger.path,
            timing.totalMs,
            { wallTimeSecs, stallSecs },
            command,
          );
          return withTimings(stepResult, timing);
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

export {
  PI_LIST_CACHE_MS,
  PI_LIST_TIMEOUT_MS,
  parsePiCatalogue,
  parsePiCatalogueModels,
  parsePiCatalogueRows,
  parsePiRegistry,
  piModelInfo,
  piModelListPath,
} from "./model-list.ts";
