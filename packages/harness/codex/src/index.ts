/**
 * The codex harness: one `agent` step that starts the user's own
 * `codex app-server` and speaks its JSON-RPC over stdio (ADR 0022 D3, D8),
 * plus the `codex:prompt` flow. The step has the params, result names and
 * facts of `pi/agent` and `claude/agent`, so a flow changes harness by
 * changing `use`. The client is this package's `AppServerClient`; `runAgent`
 * owns the process, the wall time and the stall limit.
 */

import { messageOf } from "@operad-io/engine";
import pkg from "../package.json" with { type: "json" };
import { liveAccess, readProfile, summarizeCall, type AccessProfile } from "@operad-io/access-match";
import {
  isRecord,
  definePlugin,
  type OutwardWrite,
  type PluginStepResult,
  type StepContext,
} from "@operad-io/engine";
import {
  answerFor,
  askNote,
  askQuestions,
  askedForm,
  isSkipped,
  createCallAsker,
  CONCURRENCY_SETTING,
  createCachedProbe,
  DEFAULT_STALL_SECS,
  DEFAULT_WALL_TIME_SECS,
  deliverLine,
  eventNote,
  flagValue,
  imageInputsOf,
  inboxOf,
  JsonlLog,
  MAX_WALL_TIME_SECS,
  mountedServersOf,
  modelErrorOf,
  modelLimit,
  OPERAD_SERVER,
  operadToolsOf,
  parseStepFlags,
  promptFlowOf,
  promptWithSkills,
  readAgentStep,
  resultFor,
  runAgent,
  skippedLineRecord,
  serverCommand,
  STALL_SETTING,
  STEP_TIMEOUT_SECS,
  stringListParam,
  systemClock,
  text,
  WALL_TIME_SETTING,
  withTimings,
  type AgentWorkerResult,
  type CallAnswer,
  type Clock,
} from "@operad-io/harness-process";
import { decideAccess, type JudgedCall } from "./access.ts";
import {
  AppServerClient,
  personQuestions,
  type AppServerEnd,
  type AppServerError,
  type AppServerMcpServer,
} from "./app-server.ts";
import { CODEX_FLOOR, codexCommand, codexModels, codexSignedIn, commandOf, inspectCodex, refreshCodexModels } from "./install.ts";
import { CodexLog, toolNameOf } from "./log.ts";

export {
  DEFAULT_STALL_SECS,
  DEFAULT_WALL_TIME_SECS,
  MAX_WALL_TIME_SECS,
  STEP_TIMEOUT_SECS,
};

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
    wallTimeSecs: WALL_TIME_SETTING,
    stallSecs: STALL_SETTING,
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
  readonly modelError?: NonNullable<AgentWorkerResult["modelError"]>;
}

/** A model error of one kind, carrying the status and wait its message names. */
function modelErrorFrom(
  kind: string,
  message: string,
): NonNullable<AgentWorkerResult["modelError"]> {
  const byText = modelErrorOf(message);
  return {
    kind,
    status: typeof byText["status"] === "number" ? byText["status"] : null,
    retry_after_secs:
      typeof byText["retry_after_secs"] === "number"
        ? byText["retry_after_secs"]
        : null,
  };
}

/** The model error of an app-server error kind, or undefined when it is not a model error. */
function modelFailure(info: string | undefined, message: string): Failure | undefined {
  if (info === "usageLimitExceeded" || info === "rateLimitExceeded" || info === "contextWindowExceeded" || info === "sessionBudgetExceeded") {
    return { reason: "model_error", message, modelError: modelErrorFrom("usage_limit", message) };
  }
  if (
    info === "serverOverloaded" ||
    info === "modelNotFound" ||
    info === "flexUnavailable" ||
    info === "policyCapacityUnavailable"
  ) {
    return { reason: "model_error", message, modelError: modelErrorFrom("unavailable", message) };
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
        modelError: modelErrorFrom(String(byText["kind"]), message),
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
      modelError: modelErrorFrom(String(byText["kind"]), message),
    };
  }
  return { reason: "stop_reason", message: `Codex stopped the turn: ${end.stopReason}` };
}

