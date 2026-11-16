/**
 * What a question's choices say about themselves. The kernel checks the shape
 * and bounds, then carries it: it never gives a choice a meaning of its own.
 */

import { isRecord } from "../util.ts";
import type { JsonValue } from "../log/types.ts";
import type { ChoiceInfo } from "./types.ts";

/** The longest label a choice may carry. */
export const MAX_CHOICE_LABEL_LENGTH = 80;

/** The longest hint a choice may carry. */
export const MAX_CHOICE_HINT_LENGTH = 280;

/** Choice information keyed by the choice string an answer sends. */
export type ChoiceInfoMap = Readonly<Record<string, ChoiceInfo>>;

/** The value as a fact payload stores it; it holds only strings. */
export function choiceInfoJson(value: ChoiceInfoMap): JsonValue {
  return value as unknown as JsonValue;
}

const FIELDS = new Set(["label", "hint", "role", "note"]);

function quoted(choices: readonly string[]): string {
  return choices.map((choice) => `"${choice}"`).join(", ");
}

/**
 * What is wrong with a `choiceInfo` value for these choices, if anything. The
 * returned text names the choice and field; the caller adds its own prefix.
 */
export function choiceInfoProblem(
  value: unknown,
  choices: readonly string[],
): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    return "must be an object keyed by the choices";
  }
  let primary = 0;
  for (const [choice, raw] of Object.entries(value)) {
    const at = `choiceInfo.${choice}`;
    if (!choices.includes(choice)) {
      return `${at}: must name one of the choices${choices.length === 0 ? "" : ` (${quoted(choices)})`}`;
    }
    if (!isRecord(raw)) {
      return `${at}: must be an object`;
    }
    for (const field of Object.keys(raw)) {
      if (!FIELDS.has(field)) {
        return `${at}.${field}: is not a field of choice info`;
      }
    }
    if (raw.label !== undefined) {
      if (typeof raw.label !== "string" || raw.label.trim().length === 0) {
        return `${at}.label: must be a non-empty string`;
      }
      if (raw.label.length > MAX_CHOICE_LABEL_LENGTH) {
        return `${at}.label: must be at most ${MAX_CHOICE_LABEL_LENGTH} characters`;
      }
    }
    if (raw.hint !== undefined) {
      if (typeof raw.hint !== "string" || raw.hint.trim().length === 0) {
        return `${at}.hint: must be a non-empty string`;
      }
      if (raw.hint.length > MAX_CHOICE_HINT_LENGTH) {
        return `${at}.hint: must be at most ${MAX_CHOICE_HINT_LENGTH} characters`;
      }
    }
    if (raw.role !== undefined) {
      if (raw.role !== "primary" && raw.role !== "destructive") {
        return `${at}.role: must be "primary" or "destructive"`;
      }
      if (raw.role === "primary") primary += 1;
    }
    if (raw.note !== undefined) {
      if (raw.note !== "optional" && raw.note !== "required") {
        return `${at}.note: must be "optional" or "required"`;
      }
    }
  }
  if (primary > 1) {
    return 'choiceInfo: at most one choice may have the role "primary"';
  }
  return undefined;
}

/** Copies the fields the kernel knows from a value it has already checked. */
export function normalizeChoiceInfo(
  value: unknown,
  choices: readonly string[],
): ChoiceInfoMap | undefined {
  if (value === undefined) return undefined;
  const result: Record<string, ChoiceInfo> = {};
  if (!isRecord(value)) return result;
  for (const [choice, raw] of Object.entries(value)) {
    if (!choices.includes(choice) || !isRecord(raw)) continue;
    const info: Record<string, string> = {};
    if (typeof raw.label === "string") info.label = raw.label;
    if (typeof raw.hint === "string") info.hint = raw.hint;
    if (raw.role === "primary" || raw.role === "destructive") info.role = raw.role;
    if (raw.note === "optional" || raw.note === "required") info.note = raw.note;
    result[choice] = info;
  }
  return result;
}

/**
 * Reads choice information a fact or a step's data carries. Invalid entries and
 * keys that are not among `choices` are left out, so an old or corrupt log does
 * not hide a question.
 */
export function storedChoiceInfo(
  value: unknown,
  choices?: readonly string[],
): ChoiceInfoMap | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const result: Record<string, ChoiceInfo> = {};
  for (const [choice, raw] of Object.entries(value)) {
    if (choices !== undefined && !choices.includes(choice)) continue;
    if (!isRecord(raw)) continue;
    const info: Record<string, string> = {};
    if (typeof raw.label === "string") info.label = raw.label;
    if (typeof raw.hint === "string") info.hint = raw.hint;
    if (raw.role === "primary" || raw.role === "destructive") info.role = raw.role;
    if (raw.note === "optional" || raw.note === "required") info.note = raw.note;
    result[choice] = info;
  }
  return result;
}
