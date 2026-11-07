/**
 * The claude child program (docs/backlog/operad-harness-claude.md decisions
 * 2 to 8).
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
import { readProfile, type AccessProfile } from "@operad-io/access-match";
import { decideAccess } from "./access.ts";
import { findClaude } from "./claude-install.ts";
import {
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

/**
 * What the program sets for the `claude` it starts, so that it does not
 * remember, read project instruction files, report or phone home on its own.
 * `SPIKE.md` lists which names the installed Claude Code reads.
 */
export const ISOLATION_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
};

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
}

export interface WorkerHooks {
  /** Replaces the process the SDK starts; the tests use it for a fake `claude`. */
  spawnClaudeCodeProcess?: Options["spawnClaudeCodeProcess"];
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

  // Tool calls that have started and not ended; a refused call ends here too,
  // so the host never sees a call stay open.
  const open = new Map<string, string>();
  const startCall = (id: string, name: string): void => {
    if (open.has(id)) return;
    open.set(id, name);
    io.line({ type: "tool_execution_start", toolCallId: id, toolName: name });
  };
  const endCall = (id: string, name: string, isError: boolean): void => {
    if (!open.delete(id)) return;
    io.line({ type: "tool_execution_end", toolCallId: id, toolName: name, isError });
  };
  const toolHook =
    (kind: "start" | "end" | "failed"): HookCallback =>
    async (event) => {
      if (event.hook_event_name === "PreToolUse" && kind === "start") {
        startCall(event.tool_use_id, event.tool_name);
      } else if (event.hook_event_name === "PostToolUse" && kind === "end") {
        endCall(event.tool_use_id, event.tool_name, false);
      } else if (event.hook_event_name === "PostToolUseFailure" && kind === "failed") {
        endCall(event.tool_use_id, event.tool_name, true);
      }
      return {};
    };

  // The profile was checked when the input was read; a bad one never gets here.
  const read = readProfile(input.access ?? {});
  const profile: AccessProfile = read.ok ? read.profile : {};

  // The only permission surface (`permissionMode: 'default'` sends every call
  // that is not already allowed here). A refusal goes to the model as the
  // tool's result and the run goes on; the call is closed for the host.
  const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
    io.log(`canUseTool ${toolName}`);
    const verdict = await decideAccess(profile, toolName, toolInput, input.cwd, io.useGrant);
    if (verdict.allow) return { behavior: "allow", updatedInput: toolInput };
    io.line({ type: "blocked", toolName, reason: verdict.reason });
    endCall(options.toolUseID, toolName, true);
    return { behavior: "deny", message: verdict.reason };
  };

  const stderrTail: string[] = [];
  const options: Options = {
    cwd: input.cwd,
    pathToClaudeCodeExecutable: executable,
    settingSources: [],
    permissionMode: "default",
    permissionPrompts: "host",
    systemPrompt: { type: "preset", preset: "claude_code" },
    canUseTool,
    abortController: controller,
    env: { ...process.env, ...ISOLATION_ENV },
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

  const session = query({ prompt: input.prompt, options });
  const account = session.initializationResult().then(
    (init) => init.account,
    () => undefined,
  );

  try {
    for await (const message of session) {
      if ("session_id" in message && typeof message.session_id === "string") sessionId = message.session_id;
      switch (message.type) {
        case "system":
          if (message.subtype === "init") io.log(`claude ${message.claude_code_version}`);
          break;
        case "assistant": {
          const id = message.message.id;
          if (seenMessages.has(id)) break;
          seenMessages.add(id);
          io.line({
            type: "message_end",
            role: "assistant",
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
          io.line({ type: "rate_limit", status: info.status, rateLimitType, resetsAt });
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

  if (cancelled) {
    io.line({
      type: "result",
      result: "cancelled",
      sessionId,
      usage: {},
      cost: null,
      finalMessage: null,
      model: null,
    });
    return EXIT_CANCELLED;
  }

  if (final === undefined) {
    const message = thrown ?? "claude ended without a result";
    io.line({ ...failure(isSessionMissing(message) ? "session_missing" : "model_error", message), sessionId });
    return EXIT_FAILED;
  }

  const info = await account;
  const quality: CostQuality =
    info?.subscriptionType !== undefined && info.subscriptionType.length > 0 ? "estimated" : "exact";
  const counts = usageOf(final.usage);
  const text = "result" in final && typeof final.result === "string" ? final.result : null;
  const names = Object.keys(final.modelUsage ?? {});
  const base = {
    type: "result",
    sessionId: final.session_id,
    usage: counts,
    cost: { micros: Math.round(finite(final.total_cost_usd) * 1e6), quality },
    finalMessage: text,
    model: names[0] ?? null,
  } as const;

  if (final.subtype === "success" && !final.is_error) {
    io.line({ ...base, result: "done" });
    return 0;
  }
  const message =
    modelError?.message ??
    (text !== null && text.length > 0 ? text : `claude stopped: ${final.subtype}`);
  const reason: FailureReason = isSessionMissing(message) ? "session_missing" : "model_error";
  io.line({
    ...base,
    result: "failed",
    reason,
    message,
    ...(modelError !== undefined ? { modelError } : {}),
  });
  return EXIT_FAILED;
}

/**
 * Stdin as lines. The first line (or all of stdin when it has no newline) is the
 * input; later lines are the host's answers.
 */
class StdinLines {
  readonly #reader = Bun.stdin.stream().getReader();
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #done = false;

  async #more(): Promise<boolean> {
    if (this.#done) return false;
    const chunk = await this.#reader.read();
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

/** The process entry: stdin in, stdout lines out, exit code out. */
export async function main(hooks: WorkerHooks = {}): Promise<never> {
  const write = (text: string): void => {
    process.stdout.write(text);
  };
  const flush = (): Promise<void> =>
    new Promise((resolve) => {
      process.stdout.write("", () => resolve());
    });
  const stdin = new StdinLines();
  const waiting = new Map<number, (used: boolean) => void>();
  let nextGrant = 1;
  let hostGone = false;
  const io: WorkerIo = {
    line: (line) => write(`${JSON.stringify(line)}\n`),
    log: (text) => process.stderr.write(`${text}\n`),
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
  };
  // Anything that prints to stdout by accident would corrupt the protocol.
  console.log = (...args: unknown[]): void => {
    process.stderr.write(`${args.map(String).join(" ")}\n`);
  };

  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());

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
          try {
            const ack: unknown = JSON.parse(line);
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
      })();
      code = await runWorker(parsed.input, io, controller.signal, hooks);
    }
  } catch (error) {
    io.log(error instanceof Error ? (error.stack ?? error.message) : String(error));
    io.line(failure("model_error", error instanceof Error ? error.message : String(error)));
    code = EXIT_FAILED;
  }
  await flush();
  process.exit(code);
}

if (import.meta.main) await main();
