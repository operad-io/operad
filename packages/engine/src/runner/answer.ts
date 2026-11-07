/** Answering a person wait, for a CLI verb or a plugin action. */

import type { FlowDefinition } from "../flow/types.ts";
import type { KernelState } from "../kernel/types.ts";
import type { JsonValue, LogBackend } from "../log/types.ts";
import type { Actor } from "../plugin/types.ts";
import { StateError } from "./errors.ts";
import { applyInput, readState } from "./service.ts";

export interface AnswerOptions {
  readonly log: LogBackend;
  readonly flow: FlowDefinition;
  readonly runId: string;
  readonly choice: string;
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
  readonly choice: string;
  readonly note?: string | undefined;
  readonly actor: Actor;
}

/** The payload a recorded answer carries, enough for `serve` to apply it later. */
export interface RecordedAnswerPayload {
  readonly kind: "person_answer";
  readonly waitId: string;
  readonly choice: string;
  readonly note?: string | undefined;
  readonly actor: { readonly via: string; readonly id: string };
}

function answerInput(
  runId: string,
  choice: string,
  note: string | undefined,
  actor: Actor,
): (wait: { readonly id: string; readonly choices: readonly string[] }) => RecordedAnswerPayload {
  return (wait) => {
    if (!wait.choices.includes(choice)) {
      throw new StateError(
        `run ${runId}: "${choice}" is not one of ${wait.choices
          .map((item) => `"${item}"`)
          .join(", ")}`,
      );
    }
    return {
      kind: "person_answer",
      waitId: wait.id,
      choice,
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
  const state = await readState(options.log, options.runId);
  const wait = state.wait;
  if (state.status !== "waiting_person" || wait === null) {
    throw new StateError(`run ${options.runId} is not waiting for a person`);
  }
  const payload = answerInput(
    options.runId,
    options.choice,
    options.note,
    options.actor,
  )(wait);
  await options.log.recordInput(
    options.runId,
    "person",
    `${options.runId}:answer:${wait.id}:${options.choice}`,
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
  answerInput(options.runId, options.choice, options.note, options.actor)(wait);

  const now = (options.clock ?? (() => Date.now()))();
  const result = await applyInput(
    options.log,
    options.flow,
    options.runId,
    state,
    {
      kind: "person_answer",
      waitId: wait.id,
      choice: options.choice,
      ...(options.note === undefined ? {} : { note: options.note }),
      actor: options.actor,
    },
    now,
    "person",
    `answer:${wait.id}:${options.choice}`,
    {
      beforeEnd: async (runId, ended) => {
        await options.onEnded?.(runId, ended);
      },
    },
  );
  return result.state;
}
