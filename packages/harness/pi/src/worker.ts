/**
 * The pi child program (ADR 0023 D2, D3, D5, D6).
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
  type Verdict,
} from "@operad-io/access-match";
import type {
  AgentSessionEvent,
  DefaultResourceLoader as PiResourceLoader,
  ExtensionFactory,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { openMcpTools, type McpTools } from "@operad-io/mcp";
import {
  EXIT_CANCELLED,
  EXIT_FAILED,
  EXIT_INVALID_INPUT,
  maskSecrets,
  readGivenSkills,
  readImage,
  serveKeptWorker,
  serveOne,
  toolOutputLines,
  type CallAnswer,
  type WorkerAdapter,
  type WorkerIo as SharedWorkerIo,
  type WorkerPorts,
} from "@operad-io/harness-process";
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

export { EXIT_CANCELLED, EXIT_FAILED, EXIT_INVALID_INPUT };

/** Where the program writes. Lines are written whole, in order. */
export type WorkerIo = SharedWorkerIo<WorkerLine>;

/** What a run gives pi's settings and resource loader; the tests inspect it. */
export interface SeenResources {
  readonly settings: {
    readonly compaction: boolean;
    readonly retry: boolean;
  };
  readonly loader: {
    readonly cwd: string;
    readonly agentDir: string;
    readonly noExtensions: boolean | undefined;
    readonly noSkills: boolean | undefined;
    readonly noPromptTemplates: boolean | undefined;
    readonly noThemes: boolean | undefined;
    readonly noContextFiles: boolean | undefined;
    readonly additionalSkillPaths: readonly string[] | undefined;
    readonly hasSkillsOverride: boolean;
    readonly extensions: readonly string[];
  };
}

export interface WorkerHooks {
  /** Registers extra model providers; the tests use it for the fake model. */
  registerProviders?(runtime: ModelRuntime): void;
  /** The clock for tool call times, in epoch milliseconds; the tests inject one. */
  now?: () => number;
  /** Sees the settings and loader options of one run; the tests use it. */
  observeResources?(seen: SeenResources): void;
}

/** The text of an assistant message, thinking and tool calls left out. */
function textOf(content: unknown, join = " "): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) =>
      typeof block === "object" && block !== null && Reflect.get(block, "type") === "text"
        ? String(Reflect.get(block, "text") ?? "")
        : "",
    )
    .join(join);
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
  lastUsage: Required<WorkerUsage> | undefined;

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
    this.lastUsage = counts;
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

/** How often one stream writes an increment line at most, in milliseconds. */
const FLUSH_MS = 100;

/** The spellings `maskSecrets` masks for one value: the value and, if it differs, its JSON text. */
function spellingsOf(secret: string): readonly string[] {
  if (secret.length === 0) return [];
  const escaped = JSON.stringify(secret).slice(1, -1);
  return escaped === secret ? [secret] : [secret, escaped];
}

/**
 * Splits an increment so that no line ends inside a secret: the longest suffix
 * of `text` that is a proper prefix of a secret value is held back and joined
 * to the next increment, where the completed secret is masked. A secret that
 * is wholly in the emitted part is masked there. Both the value as written and
 * its JSON-escaped spelling count, as `maskSecrets` masks both.
 */
function splitSecretPrefix(
  text: string,
  secrets: readonly string[],
): { readonly emit: string; readonly held: string } {
  let held = 0;
  for (const secret of secrets.flatMap(spellingsOf)) {
    const longest = Math.min(secret.length - 1, text.length);
    for (let length = longest; length > held; length -= 1) {
      if (text.endsWith(secret.slice(0, length))) {
        held = length;
        break;
      }
    }
  }
  if (held === 0) return { emit: text, held: "" };
  return { emit: text.slice(0, text.length - held), held: text.slice(text.length - held) };
}

/**
 * Assistant text and thinking as they stream. A line carries the new text
 * only, and each stream writes at most one per `FLUSH_MS`: a message that
 * arrives faster is grouped. The tail that is still buffered when a block or a
 * message ends is left to the full line that follows (`text_end`,
 * `thinking_end`), so no increment goes out closer than `FLUSH_MS` to the one
 * before it. Secret values are masked in every line.
 */
class Increments {
  #text = "";
  #thinking = "";
  #textAt: number | undefined;
  #thinkingAt: number | undefined;

  constructor(
    private readonly io: WorkerIo,
    private readonly now: () => number,
    private readonly secrets: readonly string[],
  ) {}

