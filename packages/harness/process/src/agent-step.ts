/**
 * The first half of every process harness's `agent` step: the params and
 * settings it reads the same way, the refusal it writes when one is wrong, and
 * the access set it starts the worker from. A harness adds only the fields its
 * own program takes.
 */

import { hasLiveAccess, secretValuesOf, withDefaultAccess, type AccessProfile } from "@operad-io/access-match";
import {
  directoryError,
  isRecord,
  paramsObject,
  type PluginStepResult,
  type StepContext,
} from "@operad-io/engine";
import {
  accessWithAlwaysAllow,
  alwaysAllowFromGrant,
  appendAlwaysAllow,
  personStarted,
  readAlwaysAllow,
} from "./always-allow.ts";
import { ALLOW_ALWAYS, canAsk, recordTargetGrantFromAnswer } from "./ask-call.ts";
import { askNote } from "./ask-note.ts";
import { eventNote } from "./event-note.ts";
import { hasGrants } from "./grants.ts";
import { inboxOf } from "./inbox.ts";
import { flagValue } from "./limit.ts";
import { refuseResult } from "./refusal.ts";
import { optionalText, parseStepFlags, secs, stringListParam, text, type StepFlagSpec } from "./step.ts";
import { StepTimings } from "./timings.ts";
import type { UsageSource } from "./usage.ts";

/** What one harness adds to the shared reading of an `agent` step. */
export interface AgentStepSpec<Level extends string> {
  /** The step name messages use, such as `claude/agent`. */
  readonly at: string;
  /** The name the step goes by in usage and limit keys. */
  readonly harness: string;
  /** The spelling of this harness's step `args`. */
  readonly flags: StepFlagSpec<Level>;
  readonly defaultWallTimeSecs: number;
  readonly defaultStallSecs: number;
  readonly maxWallTimeSecs: number;
  /** The setting that names the reasoning level, such as `effort`. */
  readonly levelSetting: string;
  /** Milliseconds now, from the injected clock. */
  readonly now: () => number;
  /**
   * Reads this harness's own settings and params, after the shared fields and
   * before the directory check. A returned result refuses the step.
   */
  readonly beforeDirectory?: (
    read: AgentStepValues<Level>,
  ) => void | PluginStepResult | Promise<void | PluginStepResult>;
  /**
   * Reads the rest, after the directory check and before the access set. A
   * returned result refuses the step.
   */
  readonly afterDirectory?: (
    read: AgentStepValues<Level>,
  ) => void | PluginStepResult | Promise<void | PluginStepResult>;
  /** Extra data a refusal carries, such as codex's image call count. */
  readonly refusalExtra?: Readonly<Record<string, unknown>>;
}

/** The values the shared part of an `agent` step reads. */
export interface AgentStepValues<Level extends string> {
  readonly at: string;
  readonly harness: string;
  readonly ctx: StepContext;
  readonly params: unknown;
  readonly timings: StepTimings;
  readonly input: Readonly<Record<string, unknown>>;
  readonly flow: Readonly<Record<string, unknown>>;
  readonly prompt: string;
  readonly note: string | undefined;
  readonly rawAskAnswer: unknown;
  readonly answerNote: string | undefined;
  readonly promptWithNote: string;
  readonly cwd: string;
  readonly args: unknown;
  readonly flags: { readonly model?: string; readonly level?: Level };
  /** The model the step will use, known before anything can fail. */
  readonly knownModel: string | undefined;
  readonly early: UsageSource;
  readonly resumeSession: string | undefined;
  readonly wallTimeSecs: number;
  readonly stallSecs: number;
  readonly model: string | undefined;
  /** The level the step asks for: the flag, the param or the setting; the worker validates it. */
  readonly level: string | undefined;
  /** The early failed result: writes the message and returns `failed` with `reason`. */
  readonly refuse: (reason: string, message: string) => Promise<PluginStepResult>;
}

/** The access set every harness builds from an answer and the profile. */
export interface AgentStepAccess {
  readonly startAccess: AccessProfile;
  readonly access: AccessProfile;
  readonly runAccess: AccessProfile | undefined;
  readonly allowAlways: boolean;
  readonly secrets: readonly string[];
  /** Whether the worker needs a reply channel for permissions or mid-run messages. */
  readonly interactive: boolean;
}

/** A step that is reading its params or has read them all. */
export type AgentStepRead<Level extends string> =
  | { readonly refused: PluginStepResult }
  | { readonly values: AgentStepValues<Level>; readonly access: AgentStepAccess };

/**
 * Reads the fields every process harness reads the same way, refuses a bad one
 * with the early failed result, checks the directory and builds the access set.
 */
