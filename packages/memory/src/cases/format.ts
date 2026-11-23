/**
 * The memory regression set: one case is one exchange where the bot got
 * something wrong or the person corrected it. A case holds the context the bot
 * had, the question and the right answer. The case files live in the operad
 * home (they contain private chat text); the repository holds only this format,
 * the runner and a synthetic example set.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "@operad-io/engine";

/** A case file that cannot be used; the message says which and why. */
export class CaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaseError";
  }
}

/** Why the case exists: the bot answered wrong, or the person corrected it. A correction counts as a miss. */
export const CASE_KINDS = ["miss", "correction"] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

/** One earlier message of the chat the bot had in front of it. */
export interface CaseMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** The right answer: phrases an answer must state, and wrong phrases it must not repeat. */
export interface CaseAnswer {
  readonly include: readonly string[];
  readonly avoid: readonly string[];
}

/** One case, as `<id>.json` holds it. */
export interface MemoryCase {
  readonly id: string;
  readonly kind: CaseKind;
  /** The messages before the question, oldest first. */
  readonly context: readonly CaseMessage[];
  readonly question: string;
  readonly answer: CaseAnswer;
}

/** The file name pattern of a case id. */
export const CASE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function textList(value: unknown, name: string, file: string, required: boolean): readonly string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) throw new CaseError(`${file}: ${name} must be a list of text`);
  const found: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new CaseError(`${file}: ${name} holds only non-empty text`);
    }
    found.push(item);
  }
  if (required && found.length === 0) throw new CaseError(`${file}: ${name} needs at least one entry`);
  return found;
}

/** Checks one parsed case; `file` names it in an error. */
export function parseCase(value: unknown, file: string): MemoryCase {
  if (!isRecord(value)) throw new CaseError(`${file}: a case is an object`);
  const id = value["id"];
  if (typeof id !== "string" || !CASE_ID.test(id)) {
    throw new CaseError(`${file}: id must be lowercase letters, digits, - and _`);
  }
  const kind = value["kind"];
  if (kind !== "miss" && kind !== "correction") throw new CaseError(`${file}: kind is "miss" or "correction"`);
  const question = value["question"];
  if (typeof question !== "string" || question.trim().length === 0) {
    throw new CaseError(`${file}: question must be non-empty text`);
  }
  const rawContext = value["context"] ?? [];
  if (!Array.isArray(rawContext)) throw new CaseError(`${file}: context must be a list of messages`);
  const context: CaseMessage[] = rawContext.map((entry) => {
    if (!isRecord(entry) || (entry["role"] !== "user" && entry["role"] !== "assistant") || typeof entry["text"] !== "string") {
      throw new CaseError(`${file}: a context message is { role: "user" | "assistant", text }`);
    }
    return { role: entry["role"], text: entry["text"] };
  });
  const answer = value["answer"];
  if (!isRecord(answer)) throw new CaseError(`${file}: answer is { include, avoid? }`);
  return {
    id,
    kind,
    context,
    question,
    answer: {
      include: textList(answer["include"], "answer.include", file, true),
      avoid: textList(answer["avoid"], "answer.avoid", file, false),
    },
  };
}

/** Every `*.json` case in a directory, by file name; an unusable file is an error, never skipped. */
export function loadCases(directory: string): readonly MemoryCase[] {
  if (!existsSync(directory)) throw new CaseError(`there is no case directory at ${directory}`);
  const cases: MemoryCase[] = [];
  const seen = new Set<string>();
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(directory, name), "utf8"));
    } catch {
      throw new CaseError(`${name}: not valid JSON`);
    }
    const found = parseCase(parsed, name);
    if (found.id !== name.slice(0, -".json".length)) throw new CaseError(`${name}: id "${found.id}" must match the file name`);
    if (seen.has(found.id)) throw new CaseError(`${name}: duplicate id "${found.id}"`);
    seen.add(found.id);
    cases.push(found);
  }
  return cases;
}
