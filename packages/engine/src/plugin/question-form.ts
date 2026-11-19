/**
 * A form a step asks a person: one or more questions, each with its choices,
 * single or multiple, free text allowed, and the person's answer per question.
 * The kernel checks the shape and bounds, then carries it: it gives no question
 * a meaning of its own and speaks no vendor's field names.
 */

import { isRecord } from "../util.ts";
import type { JsonValue } from "../log/types.ts";
import type { AskQuestion, AskQuestionAnswer, AskQuestionChoice } from "./types.ts";

/** The most questions one form may carry. */
export const MAX_FORM_QUESTIONS = 8;

/** The most choices one question may offer. */
export const MAX_QUESTION_CHOICES = 8;

/** The longest question text. */
export const MAX_QUESTION_TEXT = 500;

/** The longest header a question may carry. */
export const MAX_QUESTION_HEADER = 40;

/** The longest choice label. */
export const MAX_QUESTION_CHOICE_LABEL = 80;

/** The longest choice description. */
export const MAX_QUESTION_CHOICE_DESCRIPTION = 280;

/** The longest free-text answer. */
export const MAX_QUESTION_ANSWER_TEXT = 4000;

const QUESTION_FIELDS = new Set(["id", "text", "header", "choices", "multiple", "freeText"]);
const CHOICE_FIELDS = new Set(["label", "description"]);
const ANSWER_FIELDS = new Set(["id", "choices", "text", "skipped"]);

/**
 * The labels a client that cannot draw a form can still answer with: the one
 * question's choices, when the form is one single-answer question that takes no
 * free text. Any other form gives none.
 */
export function formChoices(questions: readonly AskQuestion[]): string[] {
  if (questions.length !== 1) return [];
  const question = questions[0];
  if (question === undefined || question.freeText === true || question.multiple === true) return [];
  return (question.choices ?? []).map((choice) => choice.label);
}

