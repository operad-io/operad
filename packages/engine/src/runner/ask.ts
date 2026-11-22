/**
 * Questions a step asks a person with `ctx.ask`.
 *
 * The facts of the run are the only record. `ask_opened` makes the question
 * visible; the first of `ask_answered` and `ask_timed_out` closes it, and an
 * answer that arrives after that is refused and recorded as `ask_refused`.
 * A person's answer is claimed first as a recorded input (the first claim for
 * a question wins) and then written as the fact; any process that finds a claim
 * without its fact writes it, so a crash between the two loses nothing.
 */

import { inputIdFor } from "../log/facts.ts";
import { SeqConflictError } from "../log/errors.ts";
import type { JsonValue, LogBackend } from "../log/types.ts";
import type {
  Actor,
  AskOutcome,
  AskQuestion,
  AskQuestionAnswer,
  AskRequest,
  StepAsker,
} from "../plugin/types.ts";
import { StateError } from "./errors.ts";
import type { Grant, KernelState } from "../kernel/types.ts";
import { useGrant } from "./grants.ts";
import { isRecord } from "../util.ts";
import { choiceInfoJson, storedChoiceInfo, type ChoiceInfoMap } from "../plugin/choice-info.ts";
import {
  answersJson,
  answersProblem,
  formChoices,
  normalizeAnswers,
  questionsJson,
  storedAnswers,
  storedQuestions,
} from "../plugin/question-form.ts";

/** How often a waiting step looks again when no change was announced. */
const RECHECK_MS = 1000;

/** The default grace, in seconds, when neither the call nor config narrows it. */
export const DEFAULT_ASK_GRACE_SECS = 600;

/** Starts a timer; the returned function cancels it. Tests inject their own. */
export type AskTimer = (ms: number, fire: () => void) => () => void;

export const realAskTimer: AskTimer = (ms, fire) => {
  const handle = setTimeout(fire, ms);
  return () => clearTimeout(handle);
};

export type AskStatus = "open" | "answered" | "timed_out";

export interface AskedAnswer {
  /** The one answer a question of choices takes; absent for a form's answer. */
  readonly choice: string | undefined;
  readonly note: string | undefined;
  readonly actor: Actor;
  /** The person's answer to each question, when the question was a form. */
  readonly answers: readonly AskQuestionAnswer[] | undefined;
}

/** One question as the facts of its run tell it. */
export interface AskRecord {
  readonly waitId: string;
  readonly effectId: string;
  readonly step: string | null;
  readonly prompt: string;
  readonly choices: readonly string[];
  readonly choiceInfo: ChoiceInfoMap | undefined;
  /** The form the step asked, when it asked one. */
  readonly questions: readonly AskQuestion[] | undefined;
  readonly status: AskStatus;
  readonly answer: AskedAnswer | undefined;
}

export function askWaitId(runId: string, effectId: string, n: number): string {
  return `${runId}:${effectId}:${n}`;
}

function actorOf(value: unknown): Actor | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.via !== "string" || typeof value.id !== "string") {
    return undefined;
  }
  return { via: value.via, id: value.id };
}

function answerOf(
  payload: Record<string, JsonValue>,
  questions: readonly AskQuestion[] | undefined,
): AskedAnswer | undefined {
  const actor = actorOf(payload.actor);
  if (actor === undefined) return undefined;
  const choice = typeof payload.choice === "string" ? payload.choice : undefined;
  const answers =
    questions === undefined || questions.length === 0
      ? undefined
      : storedAnswers(payload.answers, questions);
  if (choice === undefined && answers === undefined) return undefined;
  return {
    choice,
    note: typeof payload.note === "string" ? payload.note : undefined,
    actor,
    answers,
  };
}

