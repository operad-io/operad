/**
 * The codex harness: one `agent` step that starts the user's `codex-acp` and
 * talks ACP to it (docs/backlog/operad-harness.md decisions 2 and 10), plus the
 * `codex:prompt` flow. The step has the params, result names and facts of
 * `pi/agent` and `claude/agent`, so a flow changes harness by changing `use`.
 * The ACP client is `AcpClient` of `@operad-io/harness-process`; `runAgent`
 * owns the process, the wall time and the stall limit.
 */

import { readProfile, secretValuesOf, summarizeCall, type AccessProfile } from "@operad-io/access-match";
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
  AcpClient,
  accessWithAlwaysAllow,
  alwaysAllowFromGrant,
  appendAlwaysAllow,
  askNote,
  createCallAsker,
  CONCURRENCY_SETTING,
  deliverLine,
  directoryError,
  eventNote,
  flagValue,
  imageInputsOf,
  JsonlLog,
  mountedServersOf,
  modelErrorOf,
  modelLimit,
  OPERAD_SERVER,
  operadToolsOf,
  optionalText,
  parseStepFlags,
  personStarted,
  readAlwaysAllow,
  readImage,
  resultFor,
  runAgent,
  secs,
  serverCommand,
  standardUsage,
  stringListParam,
  systemClock,
  text,
  type AcpEnd,
  type AcpError,
  type AgentWorkerResult,
  type CallAnswer,
  type Clock,
  type UsageSource,
} from "@operad-io/harness-process";
import { decideAccess, type JudgedCall } from "./access.ts";
import { codexCommand, commandOf, inspectCodex } from "./install.ts";
import { CodexLog } from "./log.ts";

/** How long an agent may run before the step stops it. */
export const DEFAULT_WALL_TIME_SECS = 3600;

/**
 * How long an agent may go without a new output line while no tool call is
 * open. An image generation is a tool call that may be silent for minutes; it
 * is not counted here, only against the wall time.
 */
export const DEFAULT_STALL_SECS = 600;

/** One run of the step may take this long; it is above every allowed wall time. */
export const STEP_TIMEOUT_SECS = 8 * 3600;

/** The longest wall time a run may ask for: the step timeout minus a margin. */
export const MAX_WALL_TIME_SECS = STEP_TIMEOUT_SECS - 300;

/** How long codex-acp has to answer `session/cancel` before the step ends it. */
export const CANCEL_GRACE_MS = 10_000;

/** The name the plugin goes by in usage and limit keys. */
const HARNESS = "codex";

/** The reasoning efforts Codex knows; codex-acp refuses one the chosen model does not support. */
export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

/**
 * The codex-acp session mode a run uses. `workspace-write` is Codex's own
 * sandbox with write access to the task's worktree (the session's `cwd`) and
 * no access outside it. Its network is off, but Codex asks before it leaves
 * the sandbox: a command that needs the network arrives as a permission
 * request, and the access profile answers it (a request for the network is
 * allowed once, since the task needs it). The other modes are not used:
 * `read-only` cannot write the worktree, `agent` lets Codex's own reviewer
 * answer instead of the profile, and `agent-full-access` turns the sandbox off.
 */
export const SESSION_MODE = "workspace-write";

/** The models and efforts a chat may pick with this agent: none; codex is a worker, not a chat harness. */
export const CODEX_MODELS = { list: [], default: null } as const;
export const CODEX_EFFORTS = { list: [], default: null, flag: "--effort" } as const;

