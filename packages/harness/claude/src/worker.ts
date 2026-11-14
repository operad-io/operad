/**
 * The claude child program (ADR 0024 D2 to D8).
 *
 * Reads one JSON object from stdin, runs one prompt through the Agent SDK
 * (which starts the user's own `claude`) and writes one JSON object per line
 * to stdout, the last a Result. `README.md` holds the tables.
 */

import {
  query,
  type CanUseTool,
  type HookCallback,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  firstErrorLine,
  match,
  messageSummary,
  readProfile,
  REFUSED_IN_LOG,
  summarizeCall,
  type AccessProfile,
} from "@operad-io/access-match";
import { decideAccess, hasRules, translate, type CallAnswer } from "./access.ts";
import {
  maskSecrets,
  messageText,
  OPERAD_SERVER,
  readImage,
  serverCommand,
  toolOutputLines,
} from "@operad-io/harness-process";
import { findClaude } from "./claude-install.ts";
import {
  DEFAULT_BASH_TIMEOUT_SECS,
  parseInput,
  type CostQuality,
  type FailureReason,
  type WorkerInput,
  type WorkerLine,
  type WorkerModelError,
  type WorkerResult,
  type WorkerUsage,
} from "./protocol.ts";

export const EXIT_FAILED = 1;
export const EXIT_INVALID_INPUT = 2;
export const EXIT_CANCELLED = 143;

/** The shortest time between two increment lines of one stream, in milliseconds. */
export const STREAM_GROUP_MS = 100;

type StreamKind = "text" | "thinking";

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The length of the longest suffix of `text` that is a proper prefix of a
 * secret. A delta line may not end in such a suffix: the next line would
 * complete the secret, and masking each line alone would leave both parts
 * readable when a live reader joins them.
 */
function secretPrefixLength(text: string, secrets: readonly string[]): number {
  let held = 0;
  for (const secret of secrets) {
    const longest = Math.min(secret.length - 1, text.length);
    for (let length = longest; length > held; length -= 1) {
      if (text.endsWith(secret.slice(0, length))) {
        held = length;
        break;
      }
    }
  }
  return held;
}

/**
 * The text a tool printed, from the shapes claude's tools return: a string, a
 * text block, Bash's stdout and stderr, a file's content, or a list of names.
 * Undefined when the response holds no output; the program never invents one.
 */
export function toolOutputText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => toolOutputText(part))
      .filter((part): part is string => part !== undefined && part.length > 0);
    return parts.length === 0 ? undefined : parts.join("\n");
  }
  const record = recordOf(value);
  if (record === undefined) return undefined;
  const stdout = stringOf(record["stdout"]);
  const stderr = stringOf(record["stderr"]);
  if (stdout !== undefined || stderr !== undefined) {
    const parts = [stdout ?? "", stderr ?? ""].filter((part) => part.length > 0);
    return parts.length === 0 ? undefined : parts.join("\n");
  }
  for (const key of ["content", "output", "text", "message"]) {
    const text = toolOutputText(record[key]);
    if (text !== undefined) return text;
  }
  const file = recordOf(record["file"]);
  const content = file === undefined ? undefined : stringOf(file["content"]);
  if (content !== undefined) return content;
  const names = record["filenames"];
  if (Array.isArray(names)) {
    const text = names.filter((name): name is string => typeof name === "string").join("\n");
    if (text.length > 0) return text;
  }
  return undefined;
}

/**
 * What the program sets for the `claude` it starts, so that it does not
 * remember, read project instruction files, report or phone home on its own.
 * `docs/research/2026-11-07-claude-isolation-env.md` lists which names the
 * installed Claude Code reads.
 */
export const ISOLATION_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  // A run is one foreground turn: nothing may move to the background, where
  // the turn would end and claude would go on by itself later.
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
};

/**
 * Tools that only schedule or wait for work outside the turn. They are off, so
 * the model cannot end its turn waiting for something that would continue it.
 * Names are those of `BUILTIN_TOOL_NAMES` in the SDK (0.3.319).
 */
