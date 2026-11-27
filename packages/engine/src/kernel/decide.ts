import { END, type FlowDefinition, type Step } from "../flow/types.ts";
import type { FactCause, JsonValue } from "../log/types.ts";
import { MAX_TRIGGER_HOPS } from "../trigger/types.ts";
import type { Actor, AskQuestion, AskQuestionAnswer } from "../plugin/types.ts";
import type {
  Decision,
  Effect,
  EffectRequestedPayload,
  FactKind,
  Grant,
  Input,
  KernelFact,
  KernelState,
  PendingEffect,
  RunStartedPayload,
  StepInterruptedPayload,
} from "./types.ts";
import { inputCause } from "./types.ts";
import { storedAskCommand } from "../plugin/ask-command.ts";
import { storedChoiceInfo,type ChoiceInfoMap } from "../plugin/choice-info.ts";
import { answersJson, normalizeAnswers, storedAnswers, storedQuestions } from "../plugin/question-form.ts";
import { isRecord } from "../util.ts";

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
/** The `message` a step's data carries, as a field to spread into a payload. */
function messageField(data: JsonValue | undefined): { readonly message?: string } {
  if (!isRecord(data)) return {};
  const message = (data as { readonly message?: unknown }).message;
  return typeof message === "string" && message.length > 0 ? { message } : {};
}

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

/** A question a step asked and could not wait for; the flow wait carries it on. */
interface AskedVia {
  readonly waitId: string;
  readonly prompt: string;
  readonly choices: readonly string[];
  readonly choiceInfo: ChoiceInfoMap | undefined;
  /** The form the step asked, when it asked one. */
  readonly questions: readonly AskQuestion[] | undefined;
  /** The command the person runs, when the question carried one. */
  readonly command: string | undefined;
  readonly resume: JsonValue;
}

/** A question the person answered, on the way back to the step that asked. */
interface AnsweredAsk {
  readonly waitId: string;
  readonly step: string;
  readonly prompt: string;
  readonly resume: JsonValue;
  readonly choice: string | null;
  /** The person's answer to each question, when the question was a form. */
  readonly answers?: readonly AskQuestionAnswer[] | undefined;
  /** The form the person answered, so a resumed step can name each answer. */
  readonly questions?: readonly AskQuestion[] | undefined;
  readonly note: string | null;
  readonly actor: Actor | null;
}

type EnterVia = {
  readonly step: string;
  readonly result: string;
  readonly named?: string;
  readonly ask?: AskedVia;
  readonly answered?: AnsweredAsk;
};

/**
 * The params the step runs again with after its question was answered: the
 * params it had, the session it left, and the answer. Anything the step did
 * not leave is simply absent.
 */
function resumedParams(base: JsonValue, answered: AnsweredAsk): JsonValue {
  const resume = answered.resume;
  const session =
    typeof resume === "string"
      ? resume
      : isRecord(resume) && typeof resume.session === "string"
        ? resume.session
        : undefined;
  return {
    ...(isRecord(base) ? base : {}),
    ...(session === undefined ? {} : { resumeSession: session }),
    askAnswer: {
      prompt: answered.prompt,
      ...(answered.choice === null ? {} : { choice: answered.choice }),
      ...(answered.answers === undefined ? {} : { answers: answersJson(answered.answers) }),
      ...(answered.questions === undefined ? {} : { questions: answered.questions as unknown as JsonValue }),
      ...(answered.note === null ? {} : { note: answered.note }),
      ...(answered.actor === null ? {} : { actor: { via: answered.actor.via, id: answered.actor.id } }),
    },
  };
}

/**
 * The edge a form's answer takes in the wait step that caught the timeout: the
 * one the asker named, else the answer's own choice when it is an edge, else
 * the step's first choice that is an edge.
 */
function formEdge(
  step: Step,
  resume: JsonValue,
  choice: string | undefined,
): string | undefined {
  const edges = edgesOf(step);
  const named = isRecord(resume) && typeof resume.choice === "string" ? resume.choice : undefined;
  if (named !== undefined && edges[named] !== undefined) return named;
  if (choice !== undefined && edges[choice] !== undefined) return choice;
  if (step.kind === "wait_person") {
    for (const candidate of step.params.choices) {
      if (edges[candidate] !== undefined) return candidate;
    }
  }
  return undefined;
}