/** The settings a config.json section may set for this plugin. */
export const PLUGIN_SETTINGS = {
  type: "object" as const,
  properties: {
    model: {
      type: "string" as const,
      minLength: 1,
      description: "The model name codex takes; unset uses Codex's own default.",
    },
    effort: {
      type: "string" as const,
      enum: EFFORT_LEVELS,
      description: "The reasoning effort; unset uses Codex's own default.",
    },
    command: {
      type: "array" as const,
      minItems: 1,
      items: { type: "string" as const, minLength: 1 },
      description:
        "The program and arguments that start codex-acp, such as [\"/opt/homebrew/bin/bun\", \"/Users/me/.bun/bin/codex-acp\"]. Unset runs the bun of PATH on the codex-acp of PATH.",
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

/** The spelling of this harness's step `args`. */
const STEP_FLAGS = { levelFlag: "--effort", levels: EFFORT_LEVELS, modelHint: "<name>" } as const;

/** What a test injects. */
export interface CodexHarnessOptions {
  readonly clock?: Clock | undefined;
  /** Milliseconds now, for tool call start times and durations. */
  readonly now?: (() => number) | undefined;
  /** The Codex command `plugin check` asks about the login; defaults to the `codex` of PATH. */
  readonly codex?: readonly string[] | undefined;
}

/** The codex-acp error info of an error: a string, or the key of an object. */
function errorInfo(error: AcpError): string | undefined {
  const data = error.data;
  if (!isRecord(data)) return undefined;
  const info = data["codexErrorInfo"];
  if (typeof info === "string") return info;
  if (isRecord(info)) return Object.keys(info)[0];
  return undefined;
}

function errorText(error: AcpError): string {
  const data = error.data;
  if (isRecord(data) && typeof data["message"] === "string" && data["message"].length > 0) return data["message"];
  return error.message;
}

/** How one ACP error ends the step: the reason, the message and, for a model that cannot serve, the model error. */
export interface Failure {
  readonly reason: string;
  readonly message: string;
  readonly modelError?: { readonly kind: string };
}

/**
 * Maps an error of codex-acp to the step's failure. An exhausted ChatGPT quota
 * (`usageLimitExceeded`, a rate limit) is `usage_limit` and an unavailable
 * model (a model the session refuses, an overloaded service) is `unavailable`,
 * the model errors dev's `retry_wait` and pool's fallbacks act on.
 */
export function failureOf(end: Extract<AcpEnd, { kind: "error" }>, model: string | undefined): Failure {
  const info = errorInfo(end.error);
  const message = errorText(end.error);
  if (end.error.code === -32000) {
    return { reason: "not_logged_in", message: "Codex is not logged in; run `codex login` first" };
  }
  if (info === "usageLimitExceeded" || info === "rateLimitExceeded") {
    return { reason: "model_error", message, modelError: { kind: "usage_limit" } };
  }
  if (info === "serverOverloaded") {
    return { reason: "model_error", message, modelError: { kind: "unavailable" } };
  }
  if (end.stage === "config") {
    if (end.configId === "model") {
      return {
        reason: "model_error",
        message: `codex-acp does not offer the model ${model ?? "asked for"}: ${message}`,
        modelError: { kind: "unavailable" },
      };
    }
    if (end.configId === "reasoning_effort") {
      return { reason: "invalid_args", message: `codex-acp refused the reasoning effort: ${message}` };
    }
    return { reason: "config", message: `codex-acp refused a session setting (${end.configId ?? "unknown"}): ${message}` };
  }
  if (end.stage === "prompt") {
    const mapped = modelErrorOf(message);
    return {
      reason: "model_error",
      message,
      modelError: { kind: String(mapped["kind"]) },
    };
  }
  if (end.stage === "session" && /resume|load/i.test(message)) {
    return { reason: "session_missing", message };
  }
  return { reason: "protocol", message: `codex-acp failed at ${end.stage}: ${message}` };
}

/** Creates the codex harness plugin. */
export function createCodexHarnessPlugin(options: CodexHarnessOptions = {}) {
  const clock = options.clock ?? systemClock;
  const now = options.now ?? Date.now;

  const promptFlow = defineFlow({
    name: "codex:prompt",
    entry: "agent",
    steps: [
      {
        id: "agent",
        kind: "plugin",
        params: { use: "codex/agent", params: {} },
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
    name: HARNESS,
    kind: "harness",
    version: "0.0.0",
    models: CODEX_MODELS,
    efforts: CODEX_EFFORTS,
    settings: PLUGIN_SETTINGS,
    steps: [
      {
        name: "agent",
        // A question's answer comes back as `resumeSession` and `askAnswer`.
        resumable: true,
        // `waiting`: a question about a call was not answered within the grace.
        results: ["done", "failed", "interrupted", "waiting"],
        // Applied to the calls codex-acp asks permission for. Codex's own
        // sandbox runs the calls inside it without asking; those are bounded
        // by the sandbox, not by these rules.
        enforces: ["denyPaths", "denyCommands", "askCommands", "askPaths", "readPaths", "alwaysAllow"],
        timeoutSecs: STEP_TIMEOUT_SECS,
        // The model the step uses: its `--model` argument, else the setting.
        limit: modelLimit(HARNESS, (params, settings) => {
          const fromArgs = isRecord(params) ? flagValue(params.args, "--model") : undefined;
          const model = fromArgs ?? settings.model;
          return typeof model === "string" && model.length > 0 ? model : undefined;
        }),
        async run(ctx: StepContext, params: unknown): Promise<PluginStepResult> {
          const at = "codex/agent";
          const input = paramsObject(params, at);
          const flow = isRecord(ctx.params) ? ctx.params : {};

          const prompt = text(input.prompt ?? flow.prompt, `${at}: params.prompt`);
          const note = eventNote(ctx.trigger);
          const rawAskAnswer = input.askAnswer ?? flow.askAnswer;
          const promptText = [prompt, note, askNote(rawAskAnswer)]
            .filter((part): part is string => part !== undefined)
            .join("\n\n");
          const cwd = text(input.cwd ?? flow.cwd, `${at}: params.cwd`);
          const rawArgs = input.args === undefined ? flow.args : input.args;
          const flags = parseStepFlags(stringListParam(rawArgs, `${at}: params.args`), STEP_FLAGS);
          const settingModel = typeof ctx.settings.model === "string" ? ctx.settings.model : undefined;
          const knownModel =
            typeof flags === "string" ? (flagValue(rawArgs, "--model") ?? settingModel) : (flags.model ?? settingModel);
          // The cost of a subscription login is unknown, never 0.
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
                imageGenCalls: 0,
              },
            };
          };
          if (typeof flags === "string") return refuse("invalid_args", `${at}: ${flags}`);

          const resumeSession = optionalText(input.resumeSession ?? flow.resumeSession, `${at}: params.resumeSession`);
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

          const cwdProblem = await directoryError(cwd);
          if (cwdProblem !== undefined) return refuse("cwd", cwdProblem);

          let command: readonly string[];
          try {
            command = commandOf(ctx.settings.command);
          } catch (error) {
            return refuse("missing", error instanceof Error ? error.message : String(error));
          }
          const program = command[0] ?? "";

          const operadTools = operadToolsOf(input.operadTools ?? flow.operadTools);
          const mounted = mountedServersOf(input.mcpServers ?? flow.mcpServers);
          const mcpServers: Record<string, unknown>[] = [];
          if (operadTools !== undefined) {
            const server = serverCommand(operadTools);
            mcpServers.push({
              name: OPERAD_SERVER,
              command: server.command,
              args: [...server.args],
              env: [{ name: "OPERAD_HOME", value: operadTools.home }],
            });
          }
          for (const [name, server] of Object.entries(mounted ?? {})) {
            mcpServers.push({ name, command: server.command, args: [...server.args], env: [] });
          }
          const images = imageInputsOf(input.images ?? flow.images);
          const imageBlocks: Record<string, unknown>[] = [];
          for (const image of images) {
            const read = await readImage(image);
            imageBlocks.push({ type: "image", data: read.data, mimeType: read.mediaType });
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
          const read = readProfile(runAccess ?? {});
          const profile: AccessProfile = read.ok ? read.profile : {};

          const started = Date.now();
          const jsonl = new JsonlLog(ctx.logger, clock);
          const stopper = new AbortController();
          const endRun = (): void => stopper.abort();

          const asker = createCallAsker({
            ask: (request) => ctx.ask(request),
            onStop: endRun,
            secrets: storeSecrets,
            ...(allowAlways ? { alwaysAllow: { home: ctx.home, cwd } } : {}),
            onLog: (message) => {
              void ctx.logger.write(message);
            },
          });
          let askId = 0;

          // A full buffer makes the line reader wait for the disk.
          let writing: Promise<void> | undefined;
          const writeLine = (line: string): void => {
            const pending = jsonl.push(line);
            if (pending !== undefined) writing = pending;
            deliverLine(ctx.receiver, line, storeSecrets);
          };
          let client: AcpClient | undefined;
          const log = new CodexLog({
            write: writeLine,
            now,
            cwd,
            profile,
            secrets: storeSecrets,
            active: () => client?.prompting === true,
          });

          const shown = (call: JudgedCall): string =>
            summarizeCall({}, call.tool, call.input, cwd, { secrets: storeSecrets, keepLines: true }) ?? call.tool;

          const ask = (question: {
            readonly kind: "command" | "path";
            readonly value: string;
            readonly tool?: string;
            readonly shown: string;
          }): Promise<CallAnswer> =>
            new Promise<CallAnswer>((resolve) => {
              askId += 1;
              const line = JSON.stringify({
                type: "ask_call",
                id: askId,
                kind: question.kind,
                value: question.value,
                ...(question.tool === undefined ? {} : { tool: question.tool }),
                shown: question.shown,
                session: client?.sessionId ?? null,
              });
              void asker.handle(line, (reply) => {
                try {
                  const ack: unknown = JSON.parse(reply);
                  if (isRecord(ack) && (ack["decision"] === "allow" || ack["decision"] === "deny" || ack["decision"] === "stop")) {
                    resolve({
                      decision: ack["decision"],
                      ...(typeof ack["reason"] === "string" ? { reason: ack["reason"] } : {}),
                    });
                    return;
                  }
                } catch {
                  // fall through to a refusal
                }
                resolve({ decision: "deny", reason: "the question could not be asked" });
              });
            });

          const acp = new AcpClient({
            cwd,
            prompt: [{ type: "text", text: promptText }, ...imageBlocks],
            ...(resumeSession === undefined ? {} : { resumeSession }),
            config: [
              { configId: "mode", value: SESSION_MODE },
              ...(model === undefined ? [] : [{ configId: "model", value: model }]),
              ...(effort === undefined ? [] : [{ configId: "reasoning_effort", value: effort }]),
            ],
            ...(mcpServers.length === 0 ? {} : { mcpServers }),
            clientName: "operad",
            onUpdate: (update) => log.handle(update),
            async onPermission(request) {
              const decision = await decideAccess(profile, request.toolCall, cwd, {
                useGrant: (waitId) => ctx.useGrant(waitId),
                ask,
                shown,
              });
              if (!decision.allow) log.blocked(request.toolCall);
              return decision.allow;
            },
          });
          client = acp;

          const state: { end: AcpEnd | undefined } = { end: undefined };
          void acp.ended.then((value) => {
            state.end = value;
            endRun();
          });

          // A cancel asks codex-acp to stop the prompt and waits for its
          // answer; an agent that does not answer within the grace is ended.
          let graceTimer: unknown;
          const onAbort = (): void => {
            if (acp.finished) return;
            if (!acp.cancel()) {
              endRun();
              return;
            }
            graceTimer = clock.setTimeout(endRun, CANCEL_GRACE_MS);
          };
          if (ctx.signal.aborted) endRun();
          else ctx.signal.addEventListener("abort", onAbort, { once: true });

          const outcome = await runAgent({
            command: program,
            args: command.slice(1),
            cwd,
            stdin: acp.first,
            interactive: true,
            wallMs: wallTimeSecs * 1000,
            stallMs: stallSecs * 1000,
            signal: stopper.signal,
            clock,
            toolEvent: (line) => log.toolEvent(line),
            onLine(line, reply) {
              acp.handleLine(line, reply);
              return writing;
            },
          });
          ctx.signal.removeEventListener("abort", onAbort);
          if (graceTimer !== undefined) clock.clearTimeout(graceTimer);

          // The grace passed with a question open: the program was ended on
          // purpose. The kernel turns this into the result `waiting`, and the
          // answer comes back with the session and a one-time grant.
          const unanswered = asker.stopped();
          if (unanswered !== undefined && !ctx.signal.aborted) {
            await jsonl.end();
            throw unanswered.error;
          }

          const sessionId = acp.sessionId ?? resumeSession ?? null;
          let result: AgentWorkerResult | undefined;
          const end = state.end;
          if (end !== undefined) {
            if (end.kind === "stopped") {
              log.finish(end.stopReason, end.usage);
              const usage = end.usage;
              const counts = {
                input: usage?.inputTokens,
                output: usage?.outputTokens,
                cache_read: usage?.cachedReadTokens ?? undefined,
                cache_write: usage?.cachedWriteTokens ?? undefined,
              };
              const closing = log.finalText.trim().length > 0 ? log.finalText : null;
              const base = { type: "result" as const, sessionId: end.sessionId, usage: counts, cost: null, finalMessage: closing, model: model ?? null };
              if (end.stopReason === "cancelled") result = { ...base, result: "cancelled" };
              else if (end.stopReason === "end_turn") result = { ...base, result: "done" };
              else {
                result = {
                  ...base,
                  result: "failed",
                  reason: end.stopReason === "refusal" ? "refusal" : "stop_reason",
                  message: `codex stopped the prompt: ${end.stopReason}`,
                };
              }
            } else {
              const failed = failureOf(end, model);
              result = {
                type: "result",
                result: "failed",
                sessionId: end.sessionId ?? resumeSession ?? null,
                usage: {},
                cost: null,
                finalMessage: null,
                model: model ?? null,
                reason: failed.reason,
                message: failed.message,
                ...(failed.modelError === undefined ? {} : { modelError: failed.modelError }),
              };
            }
            writeLine(
              JSON.stringify({
                type: "result",
                result: result.result,
                sessionId,
                usage: result.usage,
                cost: null,
                imageGenCalls: log.imageGenerations,
              }),
            );
          }
          await jsonl.end();

          // The run was ended on purpose once codex-acp had answered: the
          // signal that did it is not the agent's.
          const settled =
            end === undefined ? outcome : { ...outcome, exitCode: 0, signal: null, cancelled: false };
          const stepResult = resultFor(
            { harness: HARNESS, model: model ?? null },
            settled,
            result,
            ctx.logger.path,
            Date.now() - started,
            { wallTimeSecs, stallSecs },
            program,
          );
          return {
            ...stepResult,
            data: { ...(stepResult.data ?? {}), imageGenCalls: log.imageGenerations, stopReason: end?.kind === "stopped" ? end.stopReason : null },
          };
        },
      },
    ],
    flows: [promptFlow],
    async check(ctx) {
      let command: readonly string[];
      try {
        command = commandOf(ctx.settings.command);
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
      const bun = Bun.which("bun") ?? process.execPath;
      const codex = options.codex ?? codexCommand(bun);
      const install = inspectCodex(command, codex);
      return (
        `codex-acp ${install.acpVersion} (${command.join(" ")}); ` +
        `codex ${install.codexVersion ?? "not found on PATH"}; ` +
        `login ${install.login ?? "unknown"}`
      );
    },
  });
}

export default createCodexHarnessPlugin();
