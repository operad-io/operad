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
  AskRequest,
  StepAsker,
} from "../plugin/types.ts";
import { StateError } from "./errors.ts";
import type { Grant, KernelState } from "../kernel/types.ts";
import { useGrant } from "./grants.ts";
import { isRecord } from "../util.ts";

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
  readonly choice: string;
  readonly note: string | undefined;
  readonly actor: Actor;
}

/** One question as the facts of its run tell it. */
export interface AskRecord {
  readonly waitId: string;
  readonly effectId: string;
  readonly step: string | null;
  readonly prompt: string;
  readonly choices: readonly string[];
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

function answerOf(payload: Record<string, JsonValue>): AskedAnswer | undefined {
  const actor = actorOf(payload.actor);
  if (actor === undefined || typeof payload.choice !== "string") {
    return undefined;
  }
  return {
    choice: payload.choice,
    note: typeof payload.note === "string" ? payload.note : undefined,
    actor,
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
      asks.set(waitId, {
        waitId,
        effectId: payload.effectId,
        step: typeof payload.step === "string" ? payload.step : null,
        prompt: payload.prompt,
        choices: Array.isArray(payload.choices)
          ? payload.choices.filter(
              (item): item is string => typeof item === "string",
            )
          : [],
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
    const answer = answerOf(payload);
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

/** The answer a person claimed for the question, when someone claimed it. */
async function claimedAnswer(
  log: LogBackend,
  runId: string,
  waitId: string,
): Promise<AskedAnswer | undefined> {
  // The input id is made from the source and the key, so one lookup finds it.
  const input = await log.findInput(
    inputIdFor("person", claimKey(runId, waitId)),
  );
  if (input === undefined) return undefined;
  if (!isRecord(input.payload) || input.payload.kind !== "ask_answer") {
    return undefined;
  }
  return answerOf(input.payload);
}

function answeredFact(waitId: string, answer: AskedAnswer): FactSpec {
  return {
    kind: "ask_answered",
    payload: {
      waitId,
      choice: answer.choice,
      note: answer.note ?? null,
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
  const claimed = await claimedAnswer(log, runId, waitId);
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
  readonly choice: string;
  readonly note?: string | undefined;
  readonly actor: Actor;
}

/**
 * Records a person's answer to a question a step is waiting on. The first
 * answer counts, a second is refused, and an answer to a question whose step
 * is over is refused and recorded.
 */
export async function answerAsk(options: AnswerAskOptions): Promise<void> {
  const { log, runId, ask, choice, actor } = options;
  if (ask.choices.length > 0 && !ask.choices.includes(choice)) {
    throw new StateError(
      `run ${runId}: "${choice}" is not one of ${ask.choices
        .map((item) => `"${item}"`)
        .join(", ")}`,
    );
  }
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
          choice,
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

  const payload: Record<string, JsonValue> = {
    kind: "ask_answer",
    waitId: ask.waitId,
    choice,
    note: options.note ?? null,
    actor: { via: actor.via, id: actor.id },
  };
  const claim = await log.recordInput(
    runId,
    "person",
    claimKey(runId, ask.waitId),
    payload,
  );
  if (claim.duplicate) {
    throw new StateError(`run ${runId}: already answered`);
  }
  const answer: AskedAnswer = { choice, note: options.note, actor };
  const written = await appendWhen(log, runId, (asks) =>
    asks.get(ask.waitId)?.status === "open" ? [answeredFact(ask.waitId, answer)] : [],
  );
  if (written.length === 0) {
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
    const choices = [...(request.choices ?? [])];
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
          return {
            kind: "answered",
            answer: {
              choice: record.answer.choice,
              ...(record.answer.note === undefined
                ? {}
                : { note: record.answer.note }),
              actor: record.answer.actor,
            },
          };
        }
        if (record.status === "timed_out") {
          return { kind: "timeout", waitId, prompt: record.prompt, choices };
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