/** The one-time permission the call the step asked about gets, if it named one. */
function grantsFrom(answered: AnsweredAsk): readonly Grant[] | undefined {
  const resume = answered.resume;
  if (!isRecord(resume)) return undefined;
  const grant = resume.grant;
  if (
    !isRecord(grant) ||
    (grant.kind !== "command" && grant.kind !== "path") ||
    typeof grant.value !== "string" ||
    grant.value.length === 0
  ) {
    return undefined;
  }
  // Only a choice that approves gives the permission: the one the step named,
  // every choice in its `choices` list, or "approve" when it named none
  // (`ctx.ask` refuses a question with choices that names none).
  const approves = new Set<string>();
  if (typeof grant.choice === "string") approves.add(grant.choice);
  if (Array.isArray(grant.choices)) {
    for (const choice of grant.choices) {
      if (typeof choice === "string") approves.add(choice);
    }
  }
  if (approves.size === 0) approves.add("approve");
  if (answered.choice === null || !approves.has(answered.choice)) return undefined;
  return [
    {
      waitId: answered.waitId,
      kind: grant.kind,
      value: grant.value,
      ...(typeof grant.tool === "string" ? { tool: grant.tool } : {}),
    },
  ];
}

/** The question in the data of a `waiting` result, when it is well formed. */
function askedIn(result: string, data: unknown): AskedVia | undefined {
  if (result !== "waiting") return undefined;
  if (!isRecord(data)) {
    return undefined;
  }
  const record = data;
  if (typeof record.waitId !== "string" || record.waitId.length === 0) {
    return undefined;
  }
  if (typeof record.prompt !== "string") return undefined;
  const choices = Array.isArray(record.choices)
    ? record.choices.filter((item): item is string => typeof item === "string")
    : [];
  return {
    waitId: record.waitId,
    prompt: record.prompt,
    choices,
    choiceInfo: storedChoiceInfo(record.choiceInfo, choices),
    questions: storedQuestions(record.questions),
    command: storedAskCommand(record.command),
    resume: (record.resume ?? null) as JsonValue,
  };
}

/** The step a result names, when its data came from a step that stopped. */
function stepNameOf(data: unknown): string | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const step = data.step;
  return typeof step === "string" && step.length > 0 ? step : undefined;
}

/**
 * The prompt a person sees. A wait reached by an interrupted result appends
 * the wait's note, with `{step}` naming the step that stopped.
 */
function waitPrompt(
  params: { readonly prompt: string; readonly note?: string | undefined },
  via: EnterVia | undefined,
): string {
  if (via?.result !== "interrupted" || params.note === undefined) {
    return params.prompt;
  }
  const named = via.named ?? via.step;
  return `${params.prompt}\n\n${params.note.replaceAll("{step}", named)}`;
}

