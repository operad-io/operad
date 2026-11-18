/**
 * The codex harness: one `agent` step that starts the user's own
 * `codex app-server` and speaks its JSON-RPC over stdio (ADR 0022 D3, D8),
 * plus the `codex:prompt` flow. The step has the params, result names and
 * facts of `pi/agent` and `claude/agent`, so a flow changes harness by
 * changing `use`. The client is this package's `AppServerClient`; `runAgent`
 * owns the process, the wall time and the stall limit.
 */

import pkg from "../package.json" with { type: "json" };
import { readProfile, secretValuesOf, summarizeCall, withDefaultAccess, type AccessProfile } from "@operad-io/access-match";
import {
  isRecord,
  paramsObject,
  defineFlow,
  definePlugin,
  type OutwardWrite,
  type PluginStepResult,
  type StepContext,
} from "@operad-io/engine";
import {
  ALLOW_ALWAYS,
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
  inboxOf,
  JsonlLog,
  mountedServersOf,
  modelErrorOf,
  modelLimit,
  OPERAD_SERVER,
  operadToolsOf,
  optionalText,
  parseStepFlags,
  personStarted,
  promptWithSkills,
  readAlwaysAllow,
  recordTargetGrantFromAnswer,
  resultFor,
  runAgent,
  secs,
  serverCommand,
  standardUsage,
  StepTimings,
  stringListParam,
  systemClock,
  text,
  withTimings,
  type AgentWorkerResult,
  type CallAnswer,
  type Clock,
  type UsageSource,
} from "@operad-io/harness-process";
import { decideAccess, type JudgedCall } from "./access.ts";
import {
  AppServerClient,
  type AppServerEnd,
  type AppServerError,
  type AppServerMcpServer,
} from "./app-server.ts";
import { CODEX_FLOOR, codexCommand, codexModels, codexSignedIn, commandOf, inspectCodex, refreshCodexModels } from "./install.ts";
import { CodexLog, toolNameOf } from "./log.ts";

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

/** How long the answer of `codex login status` is kept before it is asked again. */
export const SIGNED_IN_CACHE_MS = 30_000;

/** How long `codex app-server` has to answer `turn/interrupt` before the step ends it. */
export const CANCEL_GRACE_MS = 10_000;

/** The name the plugin goes by in usage and limit keys. */
const HARNESS = "codex";

/** The reasoning efforts Codex knows; a model the chosen model does not support refuses it. */
export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

/**
 * The sandbox a run uses. `workspace-write` is Codex's own sandbox with write
 * access to the task's worktree (the thread's `cwd`) and no access outside it.
 * Its network is off, but Codex asks before it leaves the sandbox: a command
 * that needs the network arrives as an approval request, and the access
 * profile answers it (a request for the network is allowed once, since the
 * task needs it). `read-only` cannot write the worktree; `danger-full-access`
 * turns the sandbox off.
 */
export const SANDBOX_MODE = "workspace-write";

/**
 * The approval policy that makes Codex ask operad instead of deciding:
 * `on-request` sends a request when Codex wants to leave its sandbox or needs
 * more permission, and `approvalsReviewer: "user"` routes it to this client
 * rather than Codex's own reviewer. `never` would let Codex decide, and `auto_review`
 * would put a subagent in the access profile's place.
 */
export const APPROVAL_POLICY = "on-request";

/** The efforts a chat may pick with this agent: none; Codex's own default is used. */
export const CODEX_EFFORTS = { list: [], default: null, flag: "--effort" } as const;

