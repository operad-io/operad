/**
 * The pi harness, hub side: one `agent` step that starts the child program
 * `worker.ts` under Bun, writes one JSON object to its stdin and reads the last
 * `result` line of its stdout, plus the `pi:prompt` flow. The step has
 * the params, result names and facts of `radian/agent`, so a flow
 * changes harness by changing `use`. pi's library is imported only by the child
 * program, never by the hub.
 */

import pkg from "../package.json" with { type: "json" };
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isRecord,
  definePlugin,
  type HarnessEfforts,
  type HarnessModelContext,
  type HarnessModelInfo,
  type PluginStepResult,
  type StepContext,
} from "@operad-io/engine";
import {
  assertWorkerAvailable,
  CONCURRENCY_SETTING,
  DEFAULT_STALL_SECS,
  DEFAULT_WALL_TIME_SECS,
  flagValue,
  imageInputsOf,
  keepKeyOf,
  MAX_WALL_TIME_SECS,
  modelLimit,
  operadToolsOf,
  optionalPositive,
  optionalText,
  parseStepFlags,
  promptFlowOf,
  readAgentStep,
  runWorkerStep,
  STALL_SETTING,
  STEP_TIMEOUT_SECS,
  stringListParam,
  systemClock,
  text,
  toolExecutionEvent,
  WALL_TIME_SETTING,
  type Clock,
  type KeptRunOptions,
  type StepFlagSpec,
  shellWord,
} from "@operad-io/harness-process";
import { authFileHasCredential } from "./auth-file.ts";
import {
  PI_LIST_TIMEOUT_MS,
  piModelInfo,
  piModelList,
  piModelListReady,
  piModelWindows,
  readPiModelList,
} from "./model-list.ts";
import { DEFAULT_PI_COMMAND, findPi, PI_FLOOR, PI_VERSION, piPresent } from "./pi-install.ts";
import { runLoginStep, type LoginRunOptions } from "./login.ts";
import {
  DEFAULT_BASH_TIMEOUT_SECS,
  THINKING_LEVELS,
  type WorkerThinkingLevel,
} from "./protocol.ts";

export {
  DEFAULT_STALL_SECS,
  DEFAULT_WALL_TIME_SECS,
  MAX_WALL_TIME_SECS,
  STEP_TIMEOUT_SECS,
};

export { PI_PACKAGE, PI_VERSION } from "./pi-install.ts";

/** The tool call one pi line starts or settles, or undefined for another line. */
export { toolExecutionEvent as piToolEvent } from "@operad-io/harness-process";

export const DEFAULT_AUTH_PATH = "~/.pi/agent/auth.json";
export const DEFAULT_MODELS_PATH = "~/.pi/agent/models.json";

const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));

/** What a test injects: the clock and the program the step starts. */
export interface PiHarnessOptions {
  readonly clock?: Clock | undefined;
  /** The executable; defaults to the running Bun. */
  readonly command?: string | undefined;
  /** The arguments before the worker input; defaults to `worker.ts`. */
  readonly args?: readonly string[] | undefined;
  /** Test seam: the executable of a login; defaults to the running Bun. */
  readonly loginCommand?: string | undefined;
  /** Test seam: the arguments before a login's input; defaults to `login-worker.ts`. */
  readonly loginArgs?: readonly string[] | undefined;
  /** Test seam: how long a login may take; defaults to `LOGIN_TIMEOUT_MS`. */
  readonly loginTimeoutMs?: number | undefined;
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
  /** Test seam: reads a file as text; defaults to `readFileSync(path, "utf8")`. */
  readonly readFile?: ((path: string) => string) | undefined;
}