/** The text a form shows where only one line fits: each question on its own line. */
export function formPrompt(questions: readonly AskQuestion[]): string {
  return questions.map((question) => question.text).join("\n\n");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function choiceProblem(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at}: must be an object with a label`;
  for (const field of Object.keys(value)) {
    if (!CHOICE_FIELDS.has(field)) return `${at}.${field}: is not a field of a choice`;
  }
  if (!nonEmpty(value.label)) return `${at}.label: must be a non-empty string`;
  if (value.label.length > MAX_QUESTION_CHOICE_LABEL) {
    return `${at}.label: must be at most ${MAX_QUESTION_CHOICE_LABEL} characters`;
  }
  if (value.description !== undefined) {
    if (typeof value.description !== "string") return `${at}.description: must be a string`;
    if (value.description.length > MAX_QUESTION_CHOICE_DESCRIPTION) {
      return `${at}.description: must be at most ${MAX_QUESTION_CHOICE_DESCRIPTION} characters`;
    }
  }
  return undefined;
}

/**
 * What is wrong with a `questions` value, if anything. The returned text names
 * the question and field; the caller adds its own prefix.
 */
export function questionsProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    return "must be a list of at least one question";
  }
  if (value.length > MAX_FORM_QUESTIONS) {
    return `must carry at most ${MAX_FORM_QUESTIONS} questions`;
  }
  const ids = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const at = `questions[${index}]`;
    if (!isRecord(raw)) return `${at}: must be an object`;
    for (const field of Object.keys(raw)) {
      if (!QUESTION_FIELDS.has(field)) return `${at}.${field}: is not a field of a question`;
    }
    if (!nonEmpty(raw.id)) return `${at}.id: must be a non-empty string`;
    if (ids.has(raw.id)) return `${at}.id: "${raw.id}" names an earlier question`;
    ids.add(raw.id);
    if (!nonEmpty(raw.text)) return `${at}.text: must be a non-empty string`;
    if (raw.text.length > MAX_QUESTION_TEXT) {
      return `${at}.text: must be at most ${MAX_QUESTION_TEXT} characters`;
    }
    if (raw.header !== undefined) {
      if (typeof raw.header !== "string") return `${at}.header: must be a string`;
      if (raw.header.length > MAX_QUESTION_HEADER) {
        return `${at}.header: must be at most ${MAX_QUESTION_HEADER} characters`;
      }
    }
    if (raw.choices !== undefined) {
      if (!Array.isArray(raw.choices)) return `${at}.choices: must be a list of choices`;
      if (raw.choices.length > MAX_QUESTION_CHOICES) {
        return `${at}.choices: must offer at most ${MAX_QUESTION_CHOICES} choices`;
      }
      const labels = new Set<string>();
      for (const [position, choice] of raw.choices.entries()) {
        const choiceAt = `${at}.choices[${position}]`;
        const problem = choiceProblem(choice, choiceAt);
        if (problem !== undefined) return problem;
        const label = (choice as Record<string, unknown>).label as string;
        if (labels.has(label)) return `${choiceAt}.label: "${label}" names an earlier choice`;
        labels.add(label);
      }
    }
    for (const field of ["multiple", "freeText"] as const) {
      if (raw[field] !== undefined && typeof raw[field] !== "boolean") {
        return `${at}.${field}: must be true or false`;
      }
    }
  }
  return undefined;
}

/** Copies the fields the kernel knows from a value it has already checked. */
export function normalizeQuestions(value: unknown): readonly AskQuestion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const questions: AskQuestion[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || !nonEmpty(raw.id) || typeof raw.text !== "string") continue;
    const choices: AskQuestionChoice[] = [];
    if (Array.isArray(raw.choices)) {
      for (const choice of raw.choices) {
        if (!isRecord(choice) || !nonEmpty(choice.label)) continue;
        choices.push({
          label: choice.label,
          ...(typeof choice.description === "string" ? { description: choice.description } : {}),
        });
      }
    }
    questions.push({
      id: raw.id,
      text: raw.text,
      ...(typeof raw.header === "string" ? { header: raw.header } : {}),
      ...(choices.length === 0 ? {} : { choices }),
      ...(raw.multiple === true ? { multiple: true } : {}),
      ...(raw.freeText === true ? { freeText: true } : {}),
    });
  }
  return questions.length === 0 ? undefined : questions;
}

/**
 * Reads a form a fact or a step's data carries. A value that cannot be read is
 * left out, so an old or corrupt log does not hide a question.
 */
export function storedQuestions(value: unknown): readonly AskQuestion[] | undefined {
  if (value === undefined) return undefined;
  if (questionsProblem(value) !== undefined) return undefined;
  return normalizeQuestions(value);
}

/** The form as a fact payload stores it; it holds only JSON values. */
export function questionsJson(questions: readonly AskQuestion[]): JsonValue {
  return questions as unknown as JsonValue;
}

/**
 * What is wrong with a person's `answers` for this form, if anything. Missing
 * questions are the person skipping them, not an error.
 */
export function answersProblem(
  value: unknown,
  questions: readonly AskQuestion[],
): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return "must be a list of answers";
  if (value.length > questions.length) {
    return `must carry at most one answer per question (${questions.length})`;
  }
  const byId = new Map(questions.map((question) => [question.id, question]));
  const seen = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const at = `answers[${index}]`;
    if (!isRecord(raw)) return `${at}: must be an object`;
    for (const field of Object.keys(raw)) {
      if (!ANSWER_FIELDS.has(field)) return `${at}.${field}: is not a field of an answer`;
    }
    if (typeof raw.id !== "string" || !byId.has(raw.id)) {
      return `${at}.id: must name one of the form's questions`;
    }
    if (seen.has(raw.id)) return `${at}.id: "${raw.id}" is answered twice`;
    seen.add(raw.id);
    const question = byId.get(raw.id) as AskQuestion;
    const skipped = raw.skipped === true;
    if (raw.skipped !== undefined && raw.skipped !== true) {
      return `${at}.skipped: must be true when it is set`;
    }
    if (raw.choices !== undefined) {
      if (!Array.isArray(raw.choices)) return `${at}.choices: must be a list of labels`;
      const labels = (question.choices ?? []).map((choice) => choice.label);
      const picked = new Set<string>();
      for (const label of raw.choices) {
        if (typeof label !== "string" || !labels.includes(label)) {
          return `${at}.choices: "${String(label)}" is not one of the question's choices`;
        }
        if (picked.has(label)) return `${at}.choices: "${label}" is picked twice`;
        picked.add(label);
      }
      if (raw.choices.length > 1 && question.multiple !== true) {
        return `${at}.choices: this question takes one choice`;
      }
      if (raw.choices.length > 0 && skipped) {
        return `${at}: a skipped question carries no choice`;
      }
    }
    if (raw.text !== undefined) {
      if (typeof raw.text !== "string") return `${at}.text: must be a string`;
      if (raw.text.length > MAX_QUESTION_ANSWER_TEXT) {
        return `${at}.text: must be at most ${MAX_QUESTION_ANSWER_TEXT} characters`;
      }
      if (question.freeText !== true) return `${at}.text: this question takes no free text`;
      if (skipped && raw.text.trim().length > 0) {
        return `${at}: a skipped question carries no text`;
      }
    }
  }
  return undefined;
}

