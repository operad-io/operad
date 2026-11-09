/**
 * The pi child program (docs/backlog/operad-harness-pi.md decisions 2, 3, 5, 6).
 *
 * Reads one JSON object from stdin, runs one prompt in pi and writes one JSON
 * object per line to stdout, the last a Result. `README.md` holds the tables.
 */

import { existsSync, mkdirSync } from "node:fs";
import {
  findGrant,
  firstErrorLine,
  REFUSED_IN_LOG,
  match,
  messageSummary,
  readProfile,
  summarizeCall,
  type AccessProfile,
} from "@operad-io/access-match";
import type {
  AgentSessionEvent,
  ExtensionFactory,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { messageText } from "@operad-io/harness-process";
import { findPi, loadPi } from "./pi-install.ts";
import {
  DEFAULT_BASH_TIMEOUT_SECS,
  parseInput,
  type FailureReason,
  type WorkerInput,
  type WorkerLine,
  type WorkerResult,
  type WorkerUsage,
} from "./protocol.ts";

/**
 * The timeout, in seconds, a bash call runs under. pi's bash tool has no default
 * timeout and takes the model's own `timeout`; a call without one, or with a
 * longer one, gets the limit. Anything else (a bad value) is left for pi to refuse.
 */
export function boundedTimeout(requested: unknown, limitSecs: number): number | undefined {
  if (requested === undefined || requested === null) return limitSecs;
  if (typeof requested === "number" && Number.isFinite(requested) && requested > limitSecs) return limitSecs;
  return undefined;
}

export const EXIT_FAILED = 1;
export const EXIT_INVALID_INPUT = 2;
export const EXIT_CANCELLED = 143;

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
   * Hands each message the host sends mid-run to `handler`, those that came
   * before the call first. Absent when the host cannot send any.
   */
  onMessage?(handler: (text: string) => void): void;
}

export interface WorkerHooks {
  /** Registers extra model providers; the tests use it for the fake model. */
  registerProviders?(runtime: ModelRuntime): void;
  /** The clock for tool call times, in epoch milliseconds; the tests inject one. */
  now?: () => number;
}

/** The text of an assistant message, thinking and tool calls left out. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) =>
      typeof block === "object" && block !== null && Reflect.get(block, "type") === "text"
        ? String(Reflect.get(block, "text") ?? "")
        : "",
    )
    .join(" ");
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The price of one message in USD, or null when pi gave none. */
function priceOf(usage: unknown): number | null {
  if (typeof usage !== "object" || usage === null) return null;
  const cost: unknown = Reflect.get(usage, "cost");
  if (typeof cost !== "object" || cost === null) return null;
  return finite(Reflect.get(cost, "total"));
}

class Tally {
  readonly usage: WorkerUsage = {};
  #total = 0;
  #priced = 0;
  #unpriced = 0;
  lastStop: string | undefined;
  lastError: string | undefined;

  add(message: Extract<AgentSessionEvent, { type: "message_end" }>["message"]): WorkerLine | undefined {
    if (message.role !== "assistant") return undefined;
    const usage = message.usage;
    const counts = {
      input: finite(usage.input) ?? 0,
      output: finite(usage.output) ?? 0,
      cache_read: finite(usage.cacheRead) ?? 0,
      cache_write: finite(usage.cacheWrite) ?? 0,
    };
    for (const key of ["input", "output", "cache_read", "cache_write"] as const) {
      this.usage[key] = (this.usage[key] ?? 0) + counts[key];
    }
    const price = priceOf(usage);
    if (price === null) this.#unpriced += 1;
    else {
      this.#priced += 1;
      this.#total += price;
    }
    this.lastStop = message.stopReason;
    this.lastError = message.stopReason === "error" ? (message.errorMessage ?? "the model failed") : undefined;
    const said = messageSummary(textOf(message.content));
    return {
      type: "message_end",
      role: "assistant",
      ...(said === undefined ? {} : { text: said }),
      stopReason: message.stopReason,
      usage: counts,
      cost: price === null ? null : { total: price },
    };
  }