/** The settings a config.json section may set for this plugin. */
export const PLUGIN_SETTINGS = {
  type: "object" as const,
  properties: {
    model: {
      type: "string" as const,
      title: "Model",
      minLength: 1,
      description: "The model name codex takes; unset uses Codex's own default.",
    },
    effort: {
      type: "string" as const,
      title: "Effort",
      enum: EFFORT_LEVELS,
      description: "The reasoning effort; unset uses Codex's own default.",
    },
    command: {
      type: "array" as const,
      title: "Codex command",
      minItems: 1,
      items: { type: "string" as const, minLength: 1 },
      description:
        "The program and arguments that start codex app-server, such as [\"codex\", \"app-server\"]. Unset finds the codex of PATH and starts its app-server.",
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

/** The Codex error info of an error: a string, or the key of an object. */
function errorInfo(error: AppServerError): string | undefined {
  const data = error.data;
  if (!isRecord(data)) return undefined;
  const info = data["codexErrorInfo"];
  if (typeof info === "string") return info;
  if (isRecord(info)) return Object.keys(info)[0];
  return undefined;
}

function errorText(error: AppServerError): string {
  const data = error.data;
  if (isRecord(data) && typeof data["message"] === "string" && data["message"].length > 0) return data["message"];
  return error.message;
}

/** How one app-server error ends the step: the reason, the message and, for a model that cannot serve, the model error. */
export interface Failure {
  readonly reason: string;
  readonly message: string;
  readonly modelError?: { readonly kind: string };
}

/** The model error of an app-server error kind, or undefined when it is not a model error. */
function modelFailure(info: string | undefined, message: string): Failure | undefined {
  if (info === "usageLimitExceeded" || info === "rateLimitExceeded" || info === "contextWindowExceeded" || info === "sessionBudgetExceeded") {
    return { reason: "model_error", message, modelError: { kind: "usage_limit" } };
  }
  if (
    info === "serverOverloaded" ||
    info === "modelNotFound" ||
    info === "flexUnavailable" ||
    info === "policyCapacityUnavailable"
  ) {
    return { reason: "model_error", message, modelError: { kind: "unavailable" } };
  }
  if (info === "unauthorized") {
    return { reason: "not_logged_in", message: "Codex is not logged in; run `codex login` first" };
  }
  return undefined;
}

/**
 * Maps an app-server failure to the step's failure. An exhausted ChatGPT quota
 * (`usageLimitExceeded`, a rate limit) is `usage_limit` and an unavailable
 * model (a model the server refuses, an overloaded service) is `unavailable`,
 * the model errors dev's `retry_wait` and pool's fallbacks act on.
 */
export function failureOf(end: AppServerEnd, model: string | undefined): Failure {
  if (end.kind === "error") {
    const info = errorInfo(end.error);
    const message = errorText(end.error);
    const mapped = modelFailure(info, message);
    if (mapped !== undefined) {
      if (mapped.reason === "model_error" && end.stage === "session" && model !== undefined) {
        return { ...mapped, message: `Codex does not offer the model ${model}: ${message}` };
      }
      return mapped;
    }
    if (end.stage === "session") {
      if (/resume|thread|session/i.test(message)) return { reason: "session_missing", message };
      return { reason: "protocol", message: `Codex failed to start a thread: ${message}` };
    }
    if (end.stage === "prompt") {
      if (/effort|reasoning/i.test(message)) {
        return { reason: "invalid_args", message: `Codex refused the reasoning effort: ${message}` };
      }
      const byText = modelErrorOf(message);
      return {
        reason: "model_error",
        message,
        modelError: { kind: String(byText["kind"]) },
      };
    }
    return { reason: "protocol", message: `Codex failed at ${end.stage}: ${message}` };
  }
  const error = end.error;
  if (error !== null) {
    const info = errorInfo(error);
    const message = errorText(error);
    const mapped = modelFailure(info, message);
    if (mapped !== undefined) return mapped;
    const byText = modelErrorOf(message);
    return {
      reason: "model_error",
      message,
      modelError: { kind: String(byText["kind"]) },
    };
  }
  return { reason: "stop_reason", message: `Codex stopped the turn: ${end.stopReason}` };
}

/** Creates the codex harness plugin. */
export function createCodexHarnessPlugin(options: CodexHarnessOptions = {}) {
  const clock = options.clock ?? systemClock;
  const now = options.now ?? Date.now;
  // `codex login status` runs a child process, so its answer is kept for a
  // short time and asked without blocking serve.
  const signedInCache = new Map<string, { readonly at: number; readonly value: boolean | undefined }>();

  async function codexSignedInCached(): Promise<boolean | undefined> {
    const bun = Bun.which("bun") ?? process.execPath;
    const codex = options.codex ?? codexCommand(bun);
    const key = codex?.join("\u0000") ?? "";
    const kept = signedInCache.get(key);
    if (kept !== undefined && now() - kept.at < SIGNED_IN_CACHE_MS) return kept.value;
    const value = await codexSignedIn(codex);
    signedInCache.set(key, { at: now(), value });
    return value;
  }

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
    version: pkg.version,
    // The app-server's own model list, kept for a short time; a chat may pick
    // any of them and the step's `--model` still wins.
    models: (settings) => {
      try {
        return codexModels(commandOf(settings.command));
      } catch {
        return { list: [], default: null };
      }
    },
    // A first reply may wait for the one refresh the cache already shares.
    modelsReady: async (settings) => {
      try {
        const command = commandOf(settings.command);
        const kept = codexModels(command);
        return kept.list.length > 0 ? kept : await refreshCodexModels(command);
      } catch {
        return { list: [], default: null };
      }
    },
    efforts: CODEX_EFFORTS,
    capabilities: { takesMessagesMidRun: true },
    signedIn: (_settings: Readonly<Record<string, unknown>>) => codexSignedInCached(),
    settings: PLUGIN_SETTINGS,
    steps: [
      {
        name: "agent",
        // A question's answer comes back as `resumeSession` and `askAnswer`.
        resumable: true,
        // `waiting`: a question about a call was not answered within the grace.
        results: ["done", "failed", "interrupted", "waiting"],
        // Applied to the calls the app-server asks operad about. Codex's own
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
          const timings = new StepTimings(now);
          const input = paramsObject(params, at);
          const flow = isRecord(ctx.params) ? ctx.params : {};

          const prompt = text(input.prompt ?? flow.prompt, `${at}: params.prompt`);
          const skills = stringListParam(
            input.skills === undefined ? flow.skills : input.skills,
            `${at}: params.skills`,
          );
          const note = eventNote(ctx.trigger);
          const rawAskAnswer = input.askAnswer ?? flow.askAnswer;
          const promptText = [promptWithSkills(prompt, skills), note, askNote(rawAskAnswer)]
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
            const timing = timings.finish();
            return withTimings({
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
                durationMs: timing.totalMs,
                stderr: [message],
                imageGenCalls: 0,
              },
            }, timing);
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
          const mcpServers: AppServerMcpServer[] = [];
          if (operadTools !== undefined) {
            const server = serverCommand(operadTools);
            mcpServers.push({
              name: OPERAD_SERVER,
              command: server.command,
              args: [...server.args],
              env: { OPERAD_HOME: operadTools.home },
            });
          }
          for (const [name, server] of Object.entries(mounted ?? {})) {
            mcpServers.push({ name, command: server.command, args: [...server.args] });
          }
          const images = imageInputsOf(input.images ?? flow.images);
          const inputEntries: Record<string, unknown>[] = [
            { type: "text", text: promptText, text_elements: [] },
          ];
          for (const image of images) {
            // Codex reads the file itself; the harness sends the path.
            inputEntries.push({ type: "localImage", path: image.path });
          }

          // A generated step that names no profile still starts from the default.
          const startAccess = withDefaultAccess(ctx.access as AccessProfile | undefined);
          const storeSecrets = await secretValuesOf(ctx.secrets);
          const allowAlways = personStarted(ctx.trigger);
          // A run no person's message started asks about every outward write.
          const access = allowAlways ? startAccess : { ...startAccess, background: true };
          if (allowAlways && isRecord(rawAskAnswer) && rawAskAnswer["choice"] === ALLOW_ALWAYS) {
            const entry = alwaysAllowFromGrant(access, cwd);
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
          if (ctx.flow !== undefined) {
            try {
              await recordTargetGrantFromAnswer(ctx.home, ctx.flow, access, rawAskAnswer, now);
            } catch (error) {
              await ctx.logger.write(
                `the target grant could not be written: ${String(error)}; this call runs once`,
              );
            }
          }
          let runAccess = accessWithAlwaysAllow(access, [], false);
          if (allowAlways) {
            const user = await readAlwaysAllow(ctx.home);
            if (user.problem !== undefined) await ctx.logger.write(user.problem);
            runAccess = accessWithAlwaysAllow(access, user.entries, true);
          }
          const read = readProfile(runAccess ?? {});
          const profile: AccessProfile = read.ok ? read.profile : {};

          const jsonl = new JsonlLog(ctx.logger, clock, now);
          const stopper = new AbortController();
          const endRun = (): void => stopper.abort();

          const asker = createCallAsker({
            ask: (request) => ctx.ask(request),
            onStop: endRun,
            secrets: storeSecrets,
            ...(allowAlways ? { alwaysAllow: { home: ctx.home, cwd } } : {}),
            ...(ctx.flow === undefined ? {} : { targetGrants: { home: ctx.home, flow: ctx.flow } }),
            onLog: (message) => {
              void ctx.logger.write(message);
            },
          });
          let askId = 0;

          // A full buffer makes the line reader wait for the disk.
          let writing: Promise<void> | undefined;
          const writeLine = (line: string): void => {
            const received = jsonl.stamp(line);
            timings.record(received.value, received.at);
            const pending = jsonl.pushStamped(received);
            if (pending !== undefined) writing = pending;
            deliverLine(ctx.receiver, received.text, storeSecrets);
          };
          let client: AppServerClient | undefined;
          const log = new CodexLog({
            write: writeLine,
            now,
            cwd,
            profile,
            secrets: storeSecrets,
            active: () => client?.active === true,
          });

          const shown = (call: JudgedCall): string =>
            summarizeCall({}, call.tool, call.input, cwd, {
              secrets: storeSecrets,
              keepLines: true,
              forQuestion: true,
            }) ?? call.tool;

          const ask = (question: {
            readonly kind: "command" | "path";
            readonly value: string;
            readonly tool?: string;
            readonly outward?: OutwardWrite | undefined;
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
                ...(question.outward === undefined ? {} : { outward: question.outward }),
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

          const server = new AppServerClient({
            cwd,
            prompt: inputEntries,
            ...(resumeSession === undefined ? {} : { resumeSession }),
            ...(model === undefined ? {} : { model }),
            ...(effort === undefined ? {} : { effort }),
            approvalPolicy: APPROVAL_POLICY,
            sandbox: SANDBOX_MODE,
            ...(mcpServers.length === 0 ? {} : { mcpServers }),
            clientName: "operad",
            clientVersion: pkg.version,
            onNotification: (method, params) => log.handle(method, params),
            async onPermission(request) {
              const decision = await decideAccess(profile, request.method, request.params, request.item, cwd, {
                useGrant: (waitId) => ctx.useGrant(waitId),
                ask,
                shown,
              });
              if (!decision.allow) {
                const name =
                  request.item !== undefined
                    ? toolNameOf(request.item)
                    : request.method === "item/fileChange/requestApproval" || request.method === "applyPatchApproval"
                      ? "edit"
                      : "bash";
                log.blocked(request.toolCallId, name);
              }
              return decision.allow;
            },
          });
          client = server;
          // The thread is open and the turn is about to be asked for.
          void server.started.then(() => {
            const opened = server.sessionId;
            if (opened !== null) writeLine(JSON.stringify({ type: "session", sessionId: opened }));
          });

          // A message from the host steers the turn. A message that arrives
          // before the turn is asked for waits for `started`.
          const inbox = inboxOf(params);
          let stopInbox: (() => void) | undefined;
          if (inbox !== undefined) {
            const queued: string[] = [];
            stopInbox = inbox.listen((message) => {
              if (server.finished) return false;
              if (!server.steer(message)) queued.push(message);
              return true;
            });
            inbox.begin?.(wallTimeSecs * 1000);
            void server.started.then(() => {
              for (const message of queued.splice(0)) server.steer(message);
            });
          }

          const state: { end: AppServerEnd | undefined } = { end: undefined };
          void server.ended.then((value) => {
            state.end = value;
            endRun();
          });

          // A cancel asks the app-server to interrupt the turn and waits for
          // its answer; a server that does not answer within the grace is ended.
          let graceTimer: unknown;
          const onAbort = (): void => {
            if (server.finished) return;
            if (!server.cancel()) {
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
            stdin: server.first,
            interactive: true,
            wallMs: wallTimeSecs * 1000,
            stallMs: stallSecs * 1000,
            signal: stopper.signal,
            clock,
            toolEvent: (line) => log.toolEvent(line),
            onLine(line, reply) {
              server.handleLine(line, reply);
              return writing;
            },
          });
          stopInbox?.();
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

          const sessionId = server.sessionId ?? resumeSession ?? null;
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
              const context =
                usage === null || usage === undefined
                  ? undefined
                  : {
                      used:
                        (usage.inputTokens ?? 0) +
                        (usage.cachedReadTokens ?? 0) +
                        (usage.cachedWriteTokens ?? 0),
                      ...(usage.modelContextWindow !== undefined && usage.modelContextWindow > 0
                        ? { window: usage.modelContextWindow }
                        : {}),
                    };
              const base = {
                type: "result" as const,
                sessionId: end.sessionId.length > 0 ? end.sessionId : sessionId,
                usage: counts,
                cost: null,
                finalMessage: closing,
                model: model ?? null,
                ...(context === undefined ? {} : { context }),
              };
              if (end.stopReason === "interrupted") {
                result = { ...base, result: "cancelled" };
              } else if (end.stopReason === "completed") {
                result = { ...base, result: "done" };
              } else {
                const failed = failureOf(end, model);
                result = {
                  ...base,
                  result: "failed",
                  finalMessage: null,
                  reason: failed.reason,
                  message: failed.message,
                  ...(failed.modelError === undefined ? {} : { modelError: failed.modelError }),
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
                ...(result.context === undefined ? {} : { context: result.context }),
                imageGenCalls: log.imageGenerations,
              }),
            );
          }
          await jsonl.end();

          // The run was ended on purpose once the app-server had answered: the
          // signal that did it is not the agent's.
          const settled =
            end === undefined ? outcome : { ...outcome, exitCode: 0, signal: null, cancelled: false };
          const timing = timings.finish();
          const stepResult = resultFor(
            { harness: HARNESS, model: model ?? null },
            settled,
            result,
            ctx.logger.path,
            timing.totalMs,
            { wallTimeSecs, stallSecs },
            program,
          );
          return withTimings({
            ...stepResult,
            data: { ...(stepResult.data ?? {}), imageGenCalls: log.imageGenerations, stopReason: end?.kind === "stopped" ? end.stopReason : null },
          }, timing);
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
        `codex ${install.codexVersion ?? "not found on PATH"} (${command.join(" ")}; ` +
        `app-server, built against ${CODEX_FLOOR}); login ${install.login ?? "unknown"}`
      );
    },
  });
}

export default createCodexHarnessPlugin();
