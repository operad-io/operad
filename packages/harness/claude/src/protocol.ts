/**
 * The wire shapes of the claude child program. `README.md` holds the same
 * tables; `test/protocol.test.ts` checks the program against them.
 */

import { readProfile } from "@operad-io/access-match";
import { isRecord } from "@operad-io/engine";
import { mountedServersOf } from "@operad-io/harness-process";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type WorkerEffort = (typeof EFFORT_LEVELS)[number];

/** What the program reads from stdin. */
export interface WorkerInput {
  readonly prompt: string;
  readonly cwd: string;
  /** The claude command (a name on PATH or a path); unset means `claude`. */
  readonly command?: string | undefined;
  /** A session id from an earlier `Result.sessionId`. */
  readonly resumeSession?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: WorkerEffort | undefined;
  readonly access?: Readonly<Record<string, unknown>> | undefined;
  readonly maxTurns?: number | undefined;
  readonly budgetUsd?: number | undefined;
  /** The longest a Bash call may run in the foreground, in seconds; unset means `DEFAULT_BASH_TIMEOUT_SECS`. */
  readonly bashTimeoutSecs?: number | undefined;
  /** Operad's own tools, served to claude as an MCP server of the named home. */
  readonly operadTools?: { readonly home: string } | undefined;
  /** Other MCP servers to start for the agent, by name (a bot's servers, behind its guard). */
  readonly mcpServers?: Readonly<Record<string, { readonly command: string; readonly args: readonly string[] }>> | undefined;
  /** Secret values of the operad secret store; a log line shows `***` where one appears. */
  readonly secretValues?: readonly string[] | undefined;
}

/** A gate such as a full test run must finish in the foreground; claude's own default is 120 s. */
export const DEFAULT_BASH_TIMEOUT_SECS = 1800;

export interface WorkerUsage {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export type WorkerResultName = "done" | "failed" | "cancelled";

export type FailureReason = "invalid_input" | "session_missing" | "model_error";

/** `estimated` for a subscription login (an API-price figure), `exact` for an API key. */
export type CostQuality = "estimated" | "exact";

/** Set when the run stopped at a rate limit. */
export interface WorkerModelError {
  readonly kind: "usage_limit";
  readonly message: string;
  readonly rateLimitType: string | null;
  readonly resetsAt: number | null;
}

/** The last line of stdout. */
export interface WorkerResult {
  readonly type: "result";
  readonly result: WorkerResultName;
  readonly sessionId: string | null;
  readonly usage: WorkerUsage;
  readonly cost: { readonly micros: number; readonly quality: CostQuality } | null;
  readonly finalMessage: string | null;
  /** The model that did the work: the first key of the result's `modelUsage`. */
  readonly model: string | null;
  readonly reason?: FailureReason;
  readonly message?: string;
  readonly modelError?: WorkerModelError;
}

export type WorkerLine =
  /**
   * Written once, when claude starts a session. `apiKeySource` says which
   * credential claude uses: `none` for a subscription login, `ANTHROPIC_API_KEY`
   * when that environment variable is set.
   */
  | {
      readonly type: "session";
      readonly claudeVersion: string;
      readonly apiKeySource: string;
      readonly model: string;
    }
  | {
      readonly type: "message_end";
      readonly role: "assistant";
      /** The first 300 characters of the message's text, one paragraph; absent when it has none. */
      readonly text?: string;
      readonly stopReason: string | null;
      readonly usage: Required<WorkerUsage>;
      readonly cost: null;
    }
  | {
      readonly type: "tool_execution_start";
      readonly toolCallId: string;
      readonly toolName: string;
      /** When the call started, in epoch milliseconds. */
      readonly at: number;
      /** What ran: the command (500 characters), the path, or the main argument; absent when there is none. */
      readonly input?: string;
    }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly isError: boolean;
      /** How long the call took. */
      readonly durationMs: number;
      /** The first line of the error, when the call failed. */
      readonly error?: string;
    }
  | { readonly type: "blocked"; readonly toolName: string; readonly reason: string }
  | {
      readonly type: "rate_limit";
      readonly status: string;
      readonly rateLimitType: string | null;
      readonly resetsAt: number | null;
    }
  /**
   * The program asks to use up a one-time permission before it lets a call
   * through. The host writes the fact and answers on stdin with a
   * `GrantAck` line; only `used: true` lets the call run.
   */
  | { readonly type: "grant_use"; readonly id: number; readonly waitId: string }
  /**
   * The program asks a person whether one call may run (the access profile's
   * `askCommands`) and holds the call until the host answers with an `AskAck`
   * line. `session` is what a late answer continues. `ask_resolved` follows
   * the answer, so the host knows the question is closed.
   */
  | {
      readonly type: "ask_call";
      readonly id: number;
      readonly kind: "command" | "path";
      readonly value: string;
      readonly tool?: string;
      readonly shown: string;
      readonly session: string | null;
    }
  | { readonly type: "ask_resolved"; readonly id: number }
  | WorkerResult;

/** A stdin line after the input: the host's answer to a `grant_use` line. */
export interface GrantAck {
  readonly type: "grant_ack";
  readonly id: number;
  readonly used: boolean;
}

