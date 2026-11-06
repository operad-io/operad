/** Answering a person wait, for a CLI verb or a plugin action. */

import type { FlowDefinition } from "../flow/types.ts";
import type { KernelState } from "../kernel/types.ts";
import type { LogBackend } from "../log/types.ts";
import { StateError } from "./errors.ts";
import { applyInput, readState } from "./service.ts";

export interface AnswerOptions {
  readonly log: LogBackend;
  readonly flow: FlowDefinition;
  readonly runId: string;
  readonly choice: string;
  readonly note?: string | undefined;
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
  if (!wait.choices.includes(options.choice)) {
    throw new StateError(
      `run ${options.runId}: "${options.choice}" is not one of ${wait.choices
        .map((choice) => `"${choice}"`)
        .join(", ")}`,
    );
  }

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