/** Every question of the run, in the order they were opened. */
export async function scanAsks(
  log: LogBackend,
  runId: string,
): Promise<{
  readonly asks: ReadonlyMap<string, AskRecord>;
  readonly lastSeq: number;
}> {
  const asks = new Map<string, AskRecord>();
  let lastSeq = 0;
  for await (const fact of log.read(runId)) {
    lastSeq = fact.seq;
    if (
      fact.kind !== "ask_opened" &&
      fact.kind !== "ask_answered" &&
      fact.kind !== "ask_timed_out"
    ) {
      continue;
    }
    const payload = fact.payload;
    if (!isRecord(payload) || typeof payload.waitId !== "string") continue;
    const waitId = payload.waitId;
    const existing = asks.get(waitId);
    if (fact.kind === "ask_opened") {
      if (existing !== undefined) continue;
      if (
        typeof payload.effectId !== "string" ||
        typeof payload.prompt !== "string"
      ) {
        continue;
      }
      const choices = Array.isArray(payload.choices)
        ? payload.choices.filter(
            (item): item is string => typeof item === "string",
          )
        : [];
      asks.set(waitId, {
        waitId,
        effectId: payload.effectId,
        step: typeof payload.step === "string" ? payload.step : null,
        prompt: payload.prompt,
        choices,
        choiceInfo: storedChoiceInfo(payload.choiceInfo, choices),
        questions: storedQuestions(payload.questions),
        status: "open",
        answer: undefined,
      });
      continue;
    }
    // The first of an answer and a timeout closes the question.
    if (existing === undefined || existing.status !== "open") continue;
    if (fact.kind === "ask_timed_out") {
      asks.set(waitId, { ...existing, status: "timed_out" });
      continue;
    }
    const answer = answerOf(payload, existing.questions);
    if (answer !== undefined) {
      asks.set(waitId, { ...existing, status: "answered", answer });
    }
  }
  return { asks, lastSeq };
}

interface FactSpec {
  readonly kind: "ask_opened" | "ask_answered" | "ask_timed_out" | "ask_refused";
  readonly payload: Record<string, JsonValue>;
}

/**
 * Decides from the run's current questions which facts to append, and appends
 * them, deciding again when the run moved on in between. Returns what it wrote.
 */
async function appendWhen(
  log: LogBackend,
  runId: string,
  build: (asks: ReadonlyMap<string, AskRecord>) => readonly FactSpec[],
): Promise<readonly FactSpec[]> {
  for (let attempt = 0; ; attempt += 1) {
    const { asks, lastSeq } = await scanAsks(log, runId);
    const facts = build(asks);
    if (facts.length === 0) return facts;
    try {
      await log.append(
        runId,
        lastSeq,
        facts.map((fact) => ({
          kind: fact.kind,
          payload: fact.payload,
          cause: lastSeq,
        })),
      );
      return facts;
    } catch (error) {
      if (error instanceof SeqConflictError && attempt < 8) continue;
      throw error;
    }
  }
}

function claimKey(runId: string, waitId: string): string {
  return `${runId}:ask:${waitId}`;
}

/**
 * The full answers of a secret question, kept only for the step that is running
 * in this process (ADR 0008 D8). They never reach a fact, an input or history.
 */
const secretAnswers = new Map<string, readonly AskQuestionAnswer[]>();

function secretKey(runId: string, waitId: string): string {
  return `${runId}:secret:${waitId}`;
}

/** True when any question of the form takes a secret answer. */
export function hasSecretQuestion(
  questions: readonly AskQuestion[] | undefined,
): boolean {
  return questions?.some((question) => question.secret === true) ?? false;
}

/** Takes the secret answers a running step is waiting for; they are used once. */
export function takeSecretAnswers(
  runId: string,
  waitId: string,
): readonly AskQuestionAnswer[] | undefined {
  const key = secretKey(runId, waitId);
  const found = secretAnswers.get(key);
  secretAnswers.delete(key);
  return found;
}

/** The answers a fact or an input carries: a secret question's text is left out. */
function recordedAnswers(
  answers: readonly AskQuestionAnswer[] | undefined,
  questions: readonly AskQuestion[] | undefined,
): readonly AskQuestionAnswer[] | undefined {
  if (answers === undefined || !hasSecretQuestion(questions)) return answers;
  const secret = new Set(
    (questions ?? [])
      .filter((question) => question.secret === true)
      .map((question) => question.id),
  );
  return answers.map((answer) => {
    if (!secret.has(answer.id)) return answer;
    const choices = answer.choices;
    if (choices !== undefined && choices.length > 0) return { id: answer.id, choices };
    return { id: answer.id, skipped: true as const };
  });
}

/** The answer a person claimed for the question, when someone claimed it. */
async function claimedAnswer(
  log: LogBackend,
  runId: string,
  waitId: string,
  questions: readonly AskQuestion[] | undefined,
): Promise<AskedAnswer | undefined> {
  // The input id is made from the source and the key, so one lookup finds it.
  const input = await log.findInput(
    inputIdFor("person", claimKey(runId, waitId)),
  );
  if (input === undefined) return undefined;
  if (!isRecord(input.payload) || input.payload.kind !== "ask_answer") {
    return undefined;
  }
  return answerOf(input.payload, questions);
}

