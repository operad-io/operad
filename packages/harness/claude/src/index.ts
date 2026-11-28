/**
 * The claude harness, hub side: one `agent` step that starts the child program
 * `worker.ts` under Bun, writes one JSON object to its stdin and reads the last
 * `result` line of its stdout, plus the `claude:prompt` flow. The step
 * has the params, result names and facts of `pi/agent`, so a flow
 * changes harness by changing `use`. The Agent SDK is imported only by the
 * child program, never by the hub.
 */

import pkg from "../package.json" with { type: "json" };
import { fileURLToPath } from "node:url";
import {
  isRecord,
  definePlugin,
  type HarnessEfforts,
  type PluginStepResult,
  type StepContext,
} from "@operad-io/engine";
import {
  assertWorkerAvailable,
  CONCURRENCY_SETTING,
  createCachedProbe,
  DEFAULT_STALL_SECS,
  DEFAULT_WALL_TIME_SECS,
  flagValue,
  imageInputsOf,
  keepKeyOf,
  MAX_WALL_TIME_SECS,
  modelLimit,
  mountedServersOf,
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
  shellWord,
} from "@operad-io/harness-process";
import { CLAUDE_FLOOR, DEFAULT_CLAUDE_COMMAND, claudeSignedIn, inspectClaude, sdkVersion } from "./claude-install.ts";
import { DEFAULT_BASH_TIMEOUT_SECS, CLAUDE_CONTEXT_WINDOWS, EFFORT_LEVELS } from "./protocol.ts";

export {
  DEFAULT_STALL_SECS,
  DEFAULT_WALL_TIME_SECS,
  MAX_WALL_TIME_SECS,
  STEP_TIMEOUT_SECS,
};

/** The tool call one claude line starts or settles, or undefined for another line. */
export { toolExecutionEvent as claudeToolEvent } from "@operad-io/harness-process";

/** How long the answer of `claude auth status` is kept before it is asked again. */
export const SIGNED_IN_CACHE_MS = 30_000;

const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));

/** The name the plugin goes by in usage and limit keys. */
const HARNESS = "claude";

/** What a test injects: the clock and the program the step starts. */
export interface ClaudeHarnessOptions {
  readonly clock?: Clock | undefined;
  /** The executable; defaults to the running Bun. */
  readonly command?: string | undefined;
  /** The arguments before the worker input; defaults to `worker.ts`. */
  readonly args?: readonly string[] | undefined;
  /** The time now in milliseconds; defaults to `Date.now`. It ages the login cache. */
  readonly now?: (() => number) | undefined;
  /** Test seam: how long a chat's worker is kept after a reply. */
  readonly keepMs?: number | undefined;
  /** Test seam: how long a kept worker may take to answer its first line. */
  readonly keptFirstLineMs?: number | undefined;
  /** Test seam: how many workers one home keeps. */
  readonly maxKept?: number | undefined;
}

/** What each model claude lists can do, as far as claude's own interface says. */
const CLAUDE_MODEL_INFO = {
  opus: {
    id: "opus",
    provider: "anthropic",
    window: CLAUDE_CONTEXT_WINDOWS["opus"],
    capabilities: ["vision", "reasoning", "tools"],
  },
  sonnet: {
    id: "sonnet",
    provider: "anthropic",
    window: CLAUDE_CONTEXT_WINDOWS["sonnet"],
    capabilities: ["vision", "reasoning", "tools"],
  },
  haiku: {
    id: "haiku",
    provider: "anthropic",
    window: CLAUDE_CONTEXT_WINDOWS["haiku"],
    capabilities: ["vision", "reasoning", "tools"],
  },
  "opus[1m]": {
    id: "opus[1m]",
    provider: "anthropic",
    window: CLAUDE_CONTEXT_WINDOWS["opus[1m]"],
    capabilities: ["vision", "reasoning", "tools"],
  },
  "sonnet[1m]": {
    id: "sonnet[1m]",
    provider: "anthropic",
    window: CLAUDE_CONTEXT_WINDOWS["sonnet[1m]"],
    capabilities: ["vision", "reasoning", "tools"],
  },
} as const;

/** The models a chat may pick with this agent, the one used when none is set, and what each is. */
export const CLAUDE_MODELS = {
  list: ["opus", "sonnet", "haiku", "opus[1m]", "sonnet[1m]"],
  default: "sonnet",
  windows: CLAUDE_CONTEXT_WINDOWS,
  info: CLAUDE_MODEL_INFO,
} as const;

function claudeEfforts(settings: Readonly<Record<string, unknown>>): HarnessEfforts {
  const configured = EFFORT_LEVELS.find((level) => level === settings.effort) ?? null;
  return { list: EFFORT_LEVELS, default: configured, flag: "--effort" };
}

