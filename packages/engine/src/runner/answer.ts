/** Answering a person wait, for a CLI verb or a plugin action. */

import type { FlowDefinition } from "../flow/types.ts";
import type { KernelState } from "../kernel/types.ts";
import type { JsonValue, LogBackend } from "../log/types.ts";
import type { Actor, AskQuestion, AskQuestionAnswer } from "../plugin/types.ts";
import { answerAsk, answerableAsks, resolveAnswer, scanAsks } from "./ask.ts";
import { StateError } from "./errors.ts";
import { applyInput, readState } from "./service.ts";

export interface AnswerOptions {
  readonly log: LogBackend;
  readonly flow: FlowDefinition;
  readonly runId: string;
  /** The one choice a question of choices takes; absent for a form's answer. */
  readonly choice: string | undefined;
  /** The person's answer to each question, when the question was a form. */
  readonly answers?: readonly AskQuestionAnswer[] | undefined;
  readonly note?: string | undefined;
  readonly actor: Actor;
  readonly clock?: (() => number) | undefined;
  /** Called once when the answer ends the run. */
  readonly onEnded?:
    | ((runId: string, state: KernelState) => Promise<void>)
    | undefined;
}

export interface RecordAnswerOptions {
  readonly log: LogBackend;
  readonly runId: string;
  /**
   * The question the answer is for, when the person answers one by its id. An
   * answer to a question that is closed is refused and recorded.
   */
  readonly waitId?: string | undefined;
  readonly choice: string | undefined;
  /** The person's answer to each question, when the question was a form. */
  readonly answers?: readonly AskQuestionAnswer[] | undefined;
  readonly note?: string | undefined;
  readonly actor: Actor;
}

/** The payload a recorded answer carries, enough for `serve` to apply it later. */
export interface RecordedAnswerPayload {
  readonly kind: "person_answer";
  readonly waitId: string;
  readonly choice?: string | undefined;
  readonly answers?: readonly AskQuestionAnswer[] | undefined;
  readonly note?: string | undefined;
  readonly actor: { readonly via: string; readonly id: string };
}

function answerInput(
  runId: string,
  choice: string | undefined,
  answers: readonly AskQuestionAnswer[] | undefined,
  note: string | undefined,
  actor: Actor,
): (wait: {
  readonly id: string;
  readonly choices: readonly string[];
  readonly questions?: readonly AskQuestion[] | undefined;
}) => RecordedAnswerPayload {
  return (wait) => {
    // The same check a running step's question makes: a form needs one answer
    // per question, and a question of choices needs a choice.
    const resolved = resolveAnswer(runId, wait, choice, answers);
    return {
      kind: "person_answer",
      waitId: wait.id,
      ...(resolved.choice === undefined ? {} : { choice: resolved.choice }),
      ...(resolved.answers === undefined ? {} : { answers: resolved.answers }),
      ...(note === undefined ? {} : { note }),
      actor: { via: actor.via, id: actor.id },
    };
  };
}

/**
 * Records a person's answer without applying it. The CLI and actions use this:
 * only `serve` decides what the input means and runs the step it requests, so
 * a short-lived command never executes a step in its own process.
 */
export async function recordAnswer(options: RecordAnswerOptions): Promise<void> {
  const run = await options.log.run(options.runId);
  if (run === undefined) throw new StateError(`no run "${options.runId}"`);
  const state = await readState(options.log, options.runId);
  const wait = state.wait;
  const named =
    options.waitId !== undefined &&
    !(state.status === "waiting_person" && wait?.id === options.waitId);
  if (named || state.status !== "waiting_person" || wait === null) {
    // A step may be waiting on its own question; its answer goes to the step.
    const ask =
      state.status === "ended" || state.status === "idle"
        ? undefined
        : options.waitId !== undefined
          ? (await scanAsks(options.log, options.runId)).asks.get(options.waitId)
          : answerableAsks((await scanAsks(options.log, options.runId)).asks, state).at(-1);
    if (ask === undefined) {
      throw new StateError(
        options.waitId === undefined || state.status === "ended"
          ? `run ${options.runId} is not waiting for a person`
          : `run ${options.runId}: no question "${options.waitId}"`,
      );
    }
    await answerAsk({
      log: options.log,
      runId: options.runId,
      state,
      ask,
      choice: options.choice,
      ...(options.answers === undefined ? {} : { answers: options.answers }),
      ...(options.note === undefined ? {} : { note: options.note }),
      actor: options.actor,
    });
    return;
  }
  const payload = answerInput(
    options.runId,
    options.choice,
    options.answers,
    options.note,
    options.actor,
  )(wait);
  await options.log.recordInput(
    options.runId,
    "person",
    `${options.runId}:answer:${wait.id}:${options.choice ?? "answers"}`,
    payload as unknown as JsonValue,
  );
}

/** Answers the run's current wait and appends the resulting facts. */
export async function answerRun(options: AnswerOptions): Promise<KernelState> {
  const state = await readState(options.log, options.runId);
  const wait = state.wait;
  if (state.status !== "waiting_person" || wait === null) {
    throw new StateError(`run ${options.runId} is not waiting for a person`);
  }
  // Check the choice before recording anything, exactly as a recorded answer
  // does; the payload built here is the one `decide` applies.
  answerInput(
    options.runId,
    options.choice,
    options.answers,
    options.note,
    options.actor,
  )(wait);

  const now = (options.clock ?? (() => Date.now()))();
  const result = await applyInput(
    options.log,
    options.flow,
    options.runId,
    state,
    {
      kind: "person_answer",
      waitId: wait.id,
      ...(options.choice === undefined ? {} : { choice: options.choice }),
      ...(options.answers === undefined ? {} : { answers: options.answers }),
      ...(options.note === undefined ? {} : { note: options.note }),
      actor: options.actor,
    },
    now,
    "person",
    `answer:${wait.id}:${options.choice ?? "answers"}`,
    {
      beforeEnd: async (runId, ended) => {
        await options.onEnded?.(runId, ended);
      },
    },
  );
  return result.state;
}