function answeredFact(waitId: string, answer: AskedAnswer): FactSpec {
  return {
    kind: "ask_answered",
    payload: {
      waitId,
      choice: answer.choice ?? null,
      note: answer.note ?? null,
      ...(answer.answers === undefined ? {} : { answers: answersJson(answer.answers) }),
      actor: { via: answer.actor.via, id: answer.actor.id },
    },
  };
}

/**
 * The question as it stands. A claimed answer that has no fact yet (its
 * claimant stopped between the two) is written now.
 */
export async function settleAsk(
  log: LogBackend,
  runId: string,
  waitId: string,
): Promise<AskRecord | undefined> {
  const { asks } = await scanAsks(log, runId);
  const record = asks.get(waitId);
  if (record === undefined || record.status !== "open") return record;
  const claimed = await claimedAnswer(log, runId, waitId, record.questions);
  if (claimed === undefined) return record;
  await appendWhen(log, runId, (current) =>
    current.get(waitId)?.status === "open" ? [answeredFact(waitId, claimed)] : [],
  );
  return (await scanAsks(log, runId)).asks.get(waitId);
}

/** The questions a person could answer now: open, and their step is running. */
export function answerableAsks(
  asks: ReadonlyMap<string, AskRecord>,
  state: KernelState,
): AskRecord[] {
  return [...asks.values()].filter(
    (record) =>
      record.status === "open" &&
      state.status === "running" &&
      state.effects[record.effectId] === "outstanding",
  );
}

export interface AnswerAskOptions {
  readonly log: LogBackend;
  readonly runId: string;
  readonly state: KernelState;
  readonly ask: AskRecord;
  /** The one choice a question of choices takes; absent for a form's answer. */
  readonly choice: string | undefined;
  readonly note?: string | undefined;
  /** The person's answer to each question, for a form. */
  readonly answers?: unknown;
  readonly actor: Actor;
}

/**
 * What a person's answer to one question says, checked against the question.
 * The same rule serves a running step's question and a flow's wait after the
 * grace, so an answer one path refuses is never silently dropped by the other.
 */
export function resolveAnswer(
  runId: string,
  ask: {
    readonly choices: readonly string[];
    readonly questions?: readonly AskQuestion[] | undefined;
  },
  choice: string | undefined,
  answers: unknown,
): { readonly choice: string | undefined; readonly answers: readonly AskQuestionAnswer[] | undefined } {
  const questions = ask.questions;
  if (questions === undefined || questions.length === 0) {
    if (choice === undefined) {
      throw new StateError(`run ${runId}: this question takes a choice`);
    }
    if (!ask.choices.includes(choice)) {
      throw new StateError(
        ask.choices.length === 0
          ? `run ${runId}: this question takes no choice`
          : `run ${runId}: "${choice}" is not one of ${ask.choices
              .map((item) => `"${item}"`)
              .join(", ")}`,
      );
    }
    return { choice, answers: undefined };
  }
  const problem = answersProblem(answers, questions);
  if (problem !== undefined) {
    throw new StateError(`run ${runId}: answers: ${problem}`);
  }
  if (answers !== undefined) {
    return { choice, answers: normalizeAnswers(answers, questions) };
  }
  // A client that cannot draw the form answers the one question it was shown.
  if (choice !== undefined && questions.length === 1 && ask.choices.includes(choice)) {
    return {
      choice,
      answers: normalizeAnswers([{ id: questions[0]?.id, choices: [choice] }], questions),
    };
  }
  throw new StateError(
    `run ${runId}: this question is a form; it needs one answer per question`,
  );
}

/**
 * Records a person's answer to a question a step is waiting on. The first
 * answer counts, a second is refused, and an answer to a question whose step
 * is over is refused and recorded.
 */