export async function readAgentStep<Level extends string>(
  ctx: StepContext,
  params: unknown,
  spec: AgentStepSpec<Level>,
): Promise<AgentStepRead<Level>> {
  const at = spec.at;
  const timings = new StepTimings(spec.now);
  const input = paramsObject(params, at);
  const flow = isRecord(ctx.params) ? ctx.params : {};

  const prompt = text(input.prompt ?? flow.prompt, `${at}: params.prompt`);
  const note = eventNote(ctx.trigger);
  const rawAskAnswer = input.askAnswer ?? flow.askAnswer;
  const answerNote = askNote(rawAskAnswer);
  const promptWithNote = [prompt, note, answerNote]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
  const cwd = text(input.cwd ?? flow.cwd, `${at}: params.cwd`);
  const args = input.args === undefined ? flow.args : input.args;
  const flags = parseStepFlags(stringListParam(args, `${at}: params.args`), spec.flags);
  const settingModel = typeof ctx.settings.model === "string" ? ctx.settings.model : undefined;
  const knownModel =
    typeof flags === "string" ? (flagValue(args, "--model") ?? settingModel) : (flags.model ?? settingModel);
  const early: UsageSource = { harness: spec.harness, model: knownModel ?? null };

  const refuse = (reason: string, message: string): Promise<PluginStepResult> =>
    refuseResult({
      log: (text) => ctx.logger.write(text),
      timings,
      who: early,
      reason,
      message,
      extra: spec.refusalExtra,
    });

  if (typeof flags === "string") return { refused: await refuse("invalid_args", `${at}: ${flags}`) };

  const resumeSession = optionalText(input.resumeSession ?? flow.resumeSession, `${at}: params.resumeSession`);
  const wallTimeSecs = secs(
    input.wallTimeSecs ?? ctx.settings.wallTimeSecs ?? spec.defaultWallTimeSecs,
    `${at}: params.wallTimeSecs`,
  );
  if (wallTimeSecs > spec.maxWallTimeSecs) {
    throw new Error(`${at}: params.wallTimeSecs: must be at most ${spec.maxWallTimeSecs}`);
  }
  const stallSecs = secs(
    input.stallSecs ?? ctx.settings.stallSecs ?? spec.defaultStallSecs,
    `${at}: params.stallSecs`,
  );
  const model = flags.model ?? optionalText(ctx.settings.model, `${at}: settings.model`);
  const level =
    flags.level ??
    optionalText(input.effort, `${at}: params.effort`) ??
    optionalText(ctx.settings[spec.levelSetting], `${at}: settings.${spec.levelSetting}`);

  const values: AgentStepValues<Level> = {
    at,
    harness: spec.harness,
    ctx,
    params,
    timings,
    input,
    flow,
    prompt,
    note,
    rawAskAnswer,
    answerNote,
    promptWithNote,
    cwd,
    args,
    flags,
    knownModel,
    early,
    resumeSession,
    wallTimeSecs,
    stallSecs,
    model,
    level,
    refuse,
  };

  const before = await spec.beforeDirectory?.(values);
  if (before !== undefined) return { refused: before };

  const cwdProblem = await directoryError(cwd);
  if (cwdProblem !== undefined) return { refused: await refuse("cwd", cwdProblem) };

  const after = await spec.afterDirectory?.(values);
  if (after !== undefined) return { refused: after };

  // A generated step that names no profile still starts from the default.
  const startAccess = withDefaultAccess(ctx.access as AccessProfile | undefined);
  const secrets = await secretValuesOf(ctx.secrets);
  const allowAlways = personStarted(ctx.trigger);
  // A run no person's message started asks about every outward write.
  const access = allowAlways ? startAccess : { ...startAccess, background: true };
  if (allowAlways && isRecord(rawAskAnswer) && rawAskAnswer["choice"] === ALLOW_ALWAYS) {
    const entry = alwaysAllowFromGrant(access, cwd);
    if (entry !== undefined) {
      try {
        await appendAlwaysAllow(ctx.home, entry);
      } catch (error) {
        await ctx.logger.write(
          `allow_always could not be written to the user access file: ${String(error)}; this call runs once`,
        );
      }
    }
  }
  if (ctx.flow !== undefined) {
    try {
      await recordTargetGrantFromAnswer(ctx.home, ctx.flow, access, rawAskAnswer, spec.now);
    } catch (error) {
      await ctx.logger.write(`the target grant could not be written: ${String(error)}; this call runs once`);
    }
  }
  let runAccess = accessWithAlwaysAllow(access, [], false);
  if (allowAlways) {
    const user = await readAlwaysAllow(ctx.home);
    if (user.problem !== undefined) await ctx.logger.write(user.problem);
    runAccess = accessWithAlwaysAllow(access, user.entries, true);
  }
  return {
    values,
    access: {
      startAccess,
      access,
      runAccess,
      allowAlways,
      secrets,
      interactive: hasGrants(access) || canAsk(access) || hasLiveAccess(access) || inboxOf(params) !== undefined,
    },
  };
}
