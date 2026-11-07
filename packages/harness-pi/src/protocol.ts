/**
 * The wire shapes of the pi child program. `README.md` holds the same tables;
 * `test/protocol.test.ts` checks the program against them.
 */

import { readProfile } from "@operad-io/access-match";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type WorkerThinkingLevel = (typeof THINKING_LEVELS)[number];

/** What the program reads from stdin. */
export interface WorkerInput {
  readonly prompt: string;
  readonly cwd: string;
  readonly authPath: string;
  readonly modelsPath: string;
  readonly agentDir: string;
  /** The pi command (a name on PATH or a path); unset means `pi`. */
  readonly piCommand?: string | undefined;
  readonly sessionDir: string;
  readonly resumeSession?: string | undefined;
  readonly model?: string | undefined;
  readonly thinkingLevel?: WorkerThinkingLevel | undefined;
  readonly access?: Readonly<Record<string, unknown>> | undefined;
}

export interface WorkerUsage {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export type WorkerResultName = "done" | "failed" | "cancelled";

export type FailureReason = "invalid_input" | "session_missing" | "model_missing" | "model_error";

/** The last line of stdout. */
export interface WorkerResult {
  readonly type: "result";
  readonly result: WorkerResultName;
  readonly sessionId: string | null;
  readonly usage: WorkerUsage;
  /** The priced part of the run; `incomplete` when some message had no price. */
  readonly cost: { readonly micros: number; readonly incomplete?: true } | null;
  readonly finalMessage: string | null;
  readonly reason?: FailureReason;
  readonly message?: string;
}

export type WorkerLine =
  | {
      readonly type: "message_end";
      readonly role: "assistant";
      readonly stopReason: string;
      readonly usage: Required<WorkerUsage>;
      readonly cost: { readonly total: number } | null;
    }
  | { readonly type: "tool_execution_start"; readonly toolCallId: string; readonly toolName: string }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly isError: boolean;
    }
  | { readonly type: "blocked"; readonly toolName: string; readonly reason: string }
  /**
   * The program asks to use up a one-time permission before it lets a call
   * through. The host writes the fact and answers on stdin with a
   * `GrantAck` line; only `used: true` lets the call run.
   */
  | { readonly type: "grant_use"; readonly id: number; readonly waitId: string }
  | { readonly type: "agent_settled"; readonly aborted: boolean }
  | WorkerResult;

/** A stdin line after the input: the host's answer to a `grant_use` line. */
export interface GrantAck {
  readonly type: "grant_ack";
  readonly id: number;
  readonly used: boolean;
}

export type ParsedInput =
  | { readonly ok: true; readonly input: WorkerInput }
  | { readonly ok: false; readonly message: string };

const REQUIRED_STRINGS = ["prompt", "cwd", "authPath", "modelsPath", "agentDir", "sessionDir"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the decoded stdin object; the message names the field at fault. */
export function parseInput(value: unknown): ParsedInput {
  if (!isRecord(value)) return { ok: false, message: "the input must be a JSON object" };

  const strings: Record<string, string> = {};
  for (const field of REQUIRED_STRINGS) {
    const field_ = value[field];
    if (field_ === undefined) return { ok: false, message: `${field} is required` };
    if (typeof field_ !== "string" || field_.length === 0) {
      return { ok: false, message: `${field} must be a non-empty string` };
    }
    strings[field] = field_;
  }

  const optional = (field: "resumeSession" | "model" | "piCommand"): string | undefined | Error => {
    const field_ = value[field];
    if (field_ === undefined) return undefined;
    if (typeof field_ !== "string" || field_.length === 0) {
      return new Error(`${field} must be a non-empty string`);
    }
    return field_;
  };
  const resumeSession = optional("resumeSession");
  if (resumeSession instanceof Error) return { ok: false, message: resumeSession.message };
  const piCommand = optional("piCommand");
  if (piCommand instanceof Error) return { ok: false, message: piCommand.message };
  const model = optional("model");
  if (model instanceof Error) return { ok: false, message: model.message };
  if (model !== undefined && !/^[^/]+\/.+$/.test(model)) {
    return { ok: false, message: "model must look like provider/id" };
  }

  const level = value["thinkingLevel"];
  let thinkingLevel: WorkerThinkingLevel | undefined;
  if (level !== undefined) {
    const known = THINKING_LEVELS.find((candidate) => candidate === level);
    if (known === undefined) {
      return { ok: false, message: `thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}` };
    }
    thinkingLevel = known;
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
      prompt: strings["prompt"] ?? "",
      cwd: strings["cwd"] ?? "",
      authPath: strings["authPath"] ?? "",
      modelsPath: strings["modelsPath"] ?? "",
      agentDir: strings["agentDir"] ?? "",
      sessionDir: strings["sessionDir"] ?? "",
      resumeSession,
      piCommand,
      model,
      thinkingLevel,
      access,
    },
  };
}
