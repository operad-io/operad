import { END, type FlowDefinition, type Step } from "../flow/types.ts";
import type { FactCause, JsonValue } from "../log/types.ts";
import type {
  Decision,
  Effect,
  EffectRequestedPayload,
  FactKind,
  Input,
  KernelFact,
  KernelState,
  PendingEffect,
  StepInterruptedPayload,
} from "./types.ts";
import { inputCause } from "./types.ts";

/** The default number of times a run may enter the same step. */
export const DEFAULT_MAX_VISITS = 10;

/** How many recoveries without a result stop the run and ask a person. */
export const CRASH_LOOP_LIMIT = 3;

const CRASH_PROMPT = "This step keeps crashing. Retry it or cancel the run?";
const CRASH_CHOICES = ["retry", "cancel"];

function findStep(flow: FlowDefinition, id: string): Step | undefined {
  const found = flow.steps.find((step) => step.id === id);
  return found === undefined ? undefined : (found as Step);
}

function edgesOf(step: Step): Readonly<Record<string, string>> {
  return step.kind === "end" ? {} : step.next;
}

/** The result names the step may produce. */
function declaredResults(step: Step): readonly string[] {
  switch (step.kind) {
    case "end":
      return [];
    case "wait":
      return ["ready", "interrupted"];
    case "wait_person":
      return [...step.params.choices, "interrupted"];
    case "plugin":
      return Object.keys(step.next);
  }
}

function effectRequestedPayload(effect: PendingEffect, recovery: boolean): EffectRequestedPayload {
  return {
    effectId: effect.id,
    effect: effect.kind,
    step: effect.step,
    replay: effect.replay,
    recovery,
    use: effect.use,
    params: effect.params,
    check: effect.check,
    due: effect.due,
  };
}

function describeEffect(effect: PendingEffect): Effect {
  switch (effect.kind) {
    case "run_plugin_step":
      return {
        kind: "run_plugin_step",
        effectId: effect.id,
        step: effect.step,
        use: effect.use ?? "",
        params: effect.params,
        replay: effect.replay,
      };
    case "schedule_wake":
      return {
        kind: "schedule_wake",
        effectId: effect.id,
        step: effect.step,
        due: effect.due ?? 0,
      };
    case "poll_check":
      return {
        kind: "poll_check",
        effectId: effect.id,
        step: effect.step,
        check: effect.check ?? "",
      };
  }
}

/**
 * Turn one input into facts and effect descriptions. No I/O, no clock: `now`
 * is the caller's time, and the log's sequence numbers start at
 * `state.lastSeq + 1`.
 */
