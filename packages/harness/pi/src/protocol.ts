/**
 * The wire shapes of the pi child program. `README.md` holds the same tables;
 * `test/protocol.test.ts` checks the program against them.
 */

import {
  readAccess,
  readBoolean,
  readImages,
  readKeep,
  readOperadTools,
  readOptionalString,
  readPositiveInteger,
  readRequiredStrings,
  readSecrets,
  readStringList,
  type ImageInput,
  type SharedLine,
  type WorkerKeep,
  type WorkerResultName,
  type WorkerUsage,
} from "@operad-io/harness-process";
import { isRecord } from "@operad-io/engine";

export type { AskAck, GrantAck, WorkerResultName, WorkerUsage } from "@operad-io/harness-process";

/** The longest one bash call may run when the settings do not say, in seconds. */
export const DEFAULT_BASH_TIMEOUT_SECS = 1800;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type WorkerThinkingLevel = (typeof THINKING_LEVELS)[number];

export type { WorkerKeep } from "@operad-io/harness-process";

/** What the program reads from stdin. */
export interface WorkerInput {
  readonly prompt: string;
  readonly cwd: string;
  readonly authPath: string;
  readonly modelsPath: string;
  readonly agentDir: string;
  /** The pi command (a name on PATH or a path); unset means `pi`. */
  readonly piCommand?: string | undefined;
  /** The operad home: its plugin project may hold the pi operad installed (ADR 0023 D9). */
  readonly piHome?: string | undefined;
  readonly sessionDir: string;
  readonly resumeSession?: string | undefined;
  readonly model?: string | undefined;
  readonly thinkingLevel?: WorkerThinkingLevel | undefined;
  readonly access?: Readonly<Record<string, unknown>> | undefined;
  /** The longest one bash call may run, in seconds; unset means `DEFAULT_BASH_TIMEOUT_SECS`. */
  readonly bashTimeoutSecs?: number | undefined;
  /** Operad's own tools, registered with pi as custom tools that read this home. */
  readonly operadTools?: { readonly home: string } | undefined;
  /** Secret values of the operad secret store; a log line shows `***` where one appears. */
  readonly secretValues?: readonly string[] | undefined;
  /** Images given to pi with the prompt, read from these files. */
  readonly images?: readonly ImageInput[] | undefined;
  /** Skill directories to load; with the own-settings switch off, no other skills are discovered. */
  readonly skills?: readonly string[] | undefined;
  /** Load the owner's own pi settings and resources (ADR 0023 D3); off unless true. */
  readonly useOwnSettings?: boolean | undefined;
  /** Retry a failed model request with pi's own bounded backoff; off unless true. */
  readonly retry?: boolean | undefined;
  /** Set by a chat reply: the worker may serve the next reply and then end itself. */
  readonly keep?: WorkerKeep | undefined;
  /** Set by a chat reply: compact the context when it nears the window (ADR 0023 D13). */
  readonly compact?: WorkerCompact | undefined;
  /** Overrides of the defaults for pruning old tool results (T-0767); pruning is on without it. */
  readonly prune?: WorkerPrune | undefined;
}

/** What a run may change about pruning; each absent field keeps the default in `prune.ts`. */
export interface WorkerPrune {
  /** Seconds since the last model message after which the prompt cache counts as expired. */
  readonly cacheSecs?: number | undefined;
  /** Assistant turns, counted from the last, whose tool results are kept. At least 1. */
  readonly keepTurns?: number | undefined;
  /** Characters of tool output a prune must free. */
  readonly minChars?: number | undefined;
}

/** When and how a reply compacts the session's context. Without it pi never compacts. */
export interface WorkerCompact {
  /** The share of the model's window, above 0 and at most 1, at which the context is compacted after a turn. */
  readonly at: number;
  /** The one silent turn run before a compaction; absent means compact without one. */
  readonly flush?: string | undefined;
  /** Compact after this turn whatever the context size. */
  readonly now?: boolean | undefined;
  /** Run no prompt: only the flush turn and the compaction. */
  readonly only?: boolean | undefined;
}

/** What a compaction did, on the result line. */
export interface WorkerCompaction {
  readonly reason: "threshold" | "manual";
  /** The context before the compaction, in tokens. */
  readonly before: number;
  /** The estimated context after it, when pi could tell. */
  readonly after?: number | undefined;
  /** Whether the silent flush turn ran. */
  readonly flushed: boolean;
}

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
  /** Set when this run compacted the session. */
  readonly compaction?: WorkerCompaction | undefined;
  /** The context after the last model call, when one ran. */
  readonly context?: { readonly used: number; readonly window?: number } | undefined;
  readonly reason?: FailureReason;
  readonly message?: string;
}

export type WorkerLine =
  | {
      readonly type: "message_end";
      readonly role: "assistant";
      /** The first 300 characters of the message's text, one paragraph; absent when it has none. */
      readonly text?: string;
      readonly stopReason: string;
      readonly usage: Required<WorkerUsage>;
      readonly cost: { readonly total: number } | null;
    }
  | SharedLine
  | { readonly type: "agent_settled"; readonly aborted: boolean }
  | WorkerResult;