function effectRequestedPayload(effect: PendingEffect, recovery: boolean): EffectRequestedPayload {
  return {
    ...(effect.grants === undefined ? {} : { grants: effect.grants }),
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
        params: effect.params,
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
    if (state.hops + 1 > MAX_TRIGGER_HOPS) {
      push(
        "trigger_skipped",
        {
          source: "operad",
          type: `run.${status}`,
          key: "",
          hops: state.hops + 1,
          reason: `the chain is ${state.hops + 1} hops deep; at most ${MAX_TRIGGER_HOPS} are followed`,
        },
        causedBy,
      );
    }
    push("run_ended", { status, reason }, causedBy);
  }

  function enter(
    stepId: string,
    causedBy: FactCause,
    via?: EnterVia,
  ): void {
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
        // The step that asked, back after the answer: it continues the same
        // session with the answer and, for the call it asked about, a grant.
        // The answer waits in the state, so it reaches the step whatever path
        // the flow took from the wait back to it.
        const answered =
          via?.answered?.step === step.id
            ? via.answered
            : state.answeredAsk?.step === step.id
              ? state.answeredAsk
              : undefined;
        const grants = answered === undefined ? undefined : grantsFrom(answered);
        const effect: PendingEffect = {
          id: effectId,
          kind: "run_plugin_step",
          step: step.id,
          use: step.params.use,
          params:
            answered === undefined
              ? (step.params.params as unknown as JsonValue)
              : resumedParams(step.params.params as unknown as JsonValue, answered),
          check: null,
          due: null,
          replay: step.replay,
          ...(grants === undefined ? {} : { grants }),
        };
        push("effect_requested", effectRequestedPayload(effect, false), enteredSeq);
        effects.push(describeEffect(effect));
        return;
      }
      case "wait_person": {
        // A step that asked and ran out of grace hands its question over: the
        // wait keeps the question's id, so nobody sees it twice.
        const asked = via?.ask;
        const waitId = asked?.waitId ?? `${step.id}:${visit}`;
        const own = [...step.params.choices];
        const allowed = new Set([...own, ...(step.params.lateChoices ?? [])]);
        // A form shows its questions, never the choices of the wait step that
        // caught the timeout.
        const questions = asked?.questions;
        const choices =
          questions !== undefined && questions.length > 0 && asked !== undefined
            ? [...asked.choices]
            : asked !== undefined &&
                asked.choices.length > 0 &&
                asked.choices.every((choice) => allowed.has(choice))
              ? [...asked.choices]
              : own;
        const prompt = asked?.prompt ?? waitPrompt(step.params, via);
        const choiceInfo = storedChoiceInfo(
          asked?.choiceInfo ?? step.params.choiceInfo,
          choices,
        );
        push(
          "waiting_for_person",
          {
            waitId,
            step: step.id,
            prompt,
            choices,
            ...(choiceInfo === undefined ? {} : { choiceInfo }),
            ...(questions === undefined ? {} : { questions }),
            ...(asked?.command === undefined ? {} : { command: asked.command }),
            waitKind: "step",
            effectId: null,
            ...(asked === undefined || via === undefined
              ? {}
              : {
                  ask: {
                    step: via.step,
                    resume: asked.resume,
                    ...(questions === undefined ? {} : { questions }),
                  },
                }),
          },
          enteredSeq,
        );
        effects.push({
          kind: "notify_pending",
          waitId,
          step: step.id,
          prompt,
          choices,
          ...(choiceInfo === undefined ? {} : { choiceInfo }),
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

  function takeEdge(
    step: Step,
    result: string,
    causedBy: FactCause,
    named?: string,
    ask?: AskedVia,
    answered?: AnsweredAsk,
  ): void {
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
    enter(target, edgeSeq, {
      step: step.id,
      result,
      ...(named === undefined ? {} : { named }),
      ...(ask === undefined ? {} : { ask }),
      ...(answered === undefined ? {} : { answered }),
    });
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
      const payload: RunStartedPayload = {
        flow: flow.name,
        ...(input.params === undefined ? {} : { params: input.params }),
        ...(input.access === undefined ? {} : { access: input.access }),
        ...(input.hops === undefined ? {} : { hops: input.hops }),
        ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
      };
      const startedSeq = push("run_started", payload, cause);
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
          ...messageField(input.data),
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
      takeEdge(
        step,
        input.result,
        resultSeq,
        stepNameOf(input.data),
        askedIn(input.result, input.data),
      );
      return { facts, effects };
    }

    case "person_answer": {
      const wait = state.wait;
      const questions = wait?.questions;
      const isForm = questions !== undefined && questions.length > 0;
      const given = isForm ? storedAnswers(input.answers, questions) : undefined;
      const lone = isForm && given === undefined && input.choice !== undefined && wait !== null && wait.choices.includes(input.choice);
      const acceptable =
        state.status === "waiting_person" &&
        wait !== null &&
        wait.id === input.waitId &&
        (isForm
          ? given !== undefined || lone
          : input.choice !== undefined && wait.choices.includes(input.choice));
      if (!acceptable) {
        return { facts, effects };
      }
      const answers =
        isForm && questions !== undefined && wait !== null
          ? (given ??
              normalizeAnswers(
                [{ id: questions[0]?.id, choices: [input.choice] }],
                questions,
              ) ??
              null)
          : null;
      const answerSeq = push(
        "person_answered",
        {
          waitId: wait.id,
          step: wait.step,
          choice: input.choice ?? null,
          note: input.note ?? null,
          ...(answers === null ? {} : { answers: answersJson(answers) }),
          waitKind: wait.kind,
          actor: { via: input.actor.via, id: input.actor.id },
          ...(wait.ask === undefined
            ? {}
            : {
                ask: {
                  step: wait.ask.step,
                  prompt: wait.prompt,
                  resume: wait.ask.resume,
                  ...(wait.ask.questions === undefined
                    ? {}
                    : { questions: wait.ask.questions }),
                },
              }),
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
      // A form's answer is not one of the wait step's choices: the edge it
      // takes is the one the asker named, else the wait's first choice. The
      // answer itself is what reaches the step that asked.
      const edge = isForm
        ? formEdge(step, wait.ask?.resume ?? null, input.choice)
        : (input.choice as string);
      if (edge === undefined) {
        endRun("failed", "no edge for the answer to a form", answerSeq);
        return { facts, effects };
      }
      takeEdge(
        step,
        edge,
        answerSeq,
        undefined,
        undefined,
        wait.ask === undefined
          ? undefined
          : {
              waitId: wait.id,
              step: wait.ask.step,
              prompt: wait.prompt,
              resume: wait.ask.resume,
              choice: input.choice ?? null,
              answers: answers === null ? undefined : answers,
              ...(questions === undefined ? {} : { questions }),
              note: input.note ?? null,
              actor: { via: input.actor.via, id: input.actor.id },
            },
      );
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
