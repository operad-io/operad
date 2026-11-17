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
  type SDKUserMessage,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import {
  firstErrorLine,
  messageSummary,
  readProfile,
  REFUSED_IN_LOG,
  summarizeCall,
  type AccessProfile,
} from "@operad-io/access-match";
import { checkProfile, decideAccess, type CallAnswer } from "./access.ts";
import {
  EXIT_CANCELLED,
  EXIT_FAILED,
  EXIT_INVALID_INPUT,
  maskSecrets,
  OPERAD_SERVER,
  readGivenSkills,
  readImage,
  serveKeptWorker,
  serveOne,
  serverCommand,
  toolOutputLines,
  type GivenSkill,
  type WorkerAdapter,
  type WorkerIo as SharedWorkerIo,
  type WorkerPorts,
} from "@operad-io/harness-process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn as spawnProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findClaude } from "./claude-install.ts";
import {
  claudeContextWindow,
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

export { EXIT_CANCELLED, EXIT_FAILED, EXIT_INVALID_INPUT };

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
 * The isolation variables that keep instruction files and auto memory off.
 * A bot that uses the owner's own agent settings leaves these out; telemetry,
 * error reporting and background tasks stay off.
 */
export const INSTRUCTION_ISOLATION_ENV: readonly string[] = [
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
  "CLAUDE_CODE_DISABLE_CLAUDE_MDS",
];

/** The setting sources a bot that uses the owner's own agent settings loads. */
export const OWN_SETTING_SOURCES = ["user", "project", "local"] as const;

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

/** The name the temporary plugin mounts operad's skills under. */
export const SKILLS_PLUGIN = "operad-skills";

interface SkillPlugin {
  readonly dir: string;
  readonly names: readonly string[];
}

/**
 * The SDK's `skills` option filters skills it discovered; it cannot add a
 * directory. A local plugin can, so the given skill directories are mounted
 * as links in a plugin under the worker's own temporary directory. Nothing is
 * written into a skill directory or the repository, and the whole temporary
 * plugin is removed when the run ends.
 */
function buildSkillPlugin(skills: readonly GivenSkill[]): SkillPlugin {
  const dir = mkdtempSync(join(tmpdir(), "operad-claude-skills-"));
  try {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeFileSync(
      join(dir, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: SKILLS_PLUGIN, version: "0.1.0", skills: ["./skills"] }, null, 2)}\n`,
    );
    for (const skill of skills) {
      symlinkSync(skill.path, join(dir, "skills", skill.name), "dir");
    }
    return { dir, names: skills.map((skill) => skill.name) };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Where the program writes. Lines are written whole, in order. */
export type WorkerIo = SharedWorkerIo<WorkerLine>;

export interface WorkerHooks {
  /** Replaces the process the SDK starts; the tests use it for a fake `claude`. */
  spawnClaudeCodeProcess?: Options["spawnClaudeCodeProcess"];
  /** The clock for tool call times, in epoch milliseconds; the tests inject one. */
  now?: () => number;
  /** The environment the started `claude` inherits; the process's own when absent. */
  env?: Readonly<Record<string, string | undefined>>;
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

/** What claude itself says about a turn that ended without text and without a model call. */
function noAnswerReason(
  final: { readonly subtype: string; readonly local_command?: string },
  errors: readonly string[],
): string {
  const parts = [`the agent reported ${final.subtype}`];
  if (errors.length > 0) parts.push(`errors: ${errors.join("; ")}`);
  const command = typeof final.local_command === "string" ? final.local_command.trim() : "";
  if (command.length > 0) parts.push(`it ran the local command ${command}`);
  return parts.join("; ");
}

/**
 * Runs one prompt and returns the exit code. `cancel` is the SIGTERM signal;
 * the Result is written before the code is returned.
 */
/** One reply's state while the session's message loop writes its lines. */
interface Turn {
  readonly input: WorkerInput;
  readonly io: WorkerIo;
  readonly cancel: AbortSignal;
  cancelled: boolean;
  deltaKind: StreamKind | undefined;
  deltaText: string;
  deltaAt: number;
  readonly streamBlocks: Map<number, { readonly kind: StreamKind; text: string }>;
  readonly open: Map<string, { readonly name: string; readonly startedAt: number }>;
  readonly profile: AccessProfile;
  final: Extract<SDKMessage, { type: "result" }> | undefined;
  lastUsage: Required<WorkerUsage> | undefined;
  modelError: WorkerModelError | undefined;
  thrown: string | undefined;
  continued: boolean;
  settled: boolean;
  readonly done: Promise<void>;
  readonly resolveDone: () => void;
}

function newTurn(input: WorkerInput, io: WorkerIo, cancel: AbortSignal): Turn {
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  return {
    input,
    io,
    cancel,
    cancelled: cancel.aborted,
    deltaKind: undefined,
    deltaText: "",
    deltaAt: 0,
    streamBlocks: new Map(),
    open: new Map(),
    profile: (() => {
      const read = readProfile(input.access ?? {});
      return read.ok ? read.profile : {};
    })(),
    final: undefined,
    lastUsage: undefined,
    modelError: undefined,
    thrown: undefined,
    continued: false,
    settled: false,
    done,
    resolveDone,
  };
}

/** The prompts after the first, held until the SDK asks for them. */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private readonly waiters: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.items.push(message);
    else waiter({ value: message, done: false });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: (): Promise<IteratorResult<SDKUserMessage>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/** Whether claude must take the text as written instead of dispatching it as its own command. */
function leadingSlash(text: string): boolean {
  return text.trimStart().startsWith("/");
}

function clientComposed(text: string): { readonly client_composed?: true } {
  return leadingSlash(text) ? { client_composed: true } : {};
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user" as const,
    message: { role: "user" as const, content: text },
    parent_tool_use_id: null,
    ...clientComposed(text),
  };
}

async function userMessageWithImages(input: WorkerInput): Promise<SDKUserMessage> {
  const blocks = await Promise.all((input.images ?? []).map((image) => readImage(image)));
  return {
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
    ...clientComposed(input.prompt),
  };
}

/**
 * Starts claude in a process group of its own with a helper that watches this
 * worker. A worker killed with no chance to clean up (SIGKILL) still leaves no
 * `claude` behind: the helper sees its parent gone and kills the group. Without
 * this, only a graceful close would end claude.
 */
function spawnWatched(options: SpawnOptions): SpawnedProcess {
  const script = [
    "parent=$1",
    "shift",
    '( while kill -0 "$parent" 2>/dev/null; do sleep 1; done; kill -KILL -$$ ) >/dev/null 2>&1 &',
    'exec "$@"',
  ].join("\n");
  return spawnProcess(
    "sh",
    ["-c", script, "operad-claude", String(process.pid), options.command, ...options.args],
    {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

/**
 * One claude session behind the worker. A plain worker opens it for one reply
 * and closes it; a kept worker opens it for the first reply and leaves it open,
 * so later replies send another prompt through the same query stream and the
 * `claude` process is not started again.
 */
class ClaudeSession {
  private readonly controller = new AbortController();
  private readonly now: () => number;
  private readonly hooks: WorkerHooks;
  private readonly persistent: boolean;
  private readonly secrets: readonly string[];
  private readonly given: ReturnType<typeof readGivenSkills>;
  private readonly skillPlugin: SkillPlugin | undefined;
  private readonly sessionSkillNote: string | undefined;
  private readonly stderrTail: string[] = [];
  private readonly seenMessages = new Set<string>();
  private readonly queue: PromptQueue | undefined;
  private readonly options: Options;
  private session: ReturnType<typeof query> | undefined;
  private account: Promise<{ subscriptionType?: string } | undefined> | undefined;
  private reading: Promise<void> | undefined;
  private turn: Turn | undefined;
  private sessionId: string | null = null;
  private initLine:
    | { readonly claudeVersion: string; readonly apiKeySource: string; readonly model: string }
    | undefined;
  private started = false;
  private queryEnded = false;
  private closed = false;
  private broken: string | undefined;
  private readonly endedHandlers: Array<(code: number) => void> = [];

  constructor(
    private readonly initial: WorkerInput,
    private readonly firstIo: WorkerIo,
    private readonly firstCancel: AbortSignal,
    hooks: WorkerHooks,
    persistent: boolean,
  ) {
    this.hooks = hooks;
    this.persistent = persistent;
    this.now = hooks.now ?? Date.now;
    this.secrets = initial.secretValues ?? [];
    this.given = readGivenSkills(initial.skills ?? []);
    this.skillPlugin = this.given.skills.length === 0 ? undefined : buildSkillPlugin(this.given.skills);
    this.sessionSkillNote =
      this.skillPlugin === undefined ? undefined : `skills: ${this.skillPlugin.names.join(", ")}`;
    this.queue = persistent ? new PromptQueue() : undefined;

    for (const skip of this.given.skipped) {
      const text = `skill ${skip.path}: ${skip.reason}`;
      firstIo.log(text);
      firstIo.line({ type: "log", text });
    }

    const operadServer =
      initial.operadTools === undefined
        ? undefined
        : {
            type: "stdio" as const,
            command: serverCommand(initial.operadTools).command,
            args: [...serverCommand(initial.operadTools).args],
            env: { OPERAD_HOME: initial.operadTools.home },
          };

    const childEnv: Record<string, string | undefined> = {
      ...(hooks.env ?? process.env),
      ...ISOLATION_ENV,
      BASH_DEFAULT_TIMEOUT_MS: String((initial.bashTimeoutSecs ?? DEFAULT_BASH_TIMEOUT_SECS) * 1000),
      BASH_MAX_TIMEOUT_MS: String((initial.bashTimeoutSecs ?? DEFAULT_BASH_TIMEOUT_SECS) * 1000),
    };
    if (initial.useOwnSettings === true) {
      // Instruction files and auto memory are the owner's own; telemetry, error
      // reporting and background tasks stay off.
      for (const name of INSTRUCTION_ISOLATION_ENV) delete childEnv[name];
    }
    this.options = {
      cwd: initial.cwd,
      pathToClaudeCodeExecutable: this.executable(initial),
      settingSources: initial.useOwnSettings === true ? [...OWN_SETTING_SOURCES] : [],
      permissionMode: "default",
      permissionPrompts: "host",
      includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code" },
      canUseTool: this.canUseTool,
      abortController: this.controller,
      disallowedTools: [...DISALLOWED_TOOLS],
      ...(this.skillPlugin === undefined
        ? {}
        : {
            plugins: [{ type: "local" as const, path: this.skillPlugin.dir }],
            // The switch keeps operad's skills and adds the owner's own; a name
            // both sides define is operad's because its plugin is the one mounted
            // here. With the switch off, only the skills mounted above load.
            skills:
              initial.useOwnSettings === true
                ? "all"
                : this.skillPlugin.names.map((name) => `${SKILLS_PLUGIN}:${name}`),
          }),
      env: childEnv,
      hooks: {
        PreToolUse: [{ hooks: [this.toolHook("start")] }],
        PostToolUse: [{ hooks: [this.toolHook("end")] }],
        PostToolUseFailure: [{ hooks: [this.toolHook("failed")] }],
      },
      stderr: (data) => {
        const io = this.turn?.io ?? this.firstIo;
        io.log(data.trimEnd());
        for (const text of data.split("\n")) if (text.trim().length > 0) this.stderrTail.push(text.trim());
        if (this.stderrTail.length > 5) this.stderrTail.splice(0, this.stderrTail.length - 5);
      },
      ...(operadServer === undefined && initial.mcpServers === undefined
        ? {}
        : {
            mcpServers: {
              ...(operadServer === undefined ? {} : { [OPERAD_SERVER]: operadServer }),
              ...Object.fromEntries(
                Object.entries(initial.mcpServers ?? {}).map(([name, server]) => [
                  name,
                  { type: "stdio" as const, command: server.command, args: [...server.args] },
                ]),
              ),
            },
          }),
      ...(initial.resumeSession !== undefined ? { resume: initial.resumeSession } : {}),
      ...(initial.model !== undefined ? { model: initial.model } : {}),
      ...(initial.effort !== undefined ? { effort: initial.effort } : {}),
      ...(initial.maxTurns !== undefined ? { maxTurns: initial.maxTurns } : {}),
      ...(initial.budgetUsd !== undefined ? { maxBudgetUsd: initial.budgetUsd } : {}),
      spawnClaudeCodeProcess: hooks.spawnClaudeCodeProcess ?? spawnWatched,
    };
  }

  /** The user's own claude, found at start unless a test supplies the spawn. */
  private executable(input: WorkerInput): string {
    if (this.hooks.spawnClaudeCodeProcess !== undefined) return "claude";
    return findClaude(input.command);
  }

  /** Tells a kept worker when the session ends by itself. */
  onEnded(handler: (code: number) => void): void {
    this.endedHandlers.push(handler);
  }

  /** The session the last reply used, as the kept record reports it. */
  currentSession(): string | null {
    return this.sessionId;
  }

  /** The first reply; the query starts here. */
  async first(): Promise<number> {
    return this.runTurn(this.initial, this.firstIo, this.firstCancel, true);
  }

  /** A later reply through the session this worker kept. */
  async next(input: WorkerInput, io: WorkerIo, cancel: AbortSignal): Promise<number> {
    return this.runTurn(input, io, cancel, false);
  }

  private async runTurn(input: WorkerInput, io: WorkerIo, cancel: AbortSignal, first: boolean): Promise<number> {
    if (this.closed || this.broken !== undefined) {
      const message = this.broken ?? "the kept session is closed";
      io.line(failure("model_error", message));
      return EXIT_FAILED;
    }
    const turn = newTurn(input, io, cancel);
    this.turn = turn;
    const onCancel = (): void => {
      turn.cancelled = true;
      this.controller.abort();
    };
    cancel.addEventListener("abort", onCancel, { once: true });
    if (cancel.aborted) onCancel();

    io.onMessage?.((text) => {
      if (this.queue !== undefined) {
        this.queue.push({ ...userMessage(text), priority: "next" as const });
        return;
      }
      const next = (async function* () {
        yield { ...userMessage(text), priority: "next" as const };
      })();
      this.session?.streamInput(next).catch((error: unknown) => {
        io.log(`a message to claude was not delivered: ${error instanceof Error ? error.message : String(error)}`);
      });
    });

    if (first) {
      this.started = true;
      try {
        this.session = query({
          prompt:
            this.queue ??
            ((input.images ?? []).length === 0 && !leadingSlash(input.prompt)
              ? input.prompt
              : (async function* () {
                  yield await userMessageWithImages(input);
                })()),
          options: this.options,
        });
      } catch (error) {
        turn.cancel.removeEventListener("abort", onCancel);
        this.removeSkillPlugin();
        io.line(failure("model_error", error instanceof Error ? error.message : String(error)));
        return EXIT_FAILED;
      }
      this.account = this.session.initializationResult().then(
        (init) => init.account,
        () => undefined,
      );
      this.reading = this.readLoop();
    } else if (this.initLine !== undefined) {
      // The session line and the skill note belong to this reply's own log too.
      io.line({ type: "session", ...this.initLine });
      if (this.sessionSkillNote !== undefined) {
        io.log(this.sessionSkillNote);
        io.line({ type: "log", text: this.sessionSkillNote });
      }
    }

    if (this.queue !== undefined) {
      this.queue.push(await userMessageWithImages(input));
      await turn.done;
    } else {
      await this.reading;
    }
    turn.cancel.removeEventListener("abort", onCancel);

    const outcome = await this.resultOf(turn);
    turn.io.line(outcome.line);
    if (!this.persistent) this.close();
    return outcome.code;
  }

  private resolve(turn: Turn): void {
    if (turn.settled) return;
    turn.settled = true;
    turn.resolveDone();
  }

  private handleMessage(message: SDKMessage): "stop" | undefined {
    const turn = this.turn;
    if (turn === undefined) {
      if (message.type === "system" && message.subtype === "init") {
        this.broken = "claude started a second session while no reply was running";
        this.firstIo.log(`${this.broken}; stopping`);
      }
      return undefined;
    }
    if ("session_id" in message && typeof message.session_id === "string") this.sessionId = message.session_id;
    switch (message.type) {
      case "system":
        if (message.subtype === "init" && turn.final !== undefined) {
          turn.io.log("a second session started after the result; stopping");
          turn.continued = true;
          if (this.persistent) this.broken = "claude went on after its result";
          return this.persistent ? undefined : "stop";
        }
        if (message.subtype === "init") {
          turn.io.log(`claude ${message.claude_code_version}`);
          if (this.sessionSkillNote !== undefined) {
            turn.io.log(this.sessionSkillNote);
            turn.io.line({ type: "log", text: this.sessionSkillNote });
          }
          const line = {
            claudeVersion: message.claude_code_version,
            apiKeySource: message.apiKeySource,
            model: message.model,
          };
          this.initLine = line;
          turn.io.line({ type: "session", ...line });
        }
        break;
      case "stream_event":
        this.streamEvent(turn, message.event);
        break;
      case "assistant": {
        this.flushDelta(turn, true);
        const texts: string[] = [];
        for (const block of message.message.content) {
          if (block.type === "text") texts.push(block.text);
          else if (block.type === "thinking") this.writeEnd(turn, "thinking", block.thinking);
        }
        if (texts.length > 0) this.writeEnd(turn, "text", texts.join(""));

        const id = message.message.id;
        if (this.seenMessages.has(id)) break;
        this.seenMessages.add(id);
        const counts = usageOf(message.message.usage);
        turn.lastUsage = counts;
        const said = messageSummary(
          message.message.content.map((block) => (block.type === "text" ? block.text : "")).join(" "),
        );
        turn.io.line({
          type: "message_end",
          role: "assistant",
          ...(said === undefined ? {} : { text: said }),
          stopReason: message.message.stop_reason,
          usage: counts,
          cost: null,
        });
        break;
      }
      case "rate_limit_event": {
        const info = message.rate_limit_info;
        const rateLimitType = info.rateLimitType ?? null;
        const resetsAt = info.resetsAt ?? null;
        this.writeLine(turn, { type: "rate_limit", status: info.status, rateLimitType, resetsAt });
        if (info.status === "rejected") {
          turn.modelError = {
            kind: "usage_limit",
            message: `usage limit reached${rateLimitType === null ? "" : ` (${rateLimitType})`}`,
            rateLimitType,
            resetsAt,
          };
        }
        break;
      }
      case "result":
        turn.final = message;
        if (this.persistent) this.resolve(turn);
        break;
      default:
        break;
    }
    return undefined;
  }

  private async readLoop(): Promise<void> {
    try {
      reading: for (;;) {
        const session = this.session;
        if (session === undefined) break;
        for await (const message of session) {
          if (this.handleMessage(message) === "stop") break reading;
        }
        break;
      }
    } catch (error) {
      const turn = this.turn;
      if (turn !== undefined && !turn.cancelled) {
        turn.thrown = error instanceof Error ? error.message : String(error);
        if (this.stderrTail.length > 0) turn.thrown = `${turn.thrown}\n${this.stderrTail.join("\n")}`;
      }
    } finally {
      this.queryEnded = true;
      if (this.turn !== undefined) this.resolve(this.turn);
      if (this.persistent && !this.closed) {
        for (const handler of this.endedHandlers.splice(0)) handler(EXIT_FAILED);
      }
    }
  }

  private async resultOf(turn: Turn): Promise<{ readonly line: WorkerResult; readonly code: number }> {
    this.flushDelta(turn, true);
    if (turn.cancelled) {
      return {
        line: {
          type: "result",
          result: "cancelled",
          sessionId: this.sessionId,
          usage: {},
          cost: null,
          finalMessage: null,
          model: null,
        },
        code: EXIT_CANCELLED,
      };
    }
    if (turn.final === undefined) {
      const message = turn.thrown ?? "claude ended without a result";
      return {
        line: {
          ...failure(isSessionMissing(message) ? "session_missing" : "model_error", message),
          sessionId: this.sessionId,
        },
        code: EXIT_FAILED,
      };
    }
    const info = await this.account;
    const quality: CostQuality =
      info?.subscriptionType !== undefined && info.subscriptionType.length > 0 ? "estimated" : "exact";
    const final = turn.final;
    const counts = usageOf(final.usage);
    const text = "result" in final && typeof final.result === "string" ? final.result : null;
    const names = Object.keys(final.modelUsage ?? {});
    const hasModel = names.length > 0;
    const window = claudeContextWindow(turn.input.model ?? names[0]);
    const context =
      turn.lastUsage === undefined
        ? undefined
        : {
            used:
              turn.lastUsage.input +
              turn.lastUsage.cache_read +
              turn.lastUsage.cache_write,
            ...(window === undefined ? {} : { window }),
          };
    const base = {
      type: "result" as const,
      sessionId: final.session_id,
      usage: counts,
      cost: hasModel ? { micros: Math.round(finite(final.total_cost_usd) * 1e6), quality } : null,
      finalMessage: text,
      model: names[0] ?? null,
      ...(context === undefined ? {} : { context }),
    };
    if (turn.continued) {
      return {
        line: {
          ...base,
          result: "failed",
          reason: "model_error",
          message:
            "claude went on after its result: a second session started by itself (something it ran in the background finished); a run is one turn",
        },
        code: EXIT_FAILED,
      };
    }
    const errors =
      "errors" in final && Array.isArray(final.errors)
        ? final.errors.filter((e): e is string => typeof e === "string")
        : [];
    if (final.subtype === "success" && !final.is_error) {
      // A reply with no text and no usage never reached the model, as a local
      // command does. The reason is kept for the chat's failure line.
      const emptyText = text === null || text.trim().length === 0;
      const noUsage =
        !hasModel &&
        counts.input === 0 &&
        counts.output === 0 &&
        counts.cache_read === 0 &&
        counts.cache_write === 0 &&
        finite(final.total_cost_usd) === 0;
      const reason = emptyText && noUsage ? noAnswerReason(final, errors) : undefined;
      return {
        line: { ...base, result: "done", ...(reason === undefined ? {} : { message: reason }) },
        code: 0,
      };
    }
    const message =
      turn.modelError?.message ??
      (errors.length > 0
        ? errors.join("; ")
        : text !== null && text.length > 0
          ? text
          : `claude stopped: ${final.subtype}`);
    const reason: FailureReason = isSessionMissing(message) ? "session_missing" : "model_error";
    return {
      line: {
        ...base,
        result: "failed",
        reason,
        message,
        ...(turn.modelError !== undefined ? { modelError: turn.modelError } : {}),
      },
      code: EXIT_FAILED,
    };
  }

  private flushDelta(turn: Turn, complete: boolean): void {
    if (turn.deltaKind === undefined || turn.deltaText.length === 0) {
      turn.deltaKind = undefined;
      turn.deltaText = "";
      return;
    }
    const kind = turn.deltaKind;
    let text: string;
    if (complete) {
      text = turn.deltaText;
      turn.deltaText = "";
      turn.deltaKind = undefined;
    } else {
      const held = secretPrefixLength(turn.deltaText, this.secrets);
      text = held === 0 ? turn.deltaText : turn.deltaText.slice(0, -held);
      turn.deltaText = held === 0 ? "" : turn.deltaText.slice(-held);
      turn.deltaKind = turn.deltaText.length === 0 ? undefined : kind;
    }
    if (text.length > 0) {
      turn.io.line({ type: kind === "text" ? "text_delta" : "thinking_delta", text: maskSecrets(text, this.secrets) });
    }
  }

  private writeLine(turn: Turn, line: WorkerLine): void {
    this.flushDelta(turn, false);
    turn.io.line(line);
  }

  private addDelta(turn: Turn, kind: StreamKind, text: string): void {
    if (text.length === 0) return;
    const at = this.now();
    if (turn.deltaKind === kind && at - turn.deltaAt < STREAM_GROUP_MS) {
      turn.deltaText += text;
      return;
    }
    this.flushDelta(turn, turn.deltaKind !== kind);
    turn.deltaKind = kind;
    turn.deltaText += text;
    turn.deltaAt = at;
  }

  private streamEvent(turn: Turn, value: unknown): void {
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
        turn.streamBlocks.set(index, { kind: "text", text });
        this.addDelta(turn, "text", text);
      } else if (blockType === "thinking") {
        const text = stringOf(block["thinking"]) ?? "";
        turn.streamBlocks.set(index, { kind: "thinking", text });
        this.addDelta(turn, "thinking", text);
      }
    } else if (type === "content_block_delta") {
      const index = numberOf(event["index"]);
      const block = index === undefined ? undefined : turn.streamBlocks.get(index);
      const delta = recordOf(event["delta"]);
      if (block === undefined || delta === undefined) return;
      const deltaType = stringOf(delta["type"]);
      if (block.kind === "text" && deltaType === "text_delta") {
        const text = stringOf(delta["text"]);
        if (text !== undefined) {
          block.text += text;
          this.addDelta(turn, "text", text);
        }
      } else if (block.kind === "thinking" && deltaType === "thinking_delta") {
        const text = stringOf(delta["thinking"]);
        if (text !== undefined) {
          block.text += text;
          this.addDelta(turn, "thinking", text);
        }
      }
    } else if (type === "content_block_stop") {
      const index = numberOf(event["index"]);
      if (index !== undefined && turn.streamBlocks.delete(index)) this.flushDelta(turn, true);
    }
  }

  private writeEnd(turn: Turn, kind: StreamKind, text: string): void {
    if (text.length === 0) return;
    turn.io.line({ type: kind === "text" ? "text_end" : "thinking_end", text: maskSecrets(text, this.secrets) });
  }

  private readonly canUseTool: CanUseTool = async (toolName, toolInput, options) => {
    const turn = this.turn;
    if (turn === undefined) return { behavior: "deny", message: "no reply is running" };
    const input = turn.input;
    const io = turn.io;
    io.log(`canUseTool ${toolName}`);
    const askHost = io.ask;
    const verdict = await decideAccess(
      turn.profile,
      toolName,
      toolInput,
      input.cwd,
      io.useGrant,
      askHost === undefined
        ? undefined
        : async (question) => {
            if ((input.secretValues ?? []).some((secret) => secret.length > 0 && question.value.includes(secret))) {
              return { decision: "deny", reason: "the call holds a secret value, so nobody is asked about it" };
            }
            const shown = summarizeCall(turn.profile, toolName, toolInput, input.cwd, { secrets: input.secretValues });
            return askHost({ ...question, shown: shown ?? question.value, session: this.sessionId });
          },
    );
    if (verdict.allow) return { behavior: "allow", updatedInput: toolInput };
    if (verdict.stop === true) {
      await new Promise<void>((resolve) => {
        if (this.controller.signal.aborted) resolve();
        this.controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      this.endCall(turn, options.toolUseID, toolName, true, REFUSED_IN_LOG);
      return { behavior: "deny", message: verdict.reason, interrupt: true };
    }
    this.writeLine(turn, { type: "blocked", toolName, reason: REFUSED_IN_LOG });
    this.endCall(turn, options.toolUseID, toolName, true, REFUSED_IN_LOG);
    return { behavior: "deny", message: verdict.reason };
  };

  private deniedByProfile(turn: Turn, name: string, toolInput: unknown): { readonly rule?: string } | undefined {
    const record = typeof toolInput === "object" && toolInput !== null ? (toolInput as Record<string, unknown>) : {};
    const check = checkProfile(turn.profile, name, record, turn.input.cwd);
    if (check.kind !== "refuse") return undefined;
    return check.rule === undefined ? {} : { rule: check.rule };
  }

  // The profile's refusals for the `PreToolUse` hook. A read-only profile asks
  // in `canUseTool` so a person can answer, but with the owner's settings on it
  // is also a refusal that no user allow rule may pass: `{ readOnly: true }`
  // through the same matcher says whether read-only is what stops the call.
  private hookRefusal(turn: Turn, name: string, toolInput: unknown): { readonly reason: string } | undefined {
    const record = typeof toolInput === "object" && toolInput !== null ? (toolInput as Record<string, unknown>) : {};
    const check = checkProfile(turn.profile, name, record, turn.input.cwd);
    if (check.kind === "refuse") return { reason: check.reason };
    if (turn.profile.readOnly === true) {
      const alone = checkProfile({ readOnly: true }, name, record, turn.input.cwd);
      if (alone.kind !== "allow") return { reason: alone.reason };
    }
    return undefined;
  }

  private startCall(turn: Turn, id: string, name: string, toolInput: unknown): void {
    if (turn.open.has(id)) return;
    const startedAt = this.now();
    turn.open.set(id, { name, startedAt });
    const denied = this.deniedByProfile(turn, name, toolInput);
    const summary = denied !== undefined
      ? `${name} denied by the access profile${denied.rule === undefined ? "" : ` (rule: ${denied.rule.replace(/\s+/g, " ").slice(0, 300)})`}`
      : summarizeCall(turn.profile, name, toolInput, turn.input.cwd, {
          secrets: turn.input.secretValues,
          keepLines: true,
        });
    this.writeLine(turn, {
      type: "tool_execution_start",
      toolCallId: id,
      toolName: name,
      at: startedAt,
      ...(summary === undefined ? {} : { input: summary }),
    });
  }

  private endCall(turn: Turn, id: string, name: string, isError: boolean, error?: unknown, output?: unknown): void {
    const call = turn.open.get(id);
    if (call === undefined) return;
    turn.open.delete(id);
    const text = isError ? undefined : toolOutputText(output);
    if (text !== undefined && text.length > 0) {
      for (const part of toolOutputLines(text, this.secrets)) {
        this.writeLine(turn, { type: "tool_output", toolCallId: id, text: part.text });
      }
    }
    const firstLine = isError ? firstErrorLine(error, { secrets: turn.input.secretValues }) : undefined;
    this.writeLine(turn, {
      type: "tool_execution_end",
      toolCallId: id,
      toolName: name,
      isError,
      durationMs: Math.max(0, this.now() - call.startedAt),
      ...(firstLine === undefined ? {} : { error: firstLine }),
    });
  }

  private toolHook(kind: "start" | "end" | "failed"): HookCallback {
    return async (event) => {
      const turn = this.turn;
      if (turn === undefined) return {};
      if (event.hook_event_name === "PreToolUse" && kind === "start") {
        this.startCall(turn, event.tool_use_id, event.tool_name, event.tool_input);
        // A bot that loads the owner's settings may have an allow rule there.
        // The profile is judged first, in this hook, so no such rule can let a
        // call through that it refuses. A grant or an ask is not a refusal and
        // stays with `canUseTool`.
        if (turn.input.useOwnSettings === true) {
          const refusal = this.hookRefusal(turn, event.tool_name, event.tool_input);
          if (refusal !== undefined) {
            this.writeLine(turn, { type: "blocked", toolName: event.tool_name, reason: REFUSED_IN_LOG });
            this.endCall(turn, event.tool_use_id, event.tool_name, true, REFUSED_IN_LOG);
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: refusal.reason,
              },
            };
          }
        }
      } else if (event.hook_event_name === "PostToolUse" && kind === "end") {
        this.endCall(turn, event.tool_use_id, event.tool_name, false, undefined, event.tool_response);
      } else if (event.hook_event_name === "PostToolUseFailure" && kind === "failed") {
        this.endCall(turn, event.tool_use_id, event.tool_name, true, event.error);
      }
      return {};
    };
  }

  private removeSkillPlugin(): void {
    if (this.skillPlugin !== undefined) rmSync(this.skillPlugin.dir, { recursive: true, force: true });
  }

  /** Ends the session and removes what the kept worker mounted. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.session?.close();
    } catch {
      // A session that already ended has nothing left to close.
    }
    this.queue?.close();
    this.removeSkillPlugin();
  }
}

/** Runs one prompt through a session that ends after it, the plain worker path. */
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
  const session = new ClaudeSession(
    { ...input, command: input.command ?? executable },
    io,
    cancel,
    hooks,
    false,
  );
  return session.first();
}

/** Reads one input object; invalid JSON is a parse failure. */
function inputOf(text: string): ReturnType<typeof parseInput> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return { ok: false, message: "the input is not valid JSON" };
  }
  return parseInput(decoded);
}

/** The adapter the shared worker process calls for claude's program. */
function claudeAdapter(hooks: WorkerHooks): WorkerAdapter<WorkerInput> {
  let current: ClaudeSession | undefined;
  let session: string | null = null;
  return {
    parse: (text) => inputOf(text),
    invalidInput: (message) => failure("invalid_input", message),
    error: (message) => failure("model_error", message),
    keep: (input) => input.keep,
    session: () => session,
    setSession: (next) => {
      session = next;
    },
    onEnded: (handler) => current?.onEnded(handler),
    async run(input, io, cancel) {
      if (current !== undefined) {
        const code = await current.next(input, io as WorkerIo, cancel);
        session = current.currentSession();
        return code;
      }
      const started = new ClaudeSession(input, io as WorkerIo, cancel, hooks, input.keep !== undefined);
      current = started;
      const code = await started.first();
      session = started.currentSession();
      return code;
    },
    close: () => {
      current?.close();
      current = undefined;
    },
  };
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
  return serveOne(stdinStream, ports, cancel, claudeAdapter(hooks));
}

/**
 * Runs the first reply from stdin and, when the reply was done and asked for
 * keeping, serves later replies from a socket in the operad home. The same
 * `claude` session serves them too, so neither process starts again.
 */
export async function serveWorkerProcess(
  stdinStream: AsyncIterable<Uint8Array>,
  ports: WorkerPorts,
  cancel: AbortSignal,
  hooks: WorkerHooks = {},
): Promise<number> {
  return serveKeptWorker(stdinStream, ports, cancel, claudeAdapter(hooks));
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
  const code = await serveWorkerProcess(
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