  /**
   * The price of the messages that had one; `incomplete` when some did not.
   * Null when no message had a price.
   */
  get cost(): { micros: number; incomplete?: true } | null {
    if (this.#priced === 0) return null;
    const micros = Math.round(this.#total * 1e6);
    return this.#unpriced > 0 ? { micros, incomplete: true } : { micros };
  }
}

function failure(reason: FailureReason, message: string): WorkerResult {
  return { type: "result", result: "failed", sessionId: null, usage: {}, cost: null, finalMessage: null, reason, message };
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
  if (input.resumeSession !== undefined && !existsSync(input.resumeSession)) {
    io.line(failure("session_missing", `resumeSession does not exist: ${input.resumeSession}`));
    return EXIT_FAILED;
  }

  // pi is the user's own install: found at start, never bundled.
  let pi: Awaited<ReturnType<typeof loadPi>>;
  try {
    const install = findPi(input.piCommand);
    io.log(`pi ${install.version} loaded from ${install.dir}`);
    pi = await loadPi(install);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.line(failure("model_error", message));
    return EXIT_FAILED;
  }
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = pi;

  mkdirSync(input.agentDir, { recursive: true });
  mkdirSync(input.sessionDir, { recursive: true });

  const runtime = await ModelRuntime.create({
    authPath: input.authPath,
    modelsPath: input.modelsPath,
    refreshOnCreate: false,
  });
  hooks.registerProviders?.(runtime);

  let model: ReturnType<ModelRuntime["getModel"]>;
  if (input.model !== undefined) {
    const slash = input.model.indexOf("/");
    model = runtime.getModel(input.model.slice(0, slash), input.model.slice(slash + 1));
    if (model === undefined) {
      io.line(failure("model_missing", `model is not known to pi: ${input.model}`));
      return EXIT_FAILED;
    }
  }

  const sessionManager =
    input.resumeSession !== undefined
      ? SessionManager.open(input.resumeSession, input.sessionDir)
      : SessionManager.create(input.cwd, input.sessionDir);

  // The one extension operad loads. Its tool_call handler asks the access
  // matcher; a refusal blocks the call and the agent goes on.
  const bashTimeoutSecs = input.bashTimeoutSecs ?? DEFAULT_BASH_TIMEOUT_SECS;
  const access = readProfile(input.access ?? {});
  const profile: AccessProfile = access.ok ? access.profile : {};
  const blockedCalls = new Set<string>();
  const operadExtension: ExtensionFactory = (pi) => {
    pi.on("tool_call", async (event) => {
      io.log(`tool_call ${event.toolName}`);
      if (event.toolName === "bash") {
        // The timeout kills the command; pi gives the model a tool error and the run goes on.
        const bounded = boundedTimeout(Reflect.get(event.input, "timeout"), bashTimeoutSecs);
        if (bounded !== undefined) Reflect.set(event.input, "timeout", bounded);
      }
      const verdict = match(profile, { tool: event.toolName, input: event.input, cwd: input.cwd });
      if (verdict.allow) return undefined;
      // A one-time permission covers one exact call that would be refused. The
      // host writes the fact before it answers, so a crash after it cannot
      // give the permission twice.
      const call = { tool: event.toolName, input: event.input, cwd: input.cwd };
      const grant = findGrant(profile, call);
      if (grant !== undefined && io.useGrant !== undefined) {
        let used = false;
        try {
          used = await io.useGrant(grant.waitId);
        } catch {
          used = false;
        }
        if (used) return undefined;
      }
      blockedCalls.add(event.toolCallId);
      io.line({ type: "blocked", toolName: event.toolName, reason: REFUSED_IN_LOG });
      return { block: true, reason: verdict.reason };
    });
  };

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [{ name: "operad", factory: operadExtension, hidden: true }],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: input.cwd,
    agentDir: input.agentDir,
    modelRuntime: runtime,
    resourceLoader,
    sessionManager,
    settingsManager,
    ...(model !== undefined ? { model } : {}),
    ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
  });