  text(delta: string): void {
    if (delta.length === 0) return;
    this.#text += delta;
    const at = this.now();
    if (this.#textAt === undefined || at - this.#textAt >= FLUSH_MS) this.#writeText(at);
  }

  thinking(delta: string): void {
    if (delta.length === 0) return;
    this.#thinking += delta;
    const at = this.now();
    if (this.#thinkingAt === undefined || at - this.#thinkingAt >= FLUSH_MS) this.#writeThinking(at);
  }

  #writeText(at: number): void {
    const { emit, held } = splitSecretPrefix(this.#text, this.secrets);
    if (emit.length > 0) {
      this.io.line({ type: "text_delta", text: maskSecrets(emit, this.secrets) });
    }
    this.#text = held;
    this.#textAt = at;
  }

  #writeThinking(at: number): void {
    const { emit, held } = splitSecretPrefix(this.#thinking, this.secrets);
    if (emit.length > 0) {
      this.io.line({ type: "thinking_delta", text: maskSecrets(emit, this.secrets) });
    }
    this.#thinking = held;
    this.#thinkingAt = at;
  }

  /** A thinking block finished: its full text follows the increments. */
  endThinking(text: string): void {
    this.#thinking = "";
    this.#thinkingAt = undefined;
    if (text.length > 0) this.io.line({ type: "thinking_end", text: maskSecrets(text, this.secrets) });
  }

  /** An assistant message finished: its full text follows the increments. */
  endMessage(text: string): void {
    if (text.length > 0) {
      this.#text = "";
      this.#textAt = undefined;
      this.io.line({ type: "text_end", text: maskSecrets(text, this.secrets) });
    } else if (this.#text.length > 0) {
      this.#writeText(this.now());
    }
    // A thinking block that ended wrote its own full text; anything left is
    // a block the run stopped in, and the increments are all it has.
    if (this.#thinking.length > 0) this.#writeThinking(this.now());
  }

  /**
   * The stream is ending and no later text can complete a held prefix: write
   * it now, masked when it holds a whole secret. Every end path calls this
   * before its Result, so a stopped reply keeps what it had reached.
   */
  release(): void {
    if (this.#text.length > 0) {
      this.io.line({ type: "text_delta", text: maskSecrets(this.#text, this.secrets) });
      this.#text = "";
      this.#textAt = undefined;
    }
    if (this.#thinking.length > 0) {
      this.io.line({ type: "thinking_delta", text: maskSecrets(this.#thinking, this.secrets) });
      this.#thinking = "";
      this.#thinkingAt = undefined;
    }
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

  // A line for the step log and for the free-text stderr: a skill that cannot
  // be used is skipped, never a failed run.
  const note = (text: string): void => {
    io.log(text);
    io.line({ type: "log", text });
  };
  const given = readGivenSkills(input.skills ?? []);
  for (const skip of given.skipped) note(`skill ${skip.path}: ${skip.reason}`);

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
  const {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    getAgentDir,
    loadSkills,
  } = pi;

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
  const ownSettings = input.useOwnSettings === true;
  // Operad's own tools, by the names they take in pi; they are not the owner's
  // to override and the profile leaves them to the MCP allow lists.
  const operadToolNames = new Set<string>();
  // The fields the access matcher reads for pi's own tools. A tool it cannot
  // place is refused while a rule is set: an extension's tool would otherwise
  // run a command or touch a path the profile never saw.
  const TOOL_FIELDS: Readonly<Record<string, { readonly field: "command" | "path"; readonly required: boolean }>> = {
    bash: { field: "command", required: true },
    read: { field: "path", required: true },
    write: { field: "path", required: true },
    edit: { field: "path", required: true },
    grep: { field: "path", required: false },
    find: { field: "path", required: false },
    ls: { field: "path", required: false },
  };
  const hasProfileRules = (candidate: AccessProfile): boolean =>
    (candidate.denyPaths ?? []).length > 0 ||
    (candidate.denyCommands ?? []).length > 0 ||
    (candidate.askCommands ?? []).length > 0 ||
    (candidate.askPaths ?? []).length > 0 ||
    candidate.readOnly === true ||
    (candidate.level !== undefined && candidate.level !== "full");
  const judge = (name: string, toolInput: Readonly<Record<string, unknown>>): Verdict => {
    if (operadToolNames.has(name)) return { allow: true };
    const row = TOOL_FIELDS[name];
    if (row === undefined) {
      return ownSettings && hasProfileRules(profile)
        ? {
            allow: false,
            reason: `tool "${name}" is not one the access profile can check; it is refused while the profile has rules`,
          }
        : { allow: true };
    }
    const value = row.field === "command" ? toolInput["command"] : toolInput["path"] ?? toolInput["file_path"];
    if (ownSettings && row.required && (typeof value !== "string" || value.length === 0) && hasProfileRules(profile)) {
      return {
        allow: false,
        reason: `tool "${name}" has no ${row.field}; it is refused while the profile has rules`,
      };
    }
    return match(profile, { tool: name, input: toolInput, cwd: input.cwd });
  };
  // What a late answer continues; known once the session exists.
  let sessionFile: string | null = null;
  const operadExtension: ExtensionFactory = (pi) => {
    pi.on("tool_call", async (event) => {
      io.log(`tool_call ${event.toolName}`);
      if (event.toolName === "bash") {
        // The timeout kills the command; pi gives the model a tool error and the run goes on.
        const bounded = boundedTimeout(Reflect.get(event.input, "timeout"), bashTimeoutSecs);
        if (bounded !== undefined) Reflect.set(event.input, "timeout", bounded);
      }
      const verdict = judge(event.toolName, event.input);
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
      // A call the profile says must ask goes to a person. A deny wins over an
      // ask, so a call that was denied never gets here with `ask`.
      let reason = verdict.reason;
      if (verdict.ask === true && io.ask !== undefined) {
        let answer: CallAnswer;
        if ((input.secretValues ?? []).some((secret) => secret.length > 0 && verdict.value.includes(secret))) {
          // A value that holds a secret is never asked about: no fact may hold it.
          answer = { decision: "deny", reason: "the call holds a secret value, so nobody is asked about it" };
        } else {
          const shown = summarizeCall(profile, event.toolName, event.input, input.cwd, { secrets: input.secretValues });
          try {
            answer = await io.ask({ kind: verdict.kind, value: verdict.value, ...(verdict.tool === undefined ? {} : { tool: verdict.tool }), shown: shown ?? verdict.value, session: sessionFile });
          } catch {
            answer = { decision: "deny", reason: "the question could not be asked" };
          }
        }
        if (answer.decision === "allow") return undefined;
        if (answer.decision === "stop") {
          // The wait ended: the host ends this program next. Hold the call until it does.
          await new Promise<void>((resolve) => {
            if (cancel.aborted) resolve();
            cancel.addEventListener("abort", () => resolve(), { once: true });
          });
          reason = "waiting for an answer";
        } else {
          reason = `${verdict.reason}; ${answer.reason ?? "a person refused it"}`;
        }
      }
      blockedCalls.add(event.toolCallId);
      io.line({ type: "blocked", toolName: event.toolName, reason: REFUSED_IN_LOG });
      return { block: true, reason };
    });
  };

  // With the switch off the child is exactly the one it always was. With it
  // on, pi's own settings and resources load from the owner's pi directory;
  // the project is not trusted here, so only the owner's user layer and the
  // context files pi finds from the working directory load.
  const ownerAgentDir = ownSettings ? getAgentDir() : undefined;
  const settingsManager =
    ownerAgentDir === undefined
      ? SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
        })
      : SettingsManager.create(input.cwd, ownerAgentDir, { projectTrusted: false });
  const givenSkills =
    ownerAgentDir === undefined || given.skills.length === 0
      ? undefined
      : loadSkills({
          cwd: input.cwd,
          agentDir: ownerAgentDir,
          skillPaths: given.skills.map((skill) => skill.path),
          includeDefaults: false,
        });
  const extensionFactories = [{ name: "operad", factory: operadExtension, hidden: true }];
  type LoaderOptions = ConstructorParameters<typeof PiResourceLoader>[0];
  const loaderOptions: LoaderOptions =
    ownerAgentDir === undefined
      ? {
          cwd: input.cwd,
          agentDir: input.agentDir,
          settingsManager,
          noExtensions: true,
          // No discovery: the only skills are the directories this step gave.
          noSkills: true,
          ...(given.skills.length === 0 ? {} : { additionalSkillPaths: given.skills.map((skill) => skill.path) }),
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          extensionFactories,
        }
      : {
          cwd: input.cwd,
          agentDir: ownerAgentDir,
          settingsManager,
          extensionFactories,
          // A skill the bot lists wins a name clash with the owner's.
          ...(givenSkills === undefined
            ? {}
            : {
                skillsOverride: (base) => {
                  const names = new Set(givenSkills.skills.map((skill) => skill.name));
                  return {
                    skills: [...givenSkills.skills, ...base.skills.filter((skill) => !names.has(skill.name))],
                    diagnostics: [...givenSkills.diagnostics, ...base.diagnostics],
                  };
                },
              }),
        };
  const resourceLoader = new DefaultResourceLoader(loaderOptions);
  await resourceLoader.reload();
  // A chat's compaction and retry are operad's, not the owner's settings'.
  settingsManager.applyOverrides({ compaction: { enabled: false }, retry: { enabled: false } });
  const isolation = ownerAgentDir === undefined;
  hooks.observeResources?.({
    settings: {
      compaction: settingsManager.getCompactionEnabled(),
      retry: settingsManager.getRetryEnabled(),
    },
    loader: {
      cwd: loaderOptions.cwd,
      agentDir: loaderOptions.agentDir,
      noExtensions: isolation ? true : undefined,
      noSkills: isolation ? true : undefined,
      noPromptTemplates: isolation ? true : undefined,
      noThemes: isolation ? true : undefined,
      noContextFiles: isolation ? true : undefined,
      additionalSkillPaths:
        isolation && given.skills.length > 0 ? given.skills.map((skill) => skill.path) : undefined,
      hasSkillsOverride: !isolation && givenSkills !== undefined,
      extensions: extensionFactories.map((entry) => entry.name),
    },
  });
  if ((input.skills ?? []).length > 0) {
    const names = resourceLoader.getSkills().skills.map((skill) => skill.name);
    note(`skills: ${names.length === 0 ? "none" : names.join(", ")}`);
  }

  // Operad's tools, as pi's own custom tools; each call runs against the home.
  let operad: McpTools | undefined;
  if (input.operadTools !== undefined) {
    operad = await openMcpTools({
      home: input.operadTools.home,
      cwd: input.cwd,
      onLog: (message) => io.log(message),
    });
  }
  const mcp = operad;
  const customTools =
    mcp === undefined
      ? undefined
      : mcp.tools.map((tool) => {
          const name = `operad_${tool.name}`;
          operadToolNames.add(name);
          return {
            name,
            label: `operad ${tool.name}`,
            description: tool.description,
            // The same JSON Schema the MCP server states; pi checks arguments against it.
            parameters: { ...tool.inputSchema },
            async execute(_id: string, params: Record<string, unknown>) {
              const outcome = await mcp.call(tool.name, params);
              const text = outcome.content.map((block) => block.text).join("\n");
              if (outcome.isError === true) throw new Error(text);
              return { content: [{ type: "text" as const, text }], details: outcome.structuredContent ?? {} };
            },
          };
        });

  const { session } = await createAgentSession({
    ...(customTools === undefined ? {} : { customTools }),
    cwd: input.cwd,
    agentDir: input.agentDir,
    modelRuntime: runtime,
    resourceLoader,
    sessionManager,
    settingsManager,
    ...(model !== undefined ? { model } : {}),
    ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
  });

  sessionFile = session.sessionFile ?? null;
  const tally = new Tally();
  const now = hooks.now ?? Date.now;
  const increments = new Increments(io, now, input.secretValues ?? []);
  const started = new Map<string, number>();
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  session.subscribe((event) => {
    switch (event.type) {
      case "message_update": {
        const update = event.assistantMessageEvent;
        switch (update.type) {
          case "text_delta":
            increments.text(update.delta);
            break;
          case "thinking_delta":
            increments.thinking(update.delta);
            break;
          case "thinking_end":
            increments.endThinking(update.content);
            break;
          default:
            break;
        }
        break;
      }
      case "message_end": {
        if (event.message.role === "assistant") increments.endMessage(textOf(event.message.content, ""));
        const line = tally.add(event.message);
        if (line !== undefined) io.line(line);
        break;
      }
      case "tool_execution_start": {
        const startedAt = now();
        started.set(event.toolCallId, startedAt);
        const summary = summarizeCall(profile, event.toolName, event.args, input.cwd, { secrets: input.secretValues, keepLines: true });
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
        const blocked = blockedCalls.has(event.toolCallId);
        const content =
          typeof event.result === "object" && event.result !== null
            ? Reflect.get(event.result, "content")
            : event.result;
        // A refused call printed nothing; its result is the refusal the model
        // already gets, and only the end line names it.
        if (!blocked) {
          const output = textOf(content, "");
          if (output.length > 0) {
            for (const part of toolOutputLines(output, input.secretValues ?? [])) {
              io.line({ type: "tool_output", toolCallId: event.toolCallId, text: part.text });
            }
          }
        }
        const firstLine = blocked
          ? REFUSED_IN_LOG
          : event.isError
            ? firstErrorLine(textOf(content), { secrets: input.secretValues })
            : undefined;
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
    ...(tally.lastUsage === undefined
      ? {}
      : {
          context: {
            used:
              tally.lastUsage.input +
              tally.lastUsage.cache_read +
              tally.lastUsage.cache_write,
            ...(model?.contextWindow !== undefined && model.contextWindow > 0
              ? { window: model.contextWindow }
              : {}),
          },
        }),
  });

  // Every way this run ends writes its Result here: text still held back as a
  // possible secret prefix is released first.
  const finish = (line: WorkerResult, code: number): number => {
    increments.release();
    io.line(line);
    return code;
  };

  // A message the host sends mid-run steers the agent: pi delivers it after
  // the tool call that is running.
  io.onMessage?.((text) => {
    io.log("a message from the host is given to pi");
    session.prompt(text, { streamingBehavior: "steer", expandPromptTemplates: false }).catch((error: unknown) => {
      io.log(`a message to pi was not delivered: ${error instanceof Error ? error.message : String(error)}`);
    });
  });

  let cancelled = cancel.aborted;
  const onCancel = (): void => {
    cancelled = true;
    void session.abort();
  };
  cancel.addEventListener("abort", onCancel, { once: true });

  // The session is ready and the prompt is about to go to the model.
  io.line({
    type: "session",
    sessionId: session.sessionFile ?? null,
    ...(input.model === undefined ? {} : { model: input.model }),
  });

  try {
    if (!cancelled) {
      try {
        const images = await Promise.all((input.images ?? []).map((image) => readImage(image)));
        // The prompt is operad's text, not a line at pi's terminal: a leading
        // `/` is never one of pi's commands or a prompt template.
        await session.prompt(input.prompt, {
          expandPromptTemplates: false,
          ...(images.length === 0
            ? {}
            : { images: images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mediaType })) }),
        });
      } catch (error) {
        if (!cancelled) {
          return finish(
            {
              ...failure("model_error", error instanceof Error ? error.message : String(error)),
              sessionId: session.sessionFile ?? null,
              usage: tally.usage,
              cost: tally.cost,
            },
            EXIT_FAILED,
          );
        }
      }
      if (!cancelled) await settled;
    }
    if (cancelled) {
      await session.abort();
      return finish(result("cancelled"), EXIT_CANCELLED);
    }
    if (tally.lastError !== undefined) {
      return finish(
        {
          ...failure("model_error", tally.lastError),
          sessionId: session.sessionFile ?? null,
          usage: tally.usage,
          cost: tally.cost,
          finalMessage: session.getLastAssistantText() ?? null,
        },
        EXIT_FAILED,
      );
    }
    return finish(result("done"), 0);
  } finally {
    cancel.removeEventListener("abort", onCancel);
    session.dispose();
  }
}

/** The adapter the shared worker process calls for pi's program. */
function piAdapter(hooks: WorkerHooks): WorkerAdapter<WorkerInput> {
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
    run: (input, io, cancel) => runWorker(input, io as WorkerIo, cancel, hooks),
  };
}

/** Reads the input of one reply; invalid JSON is a parse failure. */
function inputOf(text: string): ReturnType<typeof parseInput> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return { ok: false, message: "the input is not valid JSON" };
  }
  return parseInput(decoded);
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
  return serveOne(stdinStream, ports, cancel, piAdapter(hooks));
}

/**
 * Runs the first reply from stdin and, when the reply was done and asked for
 * keeping, serves later replies from a socket in the operad home. The worker's
 * own timer ends it after the kept time; a failed, stopped or interrupted reply
 * leaves no kept worker.
 */
export async function serveWorkerProcess(
  stdinStream: AsyncIterable<Uint8Array>,
  ports: WorkerPorts,
  cancel: AbortSignal,
  hooks: WorkerHooks = {},
): Promise<number> {
  return serveKeptWorker(stdinStream, ports, cancel, piAdapter(hooks));
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

  // pi runs bash non-interactively (`bash -c`): no aliases or functions from the
  // user's rc files. BASH_ENV and ENV are the two ways a non-interactive shell
  // is made to read a file, so the agent's shell does not get them.
  delete process.env["BASH_ENV"];
  delete process.env["ENV"];

  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  process.stdout.on("error", () => undefined);
  process.stderr.on("error", () => undefined);
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
