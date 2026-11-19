/**
 * A question a harness's agent asked a person, as the kernel's form
 * (ADR 0026 D6). Each harness reads its own protocol's question into
 * `HarnessQuestion`; this module turns that into the one shape `ctx.ask`
 * carries, and reads the person's answer back for the harness to send on.
 *
 * The one shape is the kernel's: a question has an id, its text, a short
 * header, choices with a label and a description, whether more than one may be
 * picked, and whether the person may answer in their own words. An answer names
 * the question by its id and carries labels, text, or `skipped`.
 */

import type { AskQuestion, AskQuestionAnswer, AskQuestionChoice, AskRequest } from "@operad-io/engine";

/** One choice a harness's agent offered. */
export interface HarnessQuestionChoice {
  readonly label: string;
  readonly description?: string | undefined;
}

/** One question a harness's agent asked, in the harness's own words. */
export interface HarnessQuestion {
  /** What the harness names this question by; empty for a harness without ids. */
  readonly id: string;
  readonly text: string;
  readonly header?: string | undefined;
  readonly choices?: readonly HarnessQuestionChoice[] | undefined;
  /** True when the person may pick more than one choice. */
  readonly multiple?: boolean | undefined;
  /** True when the person may type an answer of their own. */
  readonly freeText?: boolean | undefined;
}

/** A leading `Other`-style label is the free text a harness adds itself. */
function isOther(label: string): boolean {
  return label.trim().toLowerCase() === "other";
}

/**
 * The kernel's form from a harness's questions. An empty id becomes `q<n>`, a
 * duplicate id gets a suffix, and an empty choice label or question text is
 * left out: the kernel refuses the shape otherwise, and no answer could be
 * matched to it.
 */
export function askQuestions(questions: readonly HarnessQuestion[]): AskQuestion[] {
  const used = new Set<string>();
  const form: AskQuestion[] = [];
  for (const [index, question] of questions.entries()) {
    const text = question.text.trim();
    if (text.length === 0) continue;
    const base = question.id.trim().length > 0 ? question.id.trim() : `q${index + 1}`;
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
    used.add(id);
    const choices: AskQuestionChoice[] = [];
    for (const choice of question.choices ?? []) {
      const label = choice.label.trim();
      if (label.length === 0 || isOther(label)) continue;
      if (choices.some((existing) => existing.label === label)) continue;
      choices.push({
        label,
        ...(choice.description === undefined || choice.description.trim().length === 0
          ? {}
          : { description: choice.description.trim() }),
      });
    }
    form.push({
      id,
      text,
      ...(question.header === undefined || question.header.trim().length === 0
        ? {}
        : { header: question.header.trim() }),
      ...(choices.length === 0 ? {} : { choices }),
      ...(question.multiple === true ? { multiple: true } : {}),
      ...(question.freeText === true || (question.choices ?? []).some((choice) => isOther(choice.label))
        ? { freeText: true }
        : {}),
    });
  }
  return form;
}

/** The request `ctx.ask` gets for a form: its text, and the answer's way back. */
export function formRequest(
  form: readonly AskQuestion[],
  resume: unknown,
  options: {
    readonly graceSecs?: number | undefined;
    readonly onTimeout?: "waiting" | "reject_once" | undefined;
  } = {},
): AskRequest {
  return {
    prompt: form.map((question) => question.text).join("\n\n"),
    questions: form,
    ...(options.graceSecs === undefined ? {} : { graceSecs: options.graceSecs }),
    ...(options.onTimeout === undefined ? {} : { onTimeout: options.onTimeout }),
    resume: resume as AskRequest["resume"],
  };
}

/** The person's answer to one question, or undefined when they gave none. */
export function answerFor(
  answers: readonly AskQuestionAnswer[] | undefined,
  id: string,
): AskQuestionAnswer | undefined {
  return answers?.find((answer) => answer.id === id);
}

/** The labels and free text of one answer, in one string; empty when skipped. */
export function answerText(answer: AskQuestionAnswer | undefined): string {
  if (answer === undefined || answer.skipped === true) return "";
  return [...(answer.choices ?? []), ...(answer.text === undefined ? [] : [answer.text])].join(", ");
}

/** True when the person left this question alone. */
export function isSkipped(answer: AskQuestionAnswer | undefined): boolean {
  return answer === undefined || answer.skipped === true;
}