/** Creates the codex harness plugin. */
export function createCodexHarnessPlugin(options: CodexHarnessOptions = {}) {
  const clock = options.clock ?? systemClock;
  const now = options.now ?? Date.now;
  // `codex login status` runs a child process, so its answer is kept for a
  // short time and asked without blocking serve. The key is known before the
  // command is found, so a cached answer does no file work.
  const signedInProbe = createCachedProbe<boolean | undefined>({
    now,
    ttlMs: SIGNED_IN_CACHE_MS,
  });

  async function codexSignedInCached(): Promise<boolean | undefined> {
    const key = options.codex?.join("\u0000") ?? `PATH:${process.env.PATH ?? ""}`;
    return await signedInProbe(key, async () => {
      const bun = Bun.which("bun") ?? process.execPath;
      return await codexSignedIn(options.codex ?? codexCommand(bun));
    });
  }

  const promptFlow = promptFlowOf("codex:prompt", "codex/agent");

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
    // A command the owner set, or a replaced codex, is the check's to judge.
    agentMissing: (settings) =>
      options.codex !== undefined ||
      settings.command !== undefined ||
      Bun.which("codex", { PATH: process.env.PATH ?? "" }) !== null
        ? undefined
        : "codex is not on PATH; install Codex, then run `codex login`",
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
          let promptText = "";
          let skills: readonly string[] = [];
          let command: readonly string[] = [];
          let program = "";
          let mcpServers: AppServerMcpServer[] = [];
          let inputEntries: Record<string, unknown>[] = [];

          const step = await readAgentStep(ctx, params, {
            at,
            harness: HARNESS,
            flags: STEP_FLAGS,
            defaultWallTimeSecs: DEFAULT_WALL_TIME_SECS,
            defaultStallSecs: DEFAULT_STALL_SECS,
            maxWallTimeSecs: MAX_WALL_TIME_SECS,
            levelSetting: "effort",
            now,
            refusalExtra: { imageGenCalls: 0 },
            early(input, flow) {
              skills = stringListParam(
                input.skills === undefined ? flow.skills : input.skills,
                `${at}: params.skills`,
              );
            },
            afterDirectory(read) {
              promptText = [promptWithSkills(read.prompt, skills), read.note, read.answerNote]
                .filter((part): part is string => part !== undefined)
                .join("\n\n");

              try {
                command = commandOf(ctx.settings.command);
              } catch (error) {
                return read.refuse("missing", messageOf(error));
              }
              program = command[0] ?? "";

              const operadTools = operadToolsOf(read.input.operadTools ?? read.flow.operadTools);
              const mounted = mountedServersOf(read.input.mcpServers ?? read.flow.mcpServers);
              mcpServers = [];
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
              const images = imageInputsOf(read.input.images ?? read.flow.images);
              inputEntries = [{ type: "text", text: promptText, text_elements: [] }];
              for (const image of images) {
                // Codex reads the file itself; the harness sends the path.
                inputEntries.push({ type: "localImage", path: image.path });
              }
            },
          });
          if ("refused" in step) return step.refused;

          const { values, access } = step;
          const { timings, cwd, resumeSession, wallTimeSecs, stallSecs, model, level: effort } = values;
          const { runAccess, allowAlways, secrets: storeSecrets } = access;
          const read = readProfile(runAccess ?? {});
          const startProfile: AccessProfile = read.ok ? read.profile : {};

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
            profile: startProfile,
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
            async onQuestion(request) {
              // A secret answer would be kept in the pending item and the
              // fact log, so its question is answered empty and never asked.
              const answers: Record<string, readonly string[]> = {};
              for (const question of request.questions) {
                if (question.isSecret === true) answers[question.id] = [];
              }
              const asked = personQuestions(request);
              const questions = askQuestions(
                asked.map((question) => ({
                  id: question.id,
                  text: question.question,
                  ...(question.header === undefined ? {} : { header: question.header }),
                  ...(question.options === undefined ? {} : { choices: question.options }),
                  ...(question.isOther === true ? { freeText: true } : {}),
                })),
              );
              if (questions.length === 0) return answers;
              askId += 1;
              const got = await askedForm(asker, askId, {
                questions,
                session: client?.sessionId ?? null,
              });
              if (got.decision === "stop") {
                // The grace passed: the host ends this program, and the answer
                // comes back to a resumed session as text.
                return answers;
              }
              for (const question of questions) {
                const answer = answerFor(got.answers, question.id);
                answers[question.id] = isSkipped(answer)
                  ? []
                  : [...(answer?.choices ?? []), ...(answer?.text === undefined ? [] : [answer.text])];
              }
              return answers;
            },
            async onPermission(request) {
              const decision = await decideAccess(liveAccess(startProfile), request.method, request.params, request.item, cwd, {
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

          // A message from the host steers the turn. Nothing is handed over
          // before the turn id is known: the inbox keeps it until then, so a
          // failed `turn/start` leaves the message for the next round instead
          // of dropping it.
          const inbox = inboxOf(params);
          let stopInbox: (() => void) | undefined;
          let inboxClosed = false;
          if (inbox !== undefined) {
            inbox.begin?.(wallTimeSecs * 1000);
            void server.turnKnown.then(() => {
              if (inboxClosed || server.finished) return;
              stopInbox = inbox.listen((message) => {
                if (server.finished) return false;
                return server.steer(message);
              });
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
            onSkipped: (chars) => writeLine(skippedLineRecord(chars)),
            onLine(line, reply) {
              server.handleLine(line, reply);
              return writing;
            },
          });
          inboxClosed = true;
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
        throw new Error(messageOf(error));
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