export function decide(
  flow: FlowDefinition,
  state: KernelState,
  input: Input,
  now: number,
): Decision {
  const facts: KernelFact[] = [];
  const effects: Effect[] = [];
  const base = state.lastSeq;
  const maxVisits = flow.maxVisits ?? DEFAULT_MAX_VISITS;
  const cause = inputCause(input);

  function push(kind: FactKind, payload: object, causedBy: FactCause): number {
    facts.push({ kind, payload: payload as unknown as JsonValue, cause: causedBy });
    return base + facts.length;
  }

  function endRun(status: "done" | "failed" | "cancelled", reason: string | null, causedBy: FactCause): void {
    push("run_ended", { status, reason }, causedBy);
  }

  function enter(stepId: string, causedBy: FactCause): void {
    const step = findStep(flow, stepId);
    if (step === undefined) {
      endRun("failed", `unknown step ${stepId}`, causedBy);
      return;
    }

    const visit = (state.visits[stepId] ?? 0) + 1;
    if (visit > maxVisits) {
      const limitSeq = push(
        "visit_limit_reached",
        { step: stepId, visits: visit, limit: maxVisits },
        causedBy,
      );
      endRun("failed", "visit_limit", limitSeq);
      return;
    }

    const enteredSeq = push(
      "step_entered",
      { step: stepId, visit, kind: step.kind },
      causedBy,
    );

    switch (step.kind) {
      case "end": {
        endRun(step.params.status, null, enteredSeq);
        return;
      }
      case "plugin": {
        const effectId = `${step.id}:${visit}`;
        const effect: PendingEffect = {
          id: effectId,
          kind: "run_plugin_step",
          step: step.id,
          use: step.params.use,
          params: step.params.params as unknown as JsonValue,
          check: null,
          due: null,
          replay: step.replay,
        };
        push("effect_requested", effectRequestedPayload(effect, false), enteredSeq);
        effects.push(describeEffect(effect));
        return;
      }
      case "wait_person": {
        const waitId = `${step.id}:${visit}`;
        const choices = [...step.params.choices];
        push(
          "waiting_for_person",
          {
            waitId,
            step: step.id,
            prompt: step.params.prompt,
            choices,
            waitKind: "step",
            effectId: null,
          },
          enteredSeq,
        );
        effects.push({
          kind: "notify_pending",
          waitId,
          step: step.id,
          prompt: step.params.prompt,
          choices,
          waitKind: "step",
        });
        return;
      }
      case "wait": {
        const effectId = `${step.id}:${visit}`;
        if ("afterSecs" in step.params) {
          const due = now + step.params.afterSecs * 1000;
          const effect: PendingEffect = {
            id: effectId,
            kind: "schedule_wake",
            step: step.id,
            use: null,
            params: null,
            check: null,
            due,
            replay: step.replay,
          };
          push("effect_requested", effectRequestedPayload(effect, false), enteredSeq);
          effects.push(describeEffect(effect));
        } else {
          const checkParams = step.params.params;
          const effect: PendingEffect = {
            id: effectId,
            kind: "poll_check",
            step: step.id,
            use: null,
            params:
              checkParams === undefined
                ? null
                : (checkParams as unknown as JsonValue),
            check: step.params.check,
            due: null,
            replay: step.replay,
          };
          push("effect_requested", effectRequestedPayload(effect, false), enteredSeq);
          effects.push(describeEffect(effect));
        }
        return;
      }
    }
  }

  function takeEdge(step: Step, result: string, causedBy: FactCause): void {
    const target = edgesOf(step)[result];
    if (target === undefined) {
      endRun("failed", `no edge for result ${result}`, causedBy);
      return;
    }
    const edgeSeq = push("edge_taken", { step: step.id, result, target }, causedBy);
    if (target === END) {
      endRun("done", null, edgeSeq);
      return;
    }
    enter(target, edgeSeq);
  }

  function requestAgain(effect: PendingEffect, causedBy: FactCause, recovery: boolean): void {
    push("effect_requested", effectRequestedPayload(effect, recovery), causedBy);
    effects.push(describeEffect(effect));
  }

  function stopForCrashLoop(effect: PendingEffect, recoveries: number, causedBy: FactCause): void {
    const stoppedSeq = push(
      "crash_loop_stopped",
      { step: effect.step, effectId: effect.id, recoveries },
      causedBy,
    );
    const waitId = `crash:${effect.id}`;
    const choices = [...CRASH_CHOICES];
    push(
      "waiting_for_person",
      {
        waitId,
        step: effect.step,
        prompt: CRASH_PROMPT,
        choices,
        waitKind: "crash_loop",
        effectId: effect.id,
      },
      stoppedSeq,
    );
    effects.push({
      kind: "notify_pending",
      waitId,
      step: effect.step,
      prompt: CRASH_PROMPT,
      choices,
      waitKind: "crash_loop",
    });
  }

  switch (input.kind) {
    case "start": {
      if (state.started || state.status !== "idle") return { facts, effects };
      const startedSeq = push("run_started", { flow: flow.name }, cause);
      enter(flow.entry, startedSeq);
      return { facts, effects };
    }

    case "step_result": {
      if (!state.started || state.status === "ended" || state.status === "idle") {
        return { facts, effects };
      }
      const effect = state.effect;
      if (
        effect === null ||
        effect.id !== input.effectId ||
        state.effects[input.effectId] !== "outstanding" ||
        state.step !== effect.step
      ) {
        return { facts, effects };
      }
      const step = findStep(flow, effect.step);
      if (step === undefined) return { facts, effects };

      if (!declaredResults(step).includes(input.result)) {
        const payload: StepInterruptedPayload = {
          step: effect.step,
          effectId: effect.id,
          reason: "undeclared_result",
          result: input.result,
        };
        const interruptedSeq = push("step_interrupted", { ...payload }, cause);
        takeEdge(step, "interrupted", interruptedSeq);
        return { facts, effects };
      }

      const resultSeq = push(
        "step_result",
        {
          effectId: effect.id,
          step: effect.step,
          result: input.result,
          data: input.data ?? null,
        },
        cause,
      );
      takeEdge(step, input.result, resultSeq);
      return { facts, effects };
    }

    case "person_answer": {
      const wait = state.wait;
      if (
        state.status !== "waiting_person" ||
        wait === null ||
        wait.id !== input.waitId ||
        !wait.choices.includes(input.choice)
      ) {
        return { facts, effects };
      }
      const answerSeq = push(
        "person_answered",
        {
          waitId: wait.id,
          step: wait.step,
          choice: input.choice,
          note: input.note ?? null,
          waitKind: wait.kind,
          actor:
            input.actor === undefined
              ? null
              : { via: input.actor.via, id: input.actor.id },
        },
        cause,
      );

      if (wait.kind === "crash_loop") {
        if (input.choice === "cancel") {
          endRun("cancelled", null, answerSeq);
          return { facts, effects };
        }
        if (state.effect !== null) requestAgain(state.effect, answerSeq, false);
        return { facts, effects };
      }

      const step = findStep(flow, wait.step);
      if (step === undefined) {
        endRun("failed", `unknown step ${wait.step}`, answerSeq);
        return { facts, effects };
      }
      takeEdge(step, input.choice, answerSeq);
      return { facts, effects };
    }

    case "tick": {
      if (!state.started || state.status === "ended" || state.status === "waiting_person") {
        return { facts, effects };
      }
      const effect = state.effect;
      if (effect === null || effect.kind !== "schedule_wake" || effect.due === null) {
        return { facts, effects };
      }
      if (now < effect.due) return { facts, effects };

      const step = findStep(flow, effect.step);
      if (step === undefined) return { facts, effects };
      const readySeq = push(
        "step_result",
        {
          effectId: effect.id,
          step: effect.step,
          result: "ready",
          data: { at: now },
        },
        cause,
      );
      takeEdge(step, "ready", readySeq);
      return { facts, effects };
    }

    case "recover": {
      if (
        !state.started ||
        state.status === "idle" ||
        state.status === "ended" ||
        state.status === "waiting_person"
      ) {
        return { facts, effects };
      }
      const effect = state.effect;
      if (
        effect === null ||
        state.effects[effect.id] !== "outstanding" ||
        state.step !== effect.step
      ) {
        return { facts, effects };
      }
      const step = findStep(flow, effect.step);
      if (step === undefined) return { facts, effects };

      const recoveries = (state.recoveries[effect.id] ?? 0) + 1;
      if (recoveries >= CRASH_LOOP_LIMIT) {
        stopForCrashLoop(effect, recoveries, cause);
        return { facts, effects };
      }

      if (step.replay === "safe") {
        requestAgain(effect, cause, true);
        return { facts, effects };
      }

      const interruptedSeq = push(
        "step_interrupted",
        {
          step: effect.step,
          effectId: effect.id,
          reason: "recover_unsafe",
          result: null,
        },
        cause,
      );
      takeEdge(step, "interrupted", interruptedSeq);
      return { facts, effects };
    }

    case "cancel": {
      if (!state.started || state.status === "idle" || state.status === "ended") {
        return { facts, effects };
      }
      endRun("cancelled", "cancel", cause);
      return { facts, effects };
    }
  }
}