/**
 * The answers the person gave, one for each question in the form's order, with
 * `skipped` where they gave none.
 */
export function normalizeAnswers(
  value: unknown,
  questions: readonly AskQuestion[],
): readonly AskQuestionAnswer[] | undefined {
  if (value === undefined) return undefined;
  const given = new Map<string, Record<string, unknown>>();
  if (Array.isArray(value)) {
    for (const raw of value) {
      if (!isRecord(raw) || typeof raw.id !== "string") continue;
      given.set(raw.id, raw);
    }
  }
  return questions.map((question): AskQuestionAnswer => {
    const raw = given.get(question.id);
    if (raw === undefined) return { id: question.id, skipped: true };
    const choices = Array.isArray(raw.choices)
      ? raw.choices.filter((label): label is string => typeof label === "string")
      : [];
    const text = typeof raw.text === "string" && raw.text.trim().length > 0 ? raw.text : undefined;
    if (raw.skipped === true || (choices.length === 0 && text === undefined)) {
      return { id: question.id, skipped: true };
    }
    return {
      id: question.id,
      ...(choices.length === 0 ? {} : { choices }),
      ...(text === undefined ? {} : { text }),
    };
  });
}

/**
 * The answers a recorded input carries, before the kernel checks them against
 * the form they answer. Entries without a question id are left out.
 */
export function looseAnswers(value: unknown): readonly AskQuestionAnswer[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const answers: AskQuestionAnswer[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.id !== "string") continue;
    const choices = Array.isArray(raw.choices)
      ? raw.choices.filter((label): label is string => typeof label === "string")
      : [];
    answers.push({
      id: raw.id,
      ...(choices.length === 0 ? {} : { choices }),
      ...(typeof raw.text === "string" ? { text: raw.text } : {}),
      ...(raw.skipped === true ? { skipped: true as const } : {}),
    });
  }
  return answers.length === 0 ? undefined : answers;
}

/**
 * A person's answer to a form as a fact or a step's data carries it. Invalid
 * entries are left out, so a log never holds an answer the form did not offer.
 */
export function storedAnswers(
  value: unknown,
  questions: readonly AskQuestion[],
): readonly AskQuestionAnswer[] | undefined {
  if (value === undefined) return undefined;
  if (answersProblem(value, questions) !== undefined) return undefined;
  return normalizeAnswers(value, questions);
}

/** The answers as a fact payload stores them; they hold only JSON values. */
export function answersJson(answers: readonly AskQuestionAnswer[]): JsonValue {
  return answers as unknown as JsonValue;
}