/** The settings a config.json section may set for this plugin. */
export const PLUGIN_SETTINGS = {
  type: "object" as const,
  properties: {
    model: {
      type: "string" as const,
      title: "Model",
      minLength: 1,
      description: "The model name claude takes (such as opus or sonnet); unset uses claude's default.",
    },
    effort: {
      type: "string" as const,
      title: "Effort",
      enum: EFFORT_LEVELS,
      description: "The reasoning effort; unset uses claude's default.",
    },
    command: {
      type: "string" as const,
      title: "Claude command",
      minLength: 1,
      default: DEFAULT_CLAUDE_COMMAND,
      description: "The claude command: a name on PATH or a path.",
    },
    maxTurns: {
      type: "integer" as const,
      title: "Turn limit",
      minimum: 1,
      description: "The most turns one run may take; unset means no limit.",
    },
    budgetUsd: {
      type: "number" as const,
      title: "Spending limit",
      minimum: 0.01,
      description: "The most one run may spend, in US dollars; unset means no limit. For API-key logins.",
    },
    bashTimeoutSecs: {
      type: "integer" as const,
      title: "Bash timeout",
      minimum: 1,
      default: DEFAULT_BASH_TIMEOUT_SECS,
      description:
        "The longest one Bash call may run, in seconds. Nothing runs in the background, so a long gate runs in the foreground within this time.",
    },
    wallTimeSecs: WALL_TIME_SETTING,
    stallSecs: STALL_SETTING,
    concurrency: CONCURRENCY_SETTING,
  },
  additionalProperties: false as const,
};

/** The spelling of this harness's step `args`. */
const STEP_FLAGS = { levelFlag: "--effort", levels: EFFORT_LEVELS, modelHint: "<name>" } as const;

/** The `SKILL.md` a bot follows to set this agent up (ADR 0010 D7). */
const SETUP_GUIDE = fileURLToPath(new URL("../skills/setup/SKILL.md", import.meta.url));

/**
 * Creates the claude harness plugin. Its worker is `worker.ts` under the
 * running Bun; a test replaces the program with a fake that prints fixed lines.
 */