export async function answerAsk(options: AnswerAskOptions): Promise<void> {
  const { log, runId, ask, choice, actor } = options;
  const resolved = resolveAnswer(runId, ask, choice, options.answers);
  const refuse = async (reason: string): Promise<never> => {
    // An ended run takes no more facts; the answer is just not taken.
    if (options.state.status === "ended") {
      throw new StateError(`run ${runId}: ${reason}`);
    }
    await appendWhen(log, runId, () => [
      {
        kind: "ask_refused",
        payload: {
          waitId: ask.waitId,
          choice: choice ?? null,
          actor: { via: actor.via, id: actor.id },
          reason,
        },
      },
    ]);
    throw new StateError(`run ${runId}: ${reason}`);
  };

  const current = (await scanAsks(log, runId)).asks.get(ask.waitId) ?? ask;
  if (current.status === "answered") {
    throw new StateError(`run ${runId}: already answered`);
  }
  const live =
    options.state.status === "running" &&
    options.state.effects[ask.effectId] === "outstanding";
  if (current.status === "timed_out" || !live) {
    await refuse("the question is closed, its step has ended");
  }
  if (hasSecretQuestion(ask.questions)) {
    const given = new Set(
      (resolved.answers ?? [])
        .filter((answer) => typeof answer.text === "string" && answer.text.trim().length > 0)
        .map((answer) => answer.id),
    );
    const missing = (ask.questions ?? []).some(
      (question) => question.secret === true && !given.has(question.id),
    );
    if (missing) {
      await refuse("a secret question takes an answer with its text");
    }
  }
  const secret = hasSecretQuestion(ask.questions);
  const recorded = recordedAnswers(resolved.answers, ask.questions);
  if (secret && resolved.answers !== undefined) {
    secretAnswers.set(secretKey(runId, ask.waitId), resolved.answers);
  }

  const payload: Record<string, JsonValue> = {
    kind: "ask_answer",
    waitId: ask.waitId,
    choice: resolved.choice ?? null,
    note: options.note ?? null,
    ...(recorded === undefined ? {} : { answers: answersJson(recorded) }),
    actor: { via: actor.via, id: actor.id },
  };
  const claim = await log.recordInput(
    runId,
    "person",
    claimKey(runId, ask.waitId),
    payload,
  );
  if (claim.duplicate) {
    secretAnswers.delete(secretKey(runId, ask.waitId));
    throw new StateError(`run ${runId}: already answered`);
  }
  const answer: AskedAnswer = {
    choice: resolved.choice,
    note: options.note,
    actor,
    answers: recorded,
  };
  const written = await appendWhen(log, runId, (asks) =>
    asks.get(ask.waitId)?.status === "open" ? [answeredFact(ask.waitId, answer)] : [],
  );
  if (written.length === 0) {
    secretAnswers.delete(secretKey(runId, ask.waitId));
    const closed = (await scanAsks(log, runId)).asks.get(ask.waitId);
    // The reconciling step wrote the fact from this claim: that is success.
    if (closed?.status === "answered" && closed.answer?.choice === choice) return;
    await refuse("the question is closed, its step has ended");
  }
}

function narrowest(...values: readonly (number | undefined)[]): number {
  let result = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (value === undefined || !Number.isFinite(value)) continue;
    result = Math.min(result, Math.max(0, value));
  }
  return Number.isFinite(result) ? result : DEFAULT_ASK_GRACE_SECS;
}

export interface AskHostOptions {
  readonly log: LogBackend;
  /** `ask.graceSecs` from config.json. */
  readonly graceSecs?: number | undefined;
  readonly timer?: AskTimer | undefined;
  /** Stops the step's own timeout while a question is open; returns resume. */
  readonly pause?: (() => () => void) | undefined;
}

/** Serves the questions of the steps one runner starts. */
export class AskHost {
  private readonly log: LogBackend;
  private readonly graceSecs: number;
  private readonly timer: AskTimer;
  private readonly pause: (() => () => void) | undefined;

  constructor(options: AskHostOptions) {
    this.log = options.log;
    this.graceSecs = options.graceSecs ?? DEFAULT_ASK_GRACE_SECS;
    this.timer = options.timer ?? realAskTimer;
    this.pause = options.pause;
  }

  /**
   * The asker of one effect. Questions are numbered in the order the step asks
   * them, so a step that runs again after a crash gets the same ids.
   */
  asker(
    runId: string,
    effectId: string,
    step: string | null,
    grants: readonly Grant[] = [],
  ): StepAsker {
    let count = 0;
    let asking = false;
    return {
      useGrant: (waitId) =>
        useGrant(this.log, runId, step ?? "", grants, waitId),
      ask: async (request, signal) => {
        // One question at a time: a second would hide the first from the person.
        if (asking) {
          throw new Error(
            "a step asks one question at a time; wait for the answer before asking again",
          );
        }
        asking = true;
        count += 1;
        try {
          return await this.ask(runId, effectId, step, count, request, signal);
        } finally {
          asking = false;
        }
      },
    };
  }