/** pi's settings file as an object; undefined when it cannot be read. */
function readPiSettings(
  settingsPath: string,
  readFile: (path: string) => string,
): Readonly<Record<string, unknown>> | undefined {
  try {
    const value: unknown = JSON.parse(readFile(settingsPath));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** pi's own default model, from its settings; undefined when it names none. */
function piDefaultModel(settings: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (settings === undefined) return undefined;
  const { defaultProvider, defaultModel } = settings;
  if (typeof defaultProvider !== "string" || typeof defaultModel !== "string") return undefined;
  return defaultProvider === "" || defaultModel === "" ? undefined : `${defaultProvider}/${defaultModel}`;
}

/** One of pi's thinking levels, or undefined for anything else. */
function thinkingLevelOf(value: unknown): WorkerThinkingLevel | undefined {
  return typeof value === "string"
    ? THINKING_LEVELS.find((level) => level === value)
    : undefined;
}

/** pi's own default thinking level, from its settings; undefined when it names none. */
function piDefaultThinkingLevel(
  settings: Readonly<Record<string, unknown>> | undefined,
): WorkerThinkingLevel | undefined {
  return settings === undefined ? undefined : thinkingLevelOf(settings.defaultThinkingLevel);
}

/** What pi is likely to use: the model's provider, else its settings' default provider. */
function piProvider(
  model: unknown,
  settings: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (typeof model === "string" && model.includes("/")) {
    const provider = model.slice(0, model.indexOf("/"));
    if (provider.length > 0) return provider;
  }
  return typeof settings?.defaultProvider === "string" && settings.defaultProvider.length > 0
    ? settings.defaultProvider
    : undefined;
}

/** pi's documented built-in thinking level, used when neither operad nor pi names one. */
export const PI_BUILTIN_THINKING_LEVEL = "medium" satisfies WorkerThinkingLevel;

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
    wallTimeSecs: WALL_TIME_SETTING,
    stallSecs: STALL_SETTING,
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

/** The models a pi chat may pick, with what pi's kept list says about each. */
export interface PiDeclaredModels {
  list: readonly string[];
  default: string | null;
  windows?: Readonly<Record<string, number>> | undefined;
  info?: Readonly<Record<string, HarnessModelInfo>> | undefined;
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
  const loginOptions: LoginRunOptions = {
    command: options.loginCommand ?? process.execPath,
    ...(options.loginArgs === undefined ? {} : { args: options.loginArgs }),
    ...(options.loginTimeoutMs === undefined ? {} : { timeoutMs: options.loginTimeoutMs }),
    now,
  };
  const listTimeoutMs = options.listTimeoutMs ?? PI_LIST_TIMEOUT_MS;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
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
      readFile,
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

  /**
   * The command an install is reached by: the setting as it is; when it is the
   * default `pi`, the pi operad installed in the home is used if PATH has none.
   */
  function piCommandFor(settings: Readonly<Record<string, unknown>>, home: string): string {
    const command = piCommandOf(settings);
    if (command !== DEFAULT_PI_COMMAND) return command;
    try {
      return findPi(command, { home }).command;
    } catch {
      return command;
    }
  }

  /** The context windows pi's kept list gives for the models this chat may pick. */
  function windowsOf(
    options: ReturnType<typeof listOptions>,
    kept: ReturnType<typeof readPiModelList> | null,
    list: readonly string[],
  ): Readonly<Record<string, number>> | undefined {
    const known = piModelWindows(options, kept);
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
    kept: ReturnType<typeof readPiModelList> | null,
    list: readonly string[],
  ): Readonly<Record<string, HarnessModelInfo>> | undefined {
    const known = piModelInfo(options, kept);
    const info: Record<string, HarnessModelInfo> = {};
    for (const model of list) {
      const found = known[model];
      if (found !== undefined) info[model] = found;
    }
    return Object.keys(info).length === 0 ? undefined : info;
  }

  /** The models a chat may pick and the default among them, from one kept read. */
  function declaredModels(
    settings: Readonly<Record<string, unknown>>,
    options: ReturnType<typeof listOptions>,
    kept: ReturnType<typeof readPiModelList> | null,
    list: readonly string[],
  ): PiDeclaredModels {
    const wanted =
      typeof settings.model === "string" && settings.model !== ""
        ? settings.model
        : piDefaultModel(readPiSettings(piSettingsPath, readFile));
    const windows = windowsOf(options, kept, list);
    const info = infoOf(options, kept, list);
    return {
      list,
      default: wanted !== undefined && list.includes(wanted) ? wanted : null,
      ...(windows === undefined ? {} : { windows }),
      ...(info === undefined ? {} : { info }),
    };
  }

  /** The models a chat may pick, from the kept list; `ready` waits for a first list. */
  function piModels(
    settings: Readonly<Record<string, unknown>>,
    context: HarnessModelContext,
  ): PiDeclaredModels;
  function piModels(
    settings: Readonly<Record<string, unknown>>,
    context: HarnessModelContext,
    ready: true,
  ): Promise<PiDeclaredModels>;
  function piModels(
    settings: Readonly<Record<string, unknown>>,
    context: HarnessModelContext,
    ready = false,
  ): PiDeclaredModels | Promise<PiDeclaredModels> {
    const configured = stringList(settings.models);
    const options = listOptions(piCommandFor(settings, context.home), context, modelsPathOf(settings));
    const first = readPiModelList(options) ?? null;
    if (configured !== undefined) return declaredModels(settings, options, first, configured);
    if (!ready) return declaredModels(settings, options, first, piModelList(options, first));
    return piModelListReady(options, first).then((list) =>
      declaredModels(settings, options, first ?? readPiModelList(options) ?? null, list),
    );
  }

  /**
   * The efforts a chat may pick, and the one it starts with: operad's
   * `thinkingLevel` when it sets one, else pi's own `defaultThinkingLevel`,
   * else pi's documented built-in level.
   */
  function piEfforts(settings: Readonly<Record<string, unknown>>): HarnessEfforts {
    const wanted =
      thinkingLevelOf(settings.thinkingLevel) ??
      piDefaultThinkingLevel(readPiSettings(piSettingsPath, readFile)) ??
      PI_BUILTIN_THINKING_LEVEL;
    return { list: THINKING_LEVELS, default: wanted, flag: "--thinking" };
  }

  const promptFlow = promptFlowOf("pi:prompt", "pi/agent");

  return definePlugin({
    name: "pi",
    kind: "harness",
    version: pkg.version,
    models: piModels,
    modelsReady: (settings, context) => piModels(settings, context, true),
    efforts: piEfforts,
    // The setting's pi, or the one operad installed when PATH has none.
    interactiveCommand: (settings, context) => {
      const command = piCommandFor(settings, context.home);
      return command === DEFAULT_PI_COMMAND ? undefined : shellWord(command);
    },
    capabilities: { loadsSkills: true, takesMessagesMidRun: true, accessLevels: ["plan", "ask", "edits", "full"] },
    // A command the owner set, or a replaced worker, is the check's to judge.
    agentMissing: (settings, context) =>
      options.command !== undefined ||
      (settings.command !== undefined && settings.command !== DEFAULT_PI_COMMAND) ||
      piPresent(context.home)
        ? undefined
        : "pi is not installed; run `operad plugin enable pi` to install operad's own",
    signedIn: async (settings) => {
      const authPath = expandHome(
        typeof settings.authPath === "string" ? settings.authPath : DEFAULT_AUTH_PATH,
      );
      return authFileHasCredential(
        authPath,
        piProvider(settings.model, readPiSettings(piSettingsPath, readFile)),
      );
    },
    settings: PLUGIN_SETTINGS,
    steps: [
      {
        name: "login",
        // A login asks a person and writes pi's own credential; it returns the
        // model they chose (ADR 0023 D11).
        results: ["done", "failed"],
        timeoutSecs: 660,
        run: (ctx: StepContext) => runLoginStep(ctx, loginOptions),
      },
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
          let authPath = "";
          let modelsPath = "";
          let bashTimeoutSecs: number | undefined;
          let piCommand: string | undefined;
          let operadTools: ReturnType<typeof operadToolsOf>;
          let skills: readonly string[] = [];
          let ownSettings: unknown;
          let retry: unknown;
          let compact: ReturnType<typeof compactOf>;
          let images: ReturnType<typeof imageInputsOf> = [];

          const step = await readAgentStep(ctx, params, {
            at,
            harness: "pi",
            flags: STEP_FLAGS,
            defaultWallTimeSecs: DEFAULT_WALL_TIME_SECS,
            defaultStallSecs: DEFAULT_STALL_SECS,
            maxWallTimeSecs: MAX_WALL_TIME_SECS,
            levelSetting: "thinkingLevel",
            now,
            async beforeDirectory(read) {
              bashTimeoutSecs = optionalPositive(
                ctx.settings.bashTimeoutSecs,
                `${at}: settings.bashTimeoutSecs`,
                true,
              );
              authPath = expandHome(
                text(ctx.settings.authPath ?? DEFAULT_AUTH_PATH, `${at}: settings.authPath`),
              );
              modelsPath = expandHome(
                text(ctx.settings.modelsPath ?? DEFAULT_MODELS_PATH, `${at}: settings.modelsPath`),
              );

              piCommand = optionalText(ctx.settings.command, `${at}: settings.command`);
              // A configured model pi does not list is reported once, here.
              const configured = stringList(ctx.settings.models);
              if (configured !== undefined && read.model !== undefined && configured.includes(read.model)) {
                const listed = piModelList(
                  listOptions(
                    piCommandFor(ctx.settings, ctx.home),
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
                if (listed.length > 0 && !listed.includes(read.model)) {
                  await ctx.logger.write(
                    `pi/agent: the model "${read.model}" is in settings.models but pi does not list it`,
                  );
                }
              }
            },
            async afterDirectory(read) {
              const agentDir = join(ctx.home, "harness", "pi");
              const sessionDir = join(agentDir, "sessions");
              await mkdir(sessionDir, { recursive: true });

              operadTools = operadToolsOf(read.input.operadTools ?? read.flow.operadTools);
              skills = stringListParam(
                read.input.skills === undefined ? read.flow.skills : read.input.skills,
                `${at}: params.skills`,
              );
              ownSettings = read.input.useOwnSettings ?? read.flow.useOwnSettings;
              if (ownSettings !== undefined && typeof ownSettings !== "boolean") {
                throw new Error(`${at}: params.useOwnSettings: must be a boolean`);
              }
              retry = read.input.retry ?? read.flow.retry;
              if (retry !== undefined && typeof retry !== "boolean") {
                throw new Error(`${at}: params.retry: must be a boolean`);
              }
              compact = compactOf(read.input.compact, `${at}: params.compact`);
              images = imageInputsOf(read.input.images ?? read.flow.images);
            },
          });
          if ("refused" in step) return step.refused;

          const { values, access } = step;
          const { resumeSession, wallTimeSecs, stallSecs, level: thinkingLevel } = values;
          // With the own-settings switch off the child's settings are in memory
          // and hold no default model (D3), so pi's own default is resolved here
          // and named to it (D4). A child told no model selects none.
          const model = values.model ?? piDefaultModel(readPiSettings(piSettingsPath, readFile));
          const runValues = model === undefined ? values : { ...values, model };
          const agentDir = join(ctx.home, "harness", "pi");
          const sessionDir = join(agentDir, "sessions");

          const stdin: Record<string, unknown> = {
            prompt: values.promptWithNote,
            cwd: values.cwd,
            authPath,
            modelsPath,
            agentDir,
            sessionDir,
            piHome: ctx.home,
            ...(piCommand === undefined ? {} : { piCommand }),
            ...(resumeSession === undefined ? {} : { resumeSession }),
            ...(model === undefined ? {} : { model }),
            ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
            ...(bashTimeoutSecs === undefined ? {} : { bashTimeoutSecs }),
            ...(operadTools === undefined ? {} : { operadTools }),
            ...(images.length === 0 ? {} : { images }),
            ...(skills.length === 0 ? {} : { skills }),
            ...(ownSettings === true ? { useOwnSettings: true } : {}),
            ...(retry === true ? { retry: true } : {}),
            ...(compact === undefined ? {} : { compact }),
            ...(access.runAccess === undefined ? {} : { access: access.runAccess }),
            ...(access.secrets.length === 0 ? {} : { secretValues: access.secrets }),
          };

          const keep: KeptRunOptions | undefined =
            values.input.keepWorker === true && ctx.object !== undefined
              ? {
                  home: ctx.home,
                  name: "pi",
                  scope: `${ctx.object.type}:${ctx.object.id}`,
                  key: keepKeyOf({
                    ...stdin,
                    mcpServers: values.input.mcpServers ?? values.flow.mcpServers,
                  }),
                  ...(options.keepMs === undefined ? {} : { timeoutMs: options.keepMs }),
                  ...(options.keptFirstLineMs === undefined ? {} : { firstLineMs: options.keptFirstLineMs }),
                  ...(options.maxKept === undefined ? {} : { max: options.maxKept }),
                }
              : undefined;

          return await runWorkerStep({
            values: runValues,
            access,
            command,
            args: commandArgs,
            stdin,
            keep,
            clock,
            now,
            toolEvent: toolExecutionEvent,
          });
        },
      },
    ],
    flows: [promptFlow],
    async check(ctx) {
      const piCommand = optionalText(ctx.settings.command, "pi: settings.command");
      // The user's own pi, or the one operad installed in the home: found and
      // version-checked, not loaded.
      const pi = findPi(piCommand ?? DEFAULT_PI_COMMAND, { home: ctx.home });
      assertWorkerAvailable({ command: options.command, args: options.args, workerPath: WORKER_PATH });
      return `pi ${pi.version} at ${pi.dir} (floor ${PI_FLOOR}); the worker program is available`;
    },
  });
}

/** The compaction a chat reply asks for (ADR 0023 D12), checked here so a bad value fails the step by name. */
function compactOf(
  value: unknown,
  at: string,
): { at: number; flush?: string; now?: true; only?: true } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${at}: must be an object`);
  const share = value.at;
  if (typeof share !== "number" || !Number.isFinite(share) || share <= 0 || share > 1) {
    throw new Error(`${at}.at: must be a number above 0 and at most 1`);
  }
  const flush = value.flush;
  if (flush !== undefined && typeof flush !== "string") throw new Error(`${at}.flush: must be a string`);
  for (const field of ["now", "only"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") {
      throw new Error(`${at}.${field}: must be a boolean`);
    }
  }
  return {
    at: share,
    ...(flush === undefined || flush.length === 0 ? {} : { flush }),
    ...(value.now === true ? { now: true as const } : {}),
    ...(value.only === true ? { only: true as const } : {}),
  };
}

export default createPiHarnessPlugin();