  const tally = new Tally();
  const now = hooks.now ?? Date.now;
  const started = new Map<string, number>();
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  session.subscribe((event) => {
    switch (event.type) {
      case "message_end": {
        const line = tally.add(event.message);
        if (line !== undefined) io.line(line);
        break;
      }
      case "tool_execution_start": {
        const startedAt = now();
        started.set(event.toolCallId, startedAt);
        const summary = summarizeCall(profile, event.toolName, event.args, input.cwd, { secrets: input.secretValues });
        io.line({
          type: "tool_execution_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          at: startedAt,
          ...(summary === undefined ? {} : { input: summary }),
        });
        break;
      }
      case "tool_execution_end": {
        const begun = started.get(event.toolCallId);
        started.delete(event.toolCallId);
        const firstLine = blockedCalls.has(event.toolCallId) ? REFUSED_IN_LOG : event.isError ? firstErrorLine(textOf(typeof event.result === "object" && event.result !== null ? Reflect.get(event.result, "content") : event.result), { secrets: input.secretValues }) : undefined;
        io.line({
          type: "tool_execution_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          durationMs: begun === undefined ? (event.durationMs ?? 0) : Math.max(0, now() - begun),
          ...(firstLine === undefined ? {} : { error: firstLine }),
        });
        break;
      }
      case "agent_settled":
        io.line({ type: "agent_settled", aborted: event.aborted });
        settle();
        break;
      default:
        break;
    }
  });

  const result = (name: "done" | "cancelled"): WorkerResult => ({
    type: "result",
    result: name,
    sessionId: session.sessionFile ?? null,
    usage: tally.usage,
    cost: tally.cost,
    finalMessage: session.getLastAssistantText() ?? null,
  });

  // A message the host sends mid-run steers the agent: pi delivers it after
  // the tool call that is running.
  io.onMessage?.((text) => {
    io.log("a message from the host is given to pi");
    session.prompt(text, { streamingBehavior: "steer" }).catch((error: unknown) => {
      io.log(`a message to pi was not delivered: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  let cancelled = cancel.aborted;
  const onCancel = (): void => {
    cancelled = true;
    void session.abort();
  };
  cancel.addEventListener("abort", onCancel, { once: true });

  try {
    if (!cancelled) {
      try {
        await session.prompt(input.prompt);
      } catch (error) {
        if (!cancelled) {
          io.line({
            ...failure("model_error", error instanceof Error ? error.message : String(error)),
            sessionId: session.sessionFile ?? null,
            usage: tally.usage,
            cost: tally.cost,
          });
          return EXIT_FAILED;
        }
      }
      if (!cancelled) await settled;
    }
    if (cancelled) {
      await session.abort();
      io.line(result("cancelled"));
      return EXIT_CANCELLED;
    }
    if (tally.lastError !== undefined) {
      io.line({
        ...failure("model_error", tally.lastError),
        sessionId: session.sessionFile ?? null,
        usage: tally.usage,
        cost: tally.cost,
        finalMessage: session.getLastAssistantText() ?? null,
      });
      return EXIT_FAILED;
    }
    io.line(result("done"));
    return 0;
  } finally {
    cancel.removeEventListener("abort", onCancel);
    session.dispose();
  }
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

  // pi runs bash non-interactively (`bash -c`): no aliases or functions from the
  // user's rc files. BASH_ENV and ENV are the two ways a non-interactive shell
  // is made to read a file, so the agent's shell does not get them.
  delete process.env["BASH_ENV"];
  delete process.env["ENV"];

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
          const said = messageText(line);
          if (said !== undefined) {
            if (onMessage === undefined) early.push(said);
            else onMessage(said);
            continue;
          }
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