function readCompact(
  value: Readonly<Record<string, unknown>>,
): { readonly ok: true; readonly value: WorkerCompact | undefined } | { readonly ok: false; readonly message: string } {
  const found = value["compact"];
  if (found === undefined) return { ok: true, value: undefined };
  if (!isRecord(found)) return { ok: false, message: "compact must be an object" };
  const at = found["at"];
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0 || at > 1) {
    return { ok: false, message: "compact.at must be a number above 0 and at most 1" };
  }
  const flush = found["flush"];
  if (flush !== undefined && typeof flush !== "string") return { ok: false, message: "compact.flush must be a string" };
  const now = found["now"];
  if (now !== undefined && typeof now !== "boolean") return { ok: false, message: "compact.now must be a boolean" };
  const only = found["only"];
  if (only !== undefined && typeof only !== "boolean") return { ok: false, message: "compact.only must be a boolean" };
  return { ok: true, value: { at, flush: flush === "" ? undefined : flush, now, only } };
}

function readPrune(
  value: Readonly<Record<string, unknown>>,
): { readonly ok: true; readonly value: WorkerPrune | undefined } | { readonly ok: false; readonly message: string } {
  const found = value["prune"];
  if (found === undefined) return { ok: true, value: undefined };
  if (!isRecord(found)) return { ok: false, message: "prune must be an object" };
  const number = (key: string, least: number): number | undefined | null => {
    const raw = found[key];
    if (raw === undefined) return undefined;
    return typeof raw === "number" && Number.isFinite(raw) && raw >= least ? raw : null;
  };
  const cacheSecs = number("cacheSecs", 0);
  if (cacheSecs === null) return { ok: false, message: "prune.cacheSecs must be a number, 0 or more" };
  const keepTurns = number("keepTurns", 1);
  if (keepTurns === null || (keepTurns !== undefined && !Number.isInteger(keepTurns))) {
    return { ok: false, message: "prune.keepTurns must be a whole number, 1 or more" };
  }
  const minChars = number("minChars", 0);
  if (minChars === null) return { ok: false, message: "prune.minChars must be a number, 0 or more" };
  return { ok: true, value: { cacheSecs, keepTurns, minChars } };
}

export type ParsedInput =
  | { readonly ok: true; readonly input: WorkerInput }
  | { readonly ok: false; readonly message: string };

const REQUIRED_STRINGS = ["prompt", "cwd", "authPath", "modelsPath", "agentDir", "sessionDir"] as const;

/** Validates the decoded stdin object; the message names the field at fault. */
export function parseInput(value: unknown): ParsedInput {
  if (!isRecord(value)) return { ok: false, message: "the input must be a JSON object" };

  const required = readRequiredStrings(value, REQUIRED_STRINGS);
  if (!required.ok) return required;

  const resumeSession = readOptionalString(value, "resumeSession");
  if (!resumeSession.ok) return resumeSession;
  const piCommand = readOptionalString(value, "piCommand");
  if (!piCommand.ok) return piCommand;
  const piHome = readOptionalString(value, "piHome");
  if (!piHome.ok) return piHome;
  const model = readOptionalString(value, "model");
  if (!model.ok) return model;
  if (model.value !== undefined && !/^[^/]+\/.+$/.test(model.value)) {
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

  const bashTimeoutSecs = readPositiveInteger(value, "bashTimeoutSecs");
  if (!bashTimeoutSecs.ok) return bashTimeoutSecs;

  const operadTools = readOperadTools(value);
  if (!operadTools.ok) return operadTools;

  const secretValues = readSecrets(value);
  if (!secretValues.ok) return secretValues;

  const images = readImages(value);
  if (!images.ok) return images;

  const skills = readStringList(value, "skills");
  if (!skills.ok) return skills;

  const useOwnSettings = readBoolean(value, "useOwnSettings");
  if (!useOwnSettings.ok) return useOwnSettings;

  const retry = readBoolean(value, "retry");
  if (!retry.ok) return retry;

  const access = readAccess(value);
  if (!access.ok) return access;

  const keep = readKeep(value);
  if (!keep.ok) return keep;

  const compact = readCompact(value);
  if (!compact.ok) return compact;

  const prune = readPrune(value);
  if (!prune.ok) return prune;

  return {
    ok: true,
    input: {
      prompt: required.value["prompt"] ?? "",
      cwd: required.value["cwd"] ?? "",
      authPath: required.value["authPath"] ?? "",
      modelsPath: required.value["modelsPath"] ?? "",
      agentDir: required.value["agentDir"] ?? "",
      sessionDir: required.value["sessionDir"] ?? "",
      resumeSession: resumeSession.value,
      piCommand: piCommand.value,
      piHome: piHome.value,
      model: model.value,
      thinkingLevel,
      access: access.value,
      bashTimeoutSecs: bashTimeoutSecs.value,
      operadTools: operadTools.value,
      secretValues: secretValues.value,
      images: images.value.length === 0 ? undefined : images.value,
      skills: skills.value === undefined || skills.value.length === 0 ? undefined : skills.value,
      useOwnSettings: useOwnSettings.value,
      retry: retry.value,
      keep: keep.value,
      compact: compact.value,
      prune: prune.value,
    },
  };
}
