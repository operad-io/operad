import { END } from "../flow/types.ts";
import type { NewFact } from "../log/types.ts";
import type {
  CrashLoopStoppedPayload,
  EffectRequestedPayload,
  KernelState,
  PendingEffect,
  PendingWait,
  PersonAnsweredPayload,
  RunEndedPayload,
  RunStartedPayload,
  StepEnteredPayload,
  StepInterruptedPayload,
  StepResultPayload,
  WaitingForPersonPayload,
} from "./types.ts";

function read<T>(fact: NewFact): T {
  return fact.payload as unknown as T;
}

/** The empty state, before the first fact. */
export function initialState(): KernelState {
  return {
    status: "idle",
    started: false,
    params: null,
    step: null,
    stepKind: null,
    endedStatus: null,
    wait: null,
    effect: null,
    visits: {},
    recoveries: {},
    effects: {},
    results: {},
    answeredWaits: {},
    lastSeq: 0,
  };
}

/** Mark the outstanding effect as abandoned and forget it. */
function abandonEffect(
  state: KernelState,
  effectId: string | null,
): Pick<KernelState, "effect" | "effects"> {
  if (effectId === null) return { effect: state.effect, effects: state.effects };
  if (state.effects[effectId] !== "outstanding") {
    return {
      effect: state.effect !== null && state.effect.id === effectId ? null : state.effect,
      effects: state.effects,
    };
  }
  return {
    effect: state.effect !== null && state.effect.id === effectId ? null : state.effect,
    effects: { ...state.effects, [effectId]: "abandoned" },
  };
}

/** Apply one fact to one state. This is the only writer of kernel state. */
export function evolve(state: KernelState, fact: NewFact): KernelState {
  const lastSeq = state.lastSeq + 1;

  switch (fact.kind) {
    case "run_started": {
      if (state.started) return { ...state, lastSeq };
      const payload = read<RunStartedPayload>(fact);
      return {
        ...state,
        started: true,
        status: "running",
        params: payload.params ?? null,
        lastSeq,
      };
    }

    case "step_entered": {
      const payload = read<StepEnteredPayload>(fact);
      const abandoned = abandonEffect(state, state.effect === null ? null : state.effect.id);
      return {
        ...state,
        ...abandoned,
        status: "running",
        step: payload.step,
        stepKind: payload.kind,
        wait: null,
        visits: { ...state.visits, [payload.step]: payload.visit },
        lastSeq,
      };
    }

    case "effect_requested": {
      const payload = read<EffectRequestedPayload>(fact);
      const effect: PendingEffect = {
        id: payload.effectId,
        kind: payload.effect,
        step: payload.step,
        use: payload.use,
        params: payload.params,
        check: payload.check,
        due: payload.due,
        replay: payload.replay,
      };
      const recoveries = payload.recovery
        ? {
            ...state.recoveries,
            [payload.effectId]: (state.recoveries[payload.effectId] ?? 0) + 1,
          }
        : state.recoveries;
      return {
        ...state,
        status: payload.effect === "run_plugin_step" ? "running" : "waiting",
        step: payload.step,
        effect,
        wait: null,
        effects: { ...state.effects, [payload.effectId]: "outstanding" },
        recoveries,
        lastSeq,
      };
    }

    case "step_result": {
      const payload = read<StepResultPayload>(fact);
      if (state.effects[payload.effectId] !== "outstanding") {
        return { ...state, lastSeq };
      }
      return {
        ...state,
        status: "running",
        step: payload.step,
        effect: state.effect !== null && state.effect.id === payload.effectId ? null : state.effect,
        effects: { ...state.effects, [payload.effectId]: "done" },
        results: {
          ...state.results,
          [payload.effectId]: { result: payload.result, data: payload.data },
        },
        lastSeq,
      };
    }

    case "edge_taken": {
      const payload = read<{ readonly target: string }>(fact);
      const abandoned = abandonEffect(state, state.effect === null ? null : state.effect.id);
      return {
        ...state,
        ...abandoned,
        step: payload.target === END ? null : payload.target,
        stepKind: null,
        lastSeq,
      };
    }

    case "waiting_for_person": {
      const payload = read<WaitingForPersonPayload>(fact);
      const wait: PendingWait = {
        id: payload.waitId,
        step: payload.step,
        prompt: payload.prompt,
        choices: payload.choices,
        kind: payload.waitKind,
        effectId: payload.effectId,
      };
      return {
        ...state,
        status: "waiting_person",
        step: payload.step,
        stepKind: payload.waitKind === "step" ? "wait_person" : state.stepKind,
        wait,
        lastSeq,
      };
    }

    case "person_answered": {
      const payload = read<PersonAnsweredPayload>(fact);
      if (state.wait === null || state.wait.id !== payload.waitId) {
        return { ...state, lastSeq };
      }
      const effectId = state.wait.effectId;
      const recoveries =
        payload.waitKind === "crash_loop" && effectId !== null
          ? { ...state.recoveries, [effectId]: 0 }
          : state.recoveries;
      return {
        ...state,
        status: "running",
        step: payload.step,
        wait: null,
        recoveries,
        answeredWaits: { ...state.answeredWaits, [payload.waitId]: true },
        lastSeq,
      };
    }

    case "run_ended": {
      const payload = read<RunEndedPayload>(fact);
      const abandoned = abandonEffect(state, state.effect === null ? null : state.effect.id);
      return {
        ...state,
        ...abandoned,
        status: "ended",
        endedStatus: payload.status,
        step: null,
        stepKind: null,
        wait: null,
        lastSeq,
      };
    }

    case "step_interrupted": {
      const payload = read<StepInterruptedPayload>(fact);
      const abandoned = abandonEffect(state, payload.effectId);
      return { ...state, ...abandoned, status: "running", lastSeq };
    }

    case "crash_loop_stopped": {
      const payload = read<CrashLoopStoppedPayload>(fact);
      return {
        ...state,
        recoveries: { ...state.recoveries, [payload.effectId]: payload.recoveries },
        lastSeq,
      };
    }

    case "visit_limit_reached": {
      return { ...state, lastSeq };
    }

    default: {
      return { ...state, lastSeq };
    }
  }
}

/** Rebuild the state from a log, which is the only source of truth. */
export function replay(facts: readonly NewFact[]): KernelState {
  let state = initialState();
  for (const fact of facts) {
    state = evolve(state, fact);
  }
  return state;
}