  private async ask(
    runId: string,
    effectId: string,
    step: string | null,
    n: number,
    request: AskRequest,
    signal: AbortSignal | undefined,
  ): Promise<AskOutcome> {
    const waitId = askWaitId(runId, effectId, n);
    const questions = request.questions;
    // A form shows one question's labels to a client that cannot draw it, so
    // such a client still answers with a choice; the kernel derives them.
    const choices =
      questions === undefined ? [...(request.choices ?? [])] : formChoices(questions);
    const choiceInfo = storedChoiceInfo(request.choiceInfo, choices);
    const grace = narrowest(request.graceSecs, this.graceSecs);

    await appendWhen(this.log, runId, (asks) =>
      asks.has(waitId)
        ? []
        : [
            {
              kind: "ask_opened",
              payload: {
                waitId,
                effectId,
                step,
                prompt: request.prompt,
                choices,
                ...(choiceInfo === undefined
                  ? {}
                  : { choiceInfo: choiceInfoJson(choiceInfo) }),
                ...(questions === undefined
                  ? {}
                  : { questions: questionsJson(questions) }),
              },
            },
          ],
    );

    const resume = this.pause?.();
    let expired = false;
    let cancelTimer: (() => void) | undefined;
    let wake: (() => void) | undefined;
    try {
      for (;;) {
        if (signal?.aborted === true) {
          throw new Error("the step was cancelled while it waited for an answer");
        }
        const record = await settleAsk(this.log, runId, waitId);
        if (record === undefined) {
          throw new Error(`the question ${waitId} is gone from the log`);
        }
        if (record.status === "answered" && record.answer !== undefined) {
          const shown = takeSecretAnswers(runId, waitId);
          return {
            kind: "answered",
            answer: {
              choice: record.answer.choice,
              ...(record.answer.note === undefined
                ? {}
                : { note: record.answer.note }),
              ...(record.answer.answers === undefined && shown === undefined
                ? {}
                : { answers: shown ?? record.answer.answers }),
              actor: record.answer.actor,
            },
          };
        }
        if (record.status === "timed_out") {
          return {
            kind: "timeout",
            waitId,
            prompt: record.prompt,
            choices,
            ...(record.choiceInfo === undefined
              ? {}
              : { choiceInfo: record.choiceInfo }),
            ...(record.questions === undefined
              ? {}
              : { questions: record.questions }),
          };
        }
        if (request.recheck !== undefined) {
          const next = await request.recheck();
          if (next.ask === false) {
            await appendWhen(this.log, runId, (asks) =>
              asks.get(waitId)?.status === "open"
                ? [
                    {
                      kind: "ask_answered",
                      payload: {
                        waitId,
                        choice: "allow_once",
                        note: next.note ?? null,
                        actor: next.actor === undefined
                          ? { via: "", id: "" }
                          : { via: next.actor.via, id: next.actor.id },
                      },
                    },
                  ]
                : [],
            );
            continue;
          }
        }
        if (grace <= 0 || expired) {
          await appendWhen(this.log, runId, (asks) =>
            asks.get(waitId)?.status === "open"
              ? [{ kind: "ask_timed_out", payload: { waitId } }]
              : [],
          );
          continue;
        }
        cancelTimer ??= this.timer(grace * 1000, () => {
          expired = true;
          wake?.();
        });
        await new Promise<void>((resolve) => {
          let recheck: ReturnType<typeof setTimeout> | undefined;
          let unsubscribe: (() => void) | undefined;
          const done = (): void => {
            if (recheck !== undefined) clearTimeout(recheck);
            unsubscribe?.();
            signal?.removeEventListener("abort", done);
            wake = undefined;
            resolve();
          };
          wake = done;
          unsubscribe = this.log.subscribe?.(done);
          recheck = setTimeout(done, RECHECK_MS);
          signal?.addEventListener("abort", done, { once: true });
          if (expired) done();
        });
      }
    } finally {
      cancelTimer?.();
      resume?.();
    }
  }
}
