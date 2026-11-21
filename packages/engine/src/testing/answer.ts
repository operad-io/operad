/** Answering a person wait in the test's own process, for a test only. */

import type { FlowDefinition } from "../flow/types.ts";
import type { KernelState } from "../kernel/types.ts";
import type { LogBackend } from "../log/types.ts";
import type { Actor, AskQuestionAnswer } from "../plugin/types.ts";
import { answerInput } from "../runner/answer.ts";
import { StateError } from "../runner/errors.ts";
import { applyInput, readState } from "../runner/service.ts";

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
