/**
 * The wire shapes of the claude child program. `README.md` holds the same
 * tables; `test/heavy/protocol.test.ts` checks the program against them.
 */

import {
  mountedServersOf,
  readAccess,
  readBoolean,
  readImages,
  readKeep,
  readOperadTools,
  readOptionalString,
  readPositiveInteger,
  readPositiveNumber,
  readRequiredStrings,
  readSecrets,
  readStringList,
  readUnknownFields,
  type ImageInput,
  type SharedLine,
  type WorkerKeep,
  type WorkerResultName,
  type WorkerUsage,
} from "@operad-io/harness-process";
import { isRecord, type CostQuality } from "@operad-io/engine";

export type { AskAck, GrantAck, WorkerResultName, WorkerUsage } from "@operad-io/harness-process";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type WorkerEffort = (typeof EFFORT_LEVELS)[number];

/** The context window of each model the plugin lists, in tokens. */
export const CLAUDE_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  opus: 200_000,
  sonnet: 200_000,
  haiku: 200_000,
  "opus[1m]": 1_000_000,
  "sonnet[1m]": 1_000_000,
};

/** The context window a model name names, when claude's list knows it. */
export function claudeContextWindow(model: string | null | undefined): number | undefined {
  if (model === null || model === undefined) return undefined;
  return CLAUDE_CONTEXT_WINDOWS[model.toLowerCase()];
}

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
  /** Images sent with the prompt, read from these files. */
  readonly images?: readonly ImageInput[] | undefined;
  /** Skill directories to load; no other skills are discovered. */
  readonly skills?: readonly string[] | undefined;
  /** Load the owner's own agent settings (ADR 0024 D4); off unless true. */
  readonly useOwnSettings?: boolean | undefined;
  /** Set by a chat reply: the worker may serve the next reply and then end itself. */
  readonly keep?: WorkerKeep | undefined;
}

export type { WorkerKeep } from "@operad-io/harness-process";

/** A gate such as a full test run must finish in the foreground; claude's own default is 120 s. */
export const DEFAULT_BASH_TIMEOUT_SECS = 1800;

export type FailureReason = "invalid_input" | "session_missing" | "model_error";

export type { CostQuality };
/** Set when the run stopped at a rate limit. */
export interface WorkerModelError {
  readonly kind: "usage_limit";
  readonly message: string;
  readonly rateLimitType: string | null;
  readonly resetsAt: number | null;
  /** How long until the reset, in seconds; null when claude gave no reset time. */
  readonly retry_after_secs: number | null;
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
  /** The context after the last model call, when one ran. */
  readonly context?: { readonly used: number; readonly window?: number } | undefined;
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
      readonly type: "rate_limit";
      readonly status: string;
      readonly rateLimitType: string | null;
      readonly resetsAt: number | null;
    }
  | SharedLine
  | WorkerResult;

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
  "images",
  "skills",
  "useOwnSettings",
  "keep",
] as const;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates the decoded stdin object; the message names the field at fault. */
export function parseInput(value: unknown): ParsedInput {
  if (!isRecord(value)) return { ok: false, message: "the input must be a JSON object" };

  // A field the program does not know is refused, never ignored: a flag that
  // is silently dropped would hide a wrong model.
  const unknown = readUnknownFields(value, INPUT_FIELDS);
  if (!unknown.ok) return unknown;

  const required = readRequiredStrings(value, ["prompt", "cwd"]);
  if (!required.ok) return required;
  const command = readOptionalString(value, "command");
  if (!command.ok) return command;
  const resumeSession = readOptionalString(value, "resumeSession");
  if (!resumeSession.ok) return resumeSession;
  if (resumeSession.value !== undefined && !SESSION_ID.test(resumeSession.value)) {
    return { ok: false, message: "resumeSession must be a session id (a UUID)" };
  }
  const model = readOptionalString(value, "model");
  if (!model.ok) return model;

  const level = value["effort"];
  let effort: WorkerEffort | undefined;
  if (level !== undefined) {
    const known = EFFORT_LEVELS.find((candidate) => candidate === level);
    if (known === undefined) {
      return { ok: false, message: `effort must be one of ${EFFORT_LEVELS.join(", ")}` };
    }
    effort = known;
  }

  const secretValues = readSecrets(value);
  if (!secretValues.ok) return secretValues;

  const images = readImages(value);
  if (!images.ok) return images;

  const skills = readStringList(value, "skills");
  if (!skills.ok) return skills;

  const useOwnSettings = readBoolean(value, "useOwnSettings");
  if (!useOwnSettings.ok) return useOwnSettings;

  const maxTurns = readPositiveInteger(value, "maxTurns");
  if (!maxTurns.ok) return maxTurns;
  const budgetUsd = readPositiveNumber(value, "budgetUsd");
  if (!budgetUsd.ok) return budgetUsd;
  const bashTimeoutSecs = readPositiveInteger(value, "bashTimeoutSecs");
  if (!bashTimeoutSecs.ok) return bashTimeoutSecs;

  const operadTools = readOperadTools(value);
  if (!operadTools.ok) return operadTools;

  const mcpServers = mountedServersOf(value["mcpServers"]);
  if (value["mcpServers"] !== undefined && (!isRecord(value["mcpServers"]) || (Object.keys(value["mcpServers"]).length > 0 && mcpServers === undefined))) {
    return { ok: false, message: "mcpServers must be an object of servers, each with a command" };
  }

  const access = readAccess(value);
  if (!access.ok) return access;

  const keep = readKeep(value);
  if (!keep.ok) return keep;

  return {
    ok: true,
    input: {
      prompt: required.value["prompt"] ?? "",
      cwd: required.value["cwd"] ?? "",
      command: command.value,
      resumeSession: resumeSession.value,
      model: model.value,
      effort,
      access: access.value,
      maxTurns: maxTurns.value,
      budgetUsd: budgetUsd.value,
      bashTimeoutSecs: bashTimeoutSecs.value,
      operadTools: operadTools.value,
      mcpServers,
      secretValues: secretValues.value,
      images: images.value.length === 0 ? undefined : images.value,
      skills: skills.value === undefined || skills.value.length === 0 ? undefined : skills.value,
      useOwnSettings: useOwnSettings.value,
      keep: keep.value,
    },
  };
}