export const DISALLOWED_TOOLS: readonly string[] = [
  "Monitor",
  "ScheduleWakeup",
  "CronCreate",
  "CronDelete",
  "CronList",
  "TaskStop",
];

/** Where the program writes. Lines are written whole, in order. */
export interface WorkerIo {
  line(line: WorkerLine): void;
  /** Free text for humans; never parsed. */
  log(text: string): void;
  /**
   * Asks the host to use up a one-time permission. True when it did and the
   * call may run. Absent when the host cannot answer; no grant then applies.
   */
  useGrant?(waitId: string): Promise<boolean>;
  /**
   * Asks the host to ask a person whether one call may run, and resolves with
   * the answer. Absent when the host cannot answer; a call that must ask is then
   * refused.
   */
  ask?(call: {
    readonly kind: "command" | "path";
    readonly value: string;
    readonly tool?: string;
    readonly shown: string;
    readonly session: string | null;
  }): Promise<CallAnswer>;
  /**
   * Hands each message the host sends mid-run to `handler`, those that came
   * before the call first. Absent when the host cannot send any.
   */
  onMessage?(handler: (text: string) => void): void;
}

export interface WorkerHooks {
  /** Replaces the process the SDK starts; the tests use it for a fake `claude`. */
  spawnClaudeCodeProcess?: Options["spawnClaudeCodeProcess"];
  /** The clock for tool call times, in epoch milliseconds; the tests inject one. */
  now?: () => number;
  /** The environment the started `claude` inherits; the process's own when absent. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Where the program talks to the world; the process entry points them at stdout and stderr. */
export interface WorkerPorts {
  write(text: string): void;
  log(text: string): void;
}

function failure(reason: FailureReason, message: string): WorkerResult {
  return {
    type: "result",
    result: "failed",
    sessionId: null,
    usage: {},
    cost: null,
    finalMessage: null,
    model: null,
    reason,
    message,
  };
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageOf(value: unknown): Required<WorkerUsage> {
  const read = (key: string): number =>
    typeof value === "object" && value !== null ? finite(Reflect.get(value, key)) : 0;
  return {
    input: read("input_tokens"),
    output: read("output_tokens"),
    cache_read: read("cache_read_input_tokens"),
    cache_write: read("cache_creation_input_tokens"),
  };
}

function isSessionMissing(text: string): boolean {
  return /no conversation found/i.test(text);
}

/**
 * Runs one prompt and returns the exit code. `cancel` is the SIGTERM signal;
 * the Result is written before the code is returned.
 */
export async function runWorker(
  input: WorkerInput,
  io: WorkerIo,
  cancel: AbortSignal,
  hooks: WorkerHooks = {},
): Promise<number> {
  let executable = "claude";
  if (hooks.spawnClaudeCodeProcess === undefined) {
    try {
      executable = findClaude(input.command);
    } catch (error) {
      io.line(failure("model_error", error instanceof Error ? error.message : String(error)));
      return EXIT_FAILED;
    }
  }

  const controller = new AbortController();
  let cancelled = cancel.aborted;
  const onCancel = (): void => {
    cancelled = true;
    controller.abort();
  };
  if (cancelled) controller.abort();
  cancel.addEventListener("abort", onCancel, { once: true });

  // The profile was checked when the input was read; a bad one never gets here.
  const read = readProfile(input.access ?? {});
  const profile: AccessProfile = read.ok ? read.profile : {};
  const now = hooks.now ?? Date.now;
  const secrets = input.secretValues ?? [];

  // Increments are grouped: one line per stream at most every 100 ms, with the
  // part still open written before the next line of any kind.
  let deltaKind: StreamKind | undefined;
  let deltaText = "";
  let deltaAt = 0;
  // `complete` says this stream has ended: a held suffix cannot be completed
  // by a later group, so it is the last increment (masked if it is a whole
  // secret). Otherwise a suffix that is a proper secret prefix stays back, so
  // joining two increment lines can never form a secret.
  const flushDelta = (complete: boolean): void => {
    if (deltaKind === undefined || deltaText.length === 0) {
      deltaKind = undefined;
      deltaText = "";
      return;
    }
    const kind = deltaKind;
    let text: string;
    if (complete) {
      text = deltaText;
      deltaText = "";
      deltaKind = undefined;
    } else {
      const held = secretPrefixLength(deltaText, secrets);
      text = held === 0 ? deltaText : deltaText.slice(0, -held);
      deltaText = held === 0 ? "" : deltaText.slice(-held);
      deltaKind = deltaText.length === 0 ? undefined : kind;
    }
    if (text.length > 0) {
      io.line({ type: kind === "text" ? "text_delta" : "thinking_delta", text: maskSecrets(text, secrets) });
    }
  };
  const writeLine = (line: WorkerLine): void => {
    flushDelta(false);
    io.line(line);
  };
  const addDelta = (kind: StreamKind, text: string): void => {
    if (text.length === 0) return;
    const at = now();
    if (deltaKind === kind && at - deltaAt < STREAM_GROUP_MS) {
      deltaText += text;
      return;
    }
    // A different kind ends the previous stream; the same kind just starts a
    // new group after its open part has been written.
    flushDelta(deltaKind !== kind);
    deltaKind = kind;
    deltaText += text;
    deltaAt = at;
  };

  // The blocks of the response being streamed, by their index. A block's end
  // line is written from the finished assistant message, which carries the
  // whole text even when the stream gave only a summary.
  const streamBlocks = new Map<number, { readonly kind: StreamKind; text: string }>();
  const streamEvent = (value: unknown): void => {
    const event = recordOf(value);
    if (event === undefined) return;
    const type = stringOf(event["type"]);
    if (type === "content_block_start") {
      const index = numberOf(event["index"]);
      const block = recordOf(event["content_block"]);
      if (index === undefined || block === undefined) return;
      const blockType = stringOf(block["type"]);
      if (blockType === "text") {
        const text = stringOf(block["text"]) ?? "";
        streamBlocks.set(index, { kind: "text", text });
        addDelta("text", text);
      } else if (blockType === "thinking") {
        const text = stringOf(block["thinking"]) ?? "";
        streamBlocks.set(index, { kind: "thinking", text });
        addDelta("thinking", text);
      }
    } else if (type === "content_block_delta") {
      const index = numberOf(event["index"]);
      const block = index === undefined ? undefined : streamBlocks.get(index);
      const delta = recordOf(event["delta"]);
      if (block === undefined || delta === undefined) return;
      const deltaType = stringOf(delta["type"]);
      if (block.kind === "text" && deltaType === "text_delta") {
        const text = stringOf(delta["text"]);
        if (text !== undefined) {
          block.text += text;
          addDelta("text", text);
        }
      } else if (block.kind === "thinking" && deltaType === "thinking_delta") {
        const text = stringOf(delta["thinking"]);
        if (text !== undefined) {
          block.text += text;
          addDelta("thinking", text);
        }
      }
    } else if (type === "content_block_stop") {
      const index = numberOf(event["index"]);
      if (index !== undefined && streamBlocks.delete(index)) flushDelta(true);
    }
  };
  const writeEnd = (kind: StreamKind, text: string): void => {
    if (text.length === 0) return;
    io.line({ type: kind === "text" ? "text_end" : "thinking_end", text: maskSecrets(text, secrets) });
  };

  // Tool calls that have started and not ended; a refused call ends here too,
  // so the host never sees a call stay open.
  const open = new Map<string, { readonly name: string; readonly startedAt: number }>();
  // The same translation `decideAccess` uses, so a tool the summary does not
  // know by name (NotebookEdit, MultiEdit) is still judged as its access-match tool.
  const deniedByProfile = (name: string, toolInput: unknown): { readonly rule?: string } | undefined => {
    const record = typeof toolInput === "object" && toolInput !== null ? (toolInput as Record<string, unknown>) : {};
    const translated = translate(name, record);
    if (translated.kind === "inert") return undefined;
    if (translated.kind === "mapped") {
      const verdict = match(profile, { tool: translated.tool, input: translated.input, cwd: input.cwd });
      // A call that asks is not refused: it is shown as itself.
      if (verdict.allow || verdict.ask === true) return undefined;
      return verdict.rule === undefined ? {} : { rule: verdict.rule };
    }
    return hasRules(profile) ? {} : undefined;
  };
  const startCall = (id: string, name: string, toolInput: unknown): void => {
    if (open.has(id)) return;
    const startedAt = now();
    open.set(id, { name, startedAt });
    const denied = deniedByProfile(name, toolInput);
    const summary = denied !== undefined
      ? `${name} denied by the access profile${denied.rule === undefined ? "" : ` (rule: ${denied.rule.replace(/\s+/g, " ").slice(0, 300)})`}`
      : summarizeCall(profile, name, toolInput, input.cwd, { secrets: input.secretValues, keepLines: true });
    writeLine({
      type: "tool_execution_start",
      toolCallId: id,
      toolName: name,
      at: startedAt,
      ...(summary === undefined ? {} : { input: summary }),
    });
  };
  const endCall = (id: string, name: string, isError: boolean, error?: unknown, output?: unknown): void => {
    const call = open.get(id);
    if (call === undefined) return;
    open.delete(id);
    const text = isError ? undefined : toolOutputText(output);
    if (text !== undefined && text.length > 0) {
      for (const part of toolOutputLines(text, secrets)) {
        writeLine({ type: "tool_output", toolCallId: id, text: part.text });
      }
    }
    const firstLine = isError ? firstErrorLine(error, { secrets: input.secretValues }) : undefined;
    writeLine({
      type: "tool_execution_end",
      toolCallId: id,
      toolName: name,
      isError,
      durationMs: Math.max(0, now() - call.startedAt),
      ...(firstLine === undefined ? {} : { error: firstLine }),
    });
  };
  const toolHook =
    (kind: "start" | "end" | "failed"): HookCallback =>
    async (event) => {
      if (event.hook_event_name === "PreToolUse" && kind === "start") {
        startCall(event.tool_use_id, event.tool_name, event.tool_input);
      } else if (event.hook_event_name === "PostToolUse" && kind === "end") {
        endCall(event.tool_use_id, event.tool_name, false, undefined, event.tool_response);
      } else if (event.hook_event_name === "PostToolUseFailure" && kind === "failed") {
        endCall(event.tool_use_id, event.tool_name, true, event.error);
      }
      return {};
    };

  // The only permission surface (`permissionMode: 'default'` sends every call
  // that is not already allowed here). A refusal goes to the model as the
  // tool's result and the run goes on; the call is closed for the host.
  const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
    io.log(`canUseTool ${toolName}`);
    const askHost = io.ask;
    const verdict = await decideAccess(
      profile,
      toolName,
      toolInput,
      input.cwd,
      io.useGrant,
      askHost === undefined
        ? undefined
        : async (question) => {
            // A value that holds a secret is never asked about: no fact may hold it.
            if ((input.secretValues ?? []).some((secret) => secret.length > 0 && question.value.includes(secret))) {
              return { decision: "deny", reason: "the call holds a secret value, so nobody is asked about it" };
            }
            const shown = summarizeCall(profile, toolName, toolInput, input.cwd, { secrets: input.secretValues });
            return askHost({ ...question, shown: shown ?? question.value, session: sessionId });
          },
    );
    if (verdict.allow) return { behavior: "allow", updatedInput: toolInput };
    if (verdict.stop === true) {
      // The wait ended: the host ends this program next. Hold the call until it does.
      await new Promise<void>((resolve) => {
        if (controller.signal.aborted) resolve();
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      endCall(options.toolUseID, toolName, true, REFUSED_IN_LOG);
      return { behavior: "deny", message: verdict.reason, interrupt: true };
    }
    writeLine({ type: "blocked", toolName, reason: REFUSED_IN_LOG });
    endCall(options.toolUseID, toolName, true, REFUSED_IN_LOG);
    return { behavior: "deny", message: verdict.reason };
  };

  // Operad's tools: the program that serves them on stdio, started by claude.
  const operadServer =
    input.operadTools === undefined
      ? undefined
      : {
          type: "stdio" as const,
          command: serverCommand(input.operadTools).command,
          args: [...serverCommand(input.operadTools).args],
          env: { OPERAD_HOME: input.operadTools.home },
        };
  const stderrTail: string[] = [];
  const options: Options = {
    cwd: input.cwd,
    pathToClaudeCodeExecutable: executable,
    settingSources: [],
    permissionMode: "default",
    permissionPrompts: "host",
    includePartialMessages: true,
    systemPrompt: { type: "preset", preset: "claude_code" },
    canUseTool,
    abortController: controller,
    disallowedTools: [...DISALLOWED_TOOLS],
    env: {
      ...(hooks.env ?? process.env),
      ...ISOLATION_ENV,
      // Both limits, so a gate runs in the foreground instead of being moved on.
      BASH_DEFAULT_TIMEOUT_MS: String((input.bashTimeoutSecs ?? DEFAULT_BASH_TIMEOUT_SECS) * 1000),
      BASH_MAX_TIMEOUT_MS: String((input.bashTimeoutSecs ?? DEFAULT_BASH_TIMEOUT_SECS) * 1000),
    },
    hooks: {
      PreToolUse: [{ hooks: [toolHook("start")] }],
      PostToolUse: [{ hooks: [toolHook("end")] }],
      PostToolUseFailure: [{ hooks: [toolHook("failed")] }],
    },
    stderr: (data) => {
      io.log(data.trimEnd());
      for (const text of data.split("\n")) if (text.trim().length > 0) stderrTail.push(text.trim());
      if (stderrTail.length > 5) stderrTail.splice(0, stderrTail.length - 5);
    },
    ...(operadServer === undefined && input.mcpServers === undefined
      ? {}
      : {
          mcpServers: {
            ...(operadServer === undefined ? {} : { [OPERAD_SERVER]: operadServer }),
            // A bot's servers: each is started behind its guard, which holds the secrets.
            ...Object.fromEntries(
              Object.entries(input.mcpServers ?? {}).map(([name, server]) => [
                name,
                { type: "stdio" as const, command: server.command, args: [...server.args] },
              ]),
            ),
          },
        }),
    ...(input.resumeSession !== undefined ? { resume: input.resumeSession } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
    ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
    ...(input.budgetUsd !== undefined ? { maxBudgetUsd: input.budgetUsd } : {}),
    ...(hooks.spawnClaudeCodeProcess !== undefined ? { spawnClaudeCodeProcess: hooks.spawnClaudeCodeProcess } : {}),
  };

  let sessionId: string | null = null;
  let modelError: WorkerModelError | undefined;
  let final: Extract<SDKMessage, { type: "result" }> | undefined;
  const seenMessages = new Set<string>();
  let thrown: string | undefined;
  let continued = false;

  // Images go with the prompt as one user message of text and image blocks.
  const images = input.images ?? [];
  const first = (async function* () {
    const blocks = await Promise.all(images.map((image) => readImage(image)));
    yield {
      type: "user" as const,
      message: {
        role: "user" as const,
        content: [
          { type: "text" as const, text: input.prompt },
          ...blocks.map((block) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: block.mediaType, data: block.data },
          })),
        ],
      },
      parent_tool_use_id: null,
    };
  })();
  const session = query({ prompt: images.length === 0 ? input.prompt : first, options });
  // A message the host sends mid-run goes to claude as one more user turn,
  // queued behind the tool call that is running.
  io.onMessage?.((text) => {
    const turn = (async function* () {
      yield {
        type: "user" as const,
        message: { role: "user" as const, content: text },
        parent_tool_use_id: null,
        priority: "next" as const,
      };
    })();
    session.streamInput(turn).catch((error: unknown) => {
      io.log(`a message to claude was not delivered: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  const account = session.initializationResult().then(
    (init) => init.account,
    () => undefined,
  );

  try {
    messages: for await (const message of session) {
      if ("session_id" in message && typeof message.session_id === "string") sessionId = message.session_id;
      switch (message.type) {
        case "system":
          if (message.subtype === "init" && final !== undefined) {
            // claude went on by itself after the result (something it started
            // finished). A run is one turn: stop here and say so.
            io.log("a second session started after the result; stopping");
            continued = true;
            break messages;
          }
          if (message.subtype === "init") {
            io.log(`claude ${message.claude_code_version}`);
            writeLine({
              type: "session",
              claudeVersion: message.claude_code_version,
              apiKeySource: message.apiKeySource,
              model: message.model,
            });
          }
          break;
        case "stream_event": {
          streamEvent(message.event);
          break;
        }
        case "assistant": {
          flushDelta(true);
          const texts: string[] = [];
          for (const block of message.message.content) {
            if (block.type === "text") texts.push(block.text);
            else if (block.type === "thinking") writeEnd("thinking", block.thinking);
          }
          if (texts.length > 0) writeEnd("text", texts.join(""));

          const id = message.message.id;
          if (seenMessages.has(id)) break;
          seenMessages.add(id);
          const said = messageSummary(
            message.message.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join(" "),
          );
          io.line({
            type: "message_end",
            role: "assistant",
            ...(said === undefined ? {} : { text: said }),
            stopReason: message.message.stop_reason,
            usage: usageOf(message.message.usage),
            cost: null,
          });
          break;
        }
        case "rate_limit_event": {
          const info = message.rate_limit_info;
          const rateLimitType = info.rateLimitType ?? null;
          const resetsAt = info.resetsAt ?? null;
          writeLine({ type: "rate_limit", status: info.status, rateLimitType, resetsAt });
          if (info.status === "rejected") {
            modelError = {
              kind: "usage_limit",
              message: `usage limit reached${rateLimitType === null ? "" : ` (${rateLimitType})`}`,
              rateLimitType,
              resetsAt,
            };
          }
          break;
        }
        case "result":
          final = message;
          break;
        default:
          break;
      }
    }
  } catch (error) {
    if (!cancelled) {
      thrown = error instanceof Error ? error.message : String(error);
      if (stderrTail.length > 0) thrown = `${thrown}\n${stderrTail.join("\n")}`;
    }
  } finally {
    cancel.removeEventListener("abort", onCancel);
    session.close();
  }

  // Every way this run ends writes its Result here: text still held back as a
  // possible secret prefix is released first (masked if it is a whole secret),
  // so a cancelled or failed partial reply does not lose its last characters.
  const finish = (line: WorkerResult, code: number): number => {
    flushDelta(true);
    io.line(line);
    return code;
  };

  if (cancelled) {
    return finish(
      {
        type: "result",
        result: "cancelled",
        sessionId,
        usage: {},
        cost: null,
        finalMessage: null,
        model: null,
      },
      EXIT_CANCELLED,
    );
  }

  if (final === undefined) {
    const message = thrown ?? "claude ended without a result";
    return finish(
      { ...failure(isSessionMissing(message) ? "session_missing" : "model_error", message), sessionId },
      EXIT_FAILED,
    );
  }

  const info = await account;
  const quality: CostQuality =
    info?.subscriptionType !== undefined && info.subscriptionType.length > 0 ? "estimated" : "exact";
  const counts = usageOf(final.usage);
  const text = "result" in final && typeof final.result === "string" ? final.result : null;
  const names = Object.keys(final.modelUsage ?? {});
  const hasModel = names.length > 0;
  const base = {
    type: "result",
    sessionId: final.session_id,
    usage: counts,
    // A run that used no model (a session that would not load) has no cost to
    // call exact or estimated.
    cost: hasModel ? { micros: Math.round(finite(final.total_cost_usd) * 1e6), quality } : null,
    finalMessage: text,
    model: names[0] ?? null,
  } as const;

  if (continued) {
    return finish(
      {
        ...base,
        result: "failed",
        reason: "model_error",
        message:
          "claude went on after its result: a second session started by itself (something it ran in the background finished); a run is one turn",
      },
      EXIT_FAILED,
    );
  }
  if (final.subtype === "success" && !final.is_error) {
    return finish({ ...base, result: "done" }, 0);
  }
  // An error result carries its text in `errors` (an unknown session says
  // "No conversation found with session ID: ..."); a success-shaped one in `result`.
  const errors = "errors" in final && Array.isArray(final.errors) ? final.errors.filter((e) => typeof e === "string") : [];
  const message =
    modelError?.message ??
    (errors.length > 0
      ? errors.join("; ")
      : text !== null && text.length > 0
        ? text
        : `claude stopped: ${final.subtype}`);
  const reason: FailureReason = isSessionMissing(message) ? "session_missing" : "model_error";
  return finish(
    {
      ...base,
      result: "failed",
      reason,
      message,
      ...(modelError !== undefined ? { modelError } : {}),
    },
    EXIT_FAILED,
  );
}

/**
 * Stdin as lines. The first line (or all of stdin when it has no newline) is the
 * input; later lines are the host's answers.
 */
class StdinLines {
  readonly #reader: AsyncIterator<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #done = false;

  constructor(stream: AsyncIterable<Uint8Array>) {
    this.#reader = stream[Symbol.asyncIterator]();
  }

  /** Stops reading; a read that waits ends as if stdin had ended. */
  close(): void {
    void this.#reader.return?.()?.catch(() => undefined);
  }

  async #more(): Promise<boolean> {
    if (this.#done) return false;
    const chunk = await this.#reader.next();
    if (chunk.done) {
      this.#done = true;
      this.#buffer += this.#decoder.decode();
      return false;
    }
    this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
    return true;
  }

  /** The next line, or what is left at the end of stdin; undefined when nothing is. */
  async next(): Promise<string | undefined> {
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline !== -1) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.trim().length === 0) continue;
        return line;
      }
      if (!(await this.#more())) {
        const rest = this.#buffer;
        this.#buffer = "";
        return rest.trim().length === 0 ? undefined : rest;
      }
    }
  }

  async first(): Promise<string> {
    return (await this.next()) ?? "";
  }
}

/**
 * The program without the process around it: reads the input and the host's
 * answers from `stdin`, writes lines through `ports`, and returns the exit
 * code. `cancel` is the SIGTERM signal.
 */
export async function serveWorker(
  stdinStream: AsyncIterable<Uint8Array>,
  ports: WorkerPorts,
  cancel: AbortSignal,
  hooks: WorkerHooks = {},
): Promise<number> {
  const write = ports.write;
  const stdin = new StdinLines(stdinStream);
  const waiting = new Map<number, (used: boolean) => void>();
  const questions = new Map<number, (answer: CallAnswer) => void>();
  let nextAsk = 1;
  const early: string[] = [];
  let onMessage: ((text: string) => void) | undefined;
  let nextGrant = 1;
  let hostGone = false;
  const io: WorkerIo = {
    line: (line) => write(`${JSON.stringify(line)}\n`),
    onMessage: (handler) => {
      onMessage = handler;
      for (const text of early.splice(0)) handler(text);
    },
    log: (text) => ports.log(text),
    useGrant: (waitId) =>
      new Promise<boolean>((resolve) => {
        if (hostGone) {
          resolve(false);
          return;
        }
        const id = nextGrant;
        nextGrant += 1;
        waiting.set(id, resolve);
        write(`${JSON.stringify({ type: "grant_use", id, waitId })}\n`);
      }),
    ask: (call) =>
      new Promise<CallAnswer>((resolve) => {
        if (hostGone) {
          resolve({ decision: "deny", reason: "the host is gone" });
          return;
        }
        const id = nextAsk;
        nextAsk += 1;
        questions.set(id, (answer) => {
          // The line that closes the question, so the host's stall timer runs again.
          write(`${JSON.stringify({ type: "ask_resolved", id })}\n`);
          resolve(answer);
        });
        write(`${JSON.stringify({ type: "ask_call", id, ...call })}\n`);
      }),
  };
  let code: number;
  try {
    const text = await stdin.first();
    let decoded: unknown;
    let parsedOk = true;
    try {
      decoded = JSON.parse(text);
    } catch {
      parsedOk = false;
    }
    const parsed = parsedOk ? parseInput(decoded) : ({ ok: false, message: "the input is not valid JSON" } as const);
    if (!parsed.ok) {
      io.line(failure("invalid_input", parsed.message));
      code = EXIT_INVALID_INPUT;
    } else {
      // Later stdin lines answer `grant_use` lines.
      void (async () => {
        for (;;) {
          const line = await stdin.next();
          if (line === undefined) break;
          const said = messageText(line);
          if (said !== undefined) {
            if (onMessage === undefined) early.push(said);
            else onMessage(said);
            continue;
          }
          try {
            const ack: unknown = JSON.parse(line);
            if (typeof ack === "object" && ack !== null && Reflect.get(ack, "type") === "ask_ack") {
              const id: unknown = Reflect.get(ack, "id");
              const decision: unknown = Reflect.get(ack, "decision");
              const reason: unknown = Reflect.get(ack, "reason");
              if (typeof id === "number") {
                questions.get(id)?.({
                  decision: decision === "allow" || decision === "stop" ? decision : "deny",
                  ...(typeof reason === "string" ? { reason } : {}),
                });
                questions.delete(id);
              }
            }
            if (typeof ack === "object" && ack !== null && Reflect.get(ack, "type") === "grant_ack") {
              const id: unknown = Reflect.get(ack, "id");
              const used: unknown = Reflect.get(ack, "used");
              if (typeof id === "number") {
                waiting.get(id)?.(used === true);
                waiting.delete(id);
              }
            }
          } catch {
            // Not a line the program understands; it is ignored.
          }
        }
        // The host is gone: nothing more will be granted.
        hostGone = true;
        for (const resolve of waiting.values()) resolve(false);
        waiting.clear();
        for (const resolve of questions.values()) resolve({ decision: "deny", reason: "the host is gone" });
        questions.clear();
      })();
      code = await runWorker(parsed.input, io, cancel, hooks);
    }
  } catch (error) {
    io.log(error instanceof Error ? (error.stack ?? error.message) : String(error));
    io.line(failure("model_error", error instanceof Error ? error.message : String(error)));
    code = EXIT_FAILED;
  }
  stdin.close();
  return code;
}

/** The process entry: stdin in, stdout lines out, exit code out. */
export async function main(hooks: WorkerHooks = {}): Promise<never> {
  const flush = (): Promise<void> =>
    new Promise((resolve) => {
      process.stdout.write("", () => resolve());
    });
  // Anything that prints to stdout by accident would corrupt the protocol.
  console.log = (...args: unknown[]): void => {
    process.stderr.write(`${args.map(String).join(" ")}\n`);
  };
  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  const code = await serveWorker(
    Bun.stdin.stream(),
    {
      write: (text) => {
        process.stdout.write(text);
      },
      log: (text) => process.stderr.write(`${text}\n`),
    },
    controller.signal,
    hooks,
  );
  await flush();
  process.exit(code);
}

if (import.meta.main) await main();