export function createClaudeHarnessPlugin(options: ClaudeHarnessOptions = {}) {
  const clock = options.clock ?? systemClock;
  const command = options.command ?? process.execPath;
  const commandArgs = options.args ?? [WORKER_PATH];
  const now = options.now ?? Date.now;
  // `claude auth status` runs a child process, so its answer is kept for a
  // short time and asked without blocking serve. A failed answer is kept too,
  // so a missing claude is not spawned for on every list.
  const signedInProbe = createCachedProbe<boolean | undefined>({
    now,
    ttlMs: SIGNED_IN_CACHE_MS,
  });

  async function claudeSignedInCached(settings: Readonly<Record<string, unknown>>): Promise<boolean | undefined> {
    const commandSetting = typeof settings.command === "string" ? settings.command : undefined;
    const key = commandSetting ?? "";
    // Two clients asking at once share one probe, so serve starts one claude.
    return await signedInProbe(key, () => claudeSignedIn(commandSetting));
  }

  const promptFlow = promptFlowOf("claude:prompt", "claude/agent");

  return definePlugin({
    name: HARNESS,
    kind: "harness",
    version: pkg.version,
    models: CLAUDE_MODELS,
    efforts: claudeEfforts,
    capabilities: { backgroundModel: "haiku", loadsSkills: true, takesMessagesMidRun: true, accessLevels: ["plan", "ask", "edits", "full"] },
    signedIn: (settings) => claudeSignedInCached(settings),
    // A command the owner set, or a replaced worker, is the check's to judge.
    agentMissing: (settings) =>
      options.command !== undefined ||
      (settings.command !== undefined && settings.command !== DEFAULT_CLAUDE_COMMAND) ||
      Bun.which(DEFAULT_CLAUDE_COMMAND, { PATH: process.env.PATH ?? "" }) !== null
        ? undefined
        : "claude is not on PATH; install Claude Code, then run `claude auth login`",
    interactiveCommand: (settings) =>
      typeof settings.command === "string" && settings.command !== "" ? shellWord(settings.command) : undefined,
    // Setup Claude (ADR 0022 D14): the guide a bot follows for what the check reports missing.
    guide: SETUP_GUIDE,
    settings: PLUGIN_SETTINGS,
    steps: [
      {
        name: "agent",
        // A question's answer comes back as `resumeSession` and `askAnswer`.
        resumable: true,
        // `waiting`: a question about a call was not answered within the grace.
        results: ["done", "failed", "interrupted", "waiting"],
        // The deny and ask fields are applied in the worker's canUseTool.
        enforces: ["level", "denyPaths", "denyCommands", "askCommands", "askPaths", "readPaths", "alwaysAllow"],
        timeoutSecs: STEP_TIMEOUT_SECS,
        // The model the step uses: its `--model` argument, else the setting.
        limit: modelLimit(HARNESS, (params, settings) => {
          const fromArgs = isRecord(params) ? flagValue(params.args, "--model") : undefined;
          const model = fromArgs ?? settings.model;
          return typeof model === "string" && model.length > 0 ? model : undefined;
        }),
        async run(ctx: StepContext, params: unknown): Promise<PluginStepResult> {
          const at = "claude/agent";
          let maxTurns: number | undefined;
          let budgetUsd: number | undefined;
          let bashTimeoutSecs: number | undefined;
          let operadTools: ReturnType<typeof operadToolsOf>;
          let skills: readonly string[] = [];
          let ownSettings: unknown;
          let mcpServers: ReturnType<typeof mountedServersOf>;
          let images: readonly ReturnType<typeof imageInputsOf>[number][] = [];
          let claudeCommand: string | undefined;

          const step = await readAgentStep(ctx, params, {
            at,
            harness: HARNESS,
            flags: STEP_FLAGS,
            defaultWallTimeSecs: DEFAULT_WALL_TIME_SECS,
            defaultStallSecs: DEFAULT_STALL_SECS,
            maxWallTimeSecs: MAX_WALL_TIME_SECS,
            levelSetting: "effort",
            now,
            beforeDirectory() {
              maxTurns = optionalPositive(ctx.settings.maxTurns, `${at}: settings.maxTurns`, true);
              budgetUsd = optionalPositive(ctx.settings.budgetUsd, `${at}: settings.budgetUsd`, false);
              bashTimeoutSecs = optionalPositive(
                ctx.settings.bashTimeoutSecs,
                `${at}: settings.bashTimeoutSecs`,
                true,
              );
            },
            afterDirectory(read) {
              operadTools = operadToolsOf(read.input.operadTools ?? read.flow.operadTools);
              skills = stringListParam(
                read.input.skills === undefined ? read.flow.skills : read.input.skills,
                `${at}: params.skills`,
              );
              ownSettings = read.input.useOwnSettings ?? read.flow.useOwnSettings;
              if (ownSettings !== undefined && typeof ownSettings !== "boolean") {
                throw new Error(`${at}: params.useOwnSettings: must be a boolean`);
              }
              mcpServers = mountedServersOf(read.input.mcpServers ?? read.flow.mcpServers);
              images = imageInputsOf(read.input.images ?? read.flow.images);
              claudeCommand = optionalText(ctx.settings.command, `${at}: settings.command`);
            },
          });
          if ("refused" in step) return step.refused;

          const { values, access } = step;
          const { resumeSession, wallTimeSecs, stallSecs, model, level: effort } = values;

          const stdin: Record<string, unknown> = {
            prompt: values.promptWithNote,
            cwd: values.cwd,
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
            ...(skills.length === 0 ? {} : { skills }),
            ...(ownSettings === true ? { useOwnSettings: true } : {}),
            ...(access.runAccess === undefined ? {} : { access: access.runAccess }),
            ...(access.secrets.length === 0 ? {} : { secretValues: access.secrets }),
          };

          const keep: KeptRunOptions | undefined =
            values.input.keepWorker === true && ctx.object !== undefined
              ? {
                  home: ctx.home,
                  name: HARNESS,
                  scope: `${ctx.object.type}:${ctx.object.id}`,
                  key: keepKeyOf(stdin),
                  ...(options.keepMs === undefined ? {} : { timeoutMs: options.keepMs }),
                  ...(options.keptFirstLineMs === undefined ? {} : { firstLineMs: options.keptFirstLineMs }),
                  ...(options.maxKept === undefined ? {} : { max: options.maxKept }),
                }
              : undefined;

          return await runWorkerStep({
            values,
            access,
            command,
            args: commandArgs,
            stdin,
            keep,
            clock,
            now,
            toolEvent: toolExecutionEvent,
            forms: true,
            modelFromResult: true,
          });
        },
      },
    ],
    flows: [promptFlow],
    async check(ctx) {
      const claudeCommand = optionalText(ctx.settings.command, `${HARNESS}: settings.command`);
      // The user's own claude: found, version-checked and asked who is logged
      // in. Only the login kind is reported.
      const claude = inspectClaude(claudeCommand);
      assertWorkerAvailable({ command: options.command, args: options.args, workerPath: WORKER_PATH });
      const sdk = await sdkVersion();
      return (
        `claude ${claude.version} at ${claude.path} (floor ${CLAUDE_FLOOR}); ` +
        `agent sdk ${sdk ?? "unknown"}; login ${claude.login}; the worker program is available`
      );
    },
  });
}

export default createClaudeHarnessPlugin();