/**
 * A stdin line after the input: the host's answer to an `ask_call` line.
 * `allow` lets this one call run; `deny` refuses it; `stop` means the wait
 * ended and the program is about to be ended: it holds the call.
 */
export interface AskAck {
  readonly type: "ask_ack";
  readonly id: number;
  readonly decision: "allow" | "deny" | "stop";
  readonly reason?: string;
}

export type ParsedInput =
  | { readonly ok: true; readonly input: WorkerInput }
  | { readonly ok: false; readonly message: string };

/** The stdin fields, in the order the README lists them. */
export const INPUT_FIELDS = [
  "prompt",
  "cwd",
  "command",
  "resumeSession",
  "model",
  "effort",
  "access",
  "maxTurns",
  "budgetUsd",
  "bashTimeoutSecs",
  "operadTools",
  "mcpServers",
  "secretValues",
] as const;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates the decoded stdin object; the message names the field at fault. */
export function parseInput(value: unknown): ParsedInput {
  if (!isRecord(value)) return { ok: false, message: "the input must be a JSON object" };

  // A field the program does not know is refused, never ignored: a flag that
  // is silently dropped would hide a wrong model.
  for (const key of Object.keys(value)) {
    if (!(INPUT_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, message: `${key} is not an input field` };
    }
  }

  const text = (field: "prompt" | "cwd" | "command" | "resumeSession" | "model", required: boolean): string | undefined | Error => {
    const got = value[field];
    if (got === undefined) return required ? new Error(`${field} is required`) : undefined;
    if (typeof got !== "string" || got.length === 0) return new Error(`${field} must be a non-empty string`);
    return got;
  };
  const prompt = text("prompt", true);
  if (prompt instanceof Error) return { ok: false, message: prompt.message };
  const cwd = text("cwd", true);
  if (cwd instanceof Error) return { ok: false, message: cwd.message };
  const command = text("command", false);
  if (command instanceof Error) return { ok: false, message: command.message };
  const resumeSession = text("resumeSession", false);
  if (resumeSession instanceof Error) return { ok: false, message: resumeSession.message };
  if (resumeSession !== undefined && !SESSION_ID.test(resumeSession)) {
    return { ok: false, message: "resumeSession must be a session id (a UUID)" };
  }
  const model = text("model", false);
  if (model instanceof Error) return { ok: false, message: model.message };

  const level = value["effort"];
  let effort: WorkerEffort | undefined;
  if (level !== undefined) {
    const known = EFFORT_LEVELS.find((candidate) => candidate === level);
    if (known === undefined) {
      return { ok: false, message: `effort must be one of ${EFFORT_LEVELS.join(", ")}` };
    }
    effort = known;
  }

  const secretValues = value["secretValues"];
  if (secretValues !== undefined && (!Array.isArray(secretValues) || !secretValues.every((v): v is string => typeof v === "string"))) {
    return { ok: false, message: "secretValues must be an array of strings" };
  }

  const maxTurns = value["maxTurns"];
  if (maxTurns !== undefined && (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1)) {
    return { ok: false, message: "maxTurns must be a positive integer" };
  }
  const budgetUsd = value["budgetUsd"];
  if (budgetUsd !== undefined && (typeof budgetUsd !== "number" || !Number.isFinite(budgetUsd) || budgetUsd <= 0)) {
    return { ok: false, message: "budgetUsd must be a positive number" };
  }

  const bashTimeoutSecs = value["bashTimeoutSecs"];
  if (
    bashTimeoutSecs !== undefined &&
    (typeof bashTimeoutSecs !== "number" || !Number.isInteger(bashTimeoutSecs) || bashTimeoutSecs < 1)
  ) {
    return { ok: false, message: "bashTimeoutSecs must be a positive integer" };
  }

  const operadTools = value["operadTools"];
  if (operadTools !== undefined && (!isRecord(operadTools) || typeof operadTools["home"] !== "string" || operadTools["home"].length === 0)) {
    return { ok: false, message: "operadTools must be an object with a home" };
  }

  const mcpServers = mountedServersOf(value["mcpServers"]);
  if (value["mcpServers"] !== undefined && (!isRecord(value["mcpServers"]) || (Object.keys(value["mcpServers"]).length > 0 && mcpServers === undefined))) {
    return { ok: false, message: "mcpServers must be an object of servers, each with a command" };
  }

  const access = value["access"];
  if (access !== undefined && !isRecord(access)) {
    return { ok: false, message: "access must be an object" };
  }
  if (access !== undefined) {
    const profile = readProfile(access);
    if (!profile.ok) return { ok: false, message: `access.${profile.message}` };
  }

  return {
    ok: true,
    input: {
      prompt: prompt ?? "",
      cwd: cwd ?? "",
      command,
      resumeSession,
      model,
      effort,
      access,
      maxTurns,
      budgetUsd,
      bashTimeoutSecs,
      operadTools: operadTools === undefined ? undefined : { home: String(operadTools["home"]) },
      mcpServers,
      secretValues,
    },
  };
}
