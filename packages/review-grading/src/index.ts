/**
 * A repository's review grading: `<repository>/.operad/review.json`, checked
 * against the shipped `review.schema.json`. A plugin whose flow reviews calls
 * `readReviewGrading(repositoryPath, flowName)` and gets the merged grading.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "@operad-io/engine";

/** Where a repository keeps its review grading. */
export const REVIEW_GRADING_FILE = ".operad/review.json";

/** The severities a finding may have. */
export type Level = "critical" | "major" | "minor";

const LEVELS: readonly Level[] = ["critical", "major", "minor"];

/** One grading; every field is optional. */
export interface Grading {
  readonly levels?: Readonly<Partial<Record<Level, string>>>;
  readonly rules?: readonly string[];
  readonly fixLevel?: Level;
}

/** An invalid or unreadable review.json. The message names the file. */
export class ReviewGradingError extends Error {
  constructor(message: string) {
    super(`review.json: ${message}`);
    this.name = "ReviewGradingError";
  }
}

function noExtra(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ReviewGradingError(`${field}.${key} is not a known field`);
    }
  }
}

function parseGrading(value: unknown, field: string): Grading {
  if (!isRecord(value)) {
    throw new ReviewGradingError(`${field} must be a JSON object`);
  }
  noExtra(value, ["levels", "rules", "fixLevel"], field);
  let levels: Partial<Record<Level, string>> | undefined;
  if (value.levels !== undefined) {
    const raw = value.levels;
    if (!isRecord(raw)) {
      throw new ReviewGradingError(`${field}.levels must be a JSON object`);
    }
    noExtra(raw, LEVELS, `${field}.levels`);
    levels = {};
    for (const level of LEVELS) {
      const text = raw[level];
      if (text === undefined) continue;
      if (typeof text !== "string") {
        throw new ReviewGradingError(`${field}.levels.${level} must be a string`);
      }
      levels[level] = text;
    }
  }
  let rules: string[] | undefined;
  if (value.rules !== undefined) {
    const raw = value.rules;
    if (!Array.isArray(raw)) {
      throw new ReviewGradingError(`${field}.rules must be an array of strings`);
    }
    rules = raw.map((rule: unknown, index) => {
      if (typeof rule !== "string") {
        throw new ReviewGradingError(`${field}.rules[${index}] must be a string`);
      }
      return rule;
    });
  }
  let fixLevel: Level | undefined;
  if (value.fixLevel !== undefined) {
    const raw = value.fixLevel;
    const found = LEVELS.find((level) => level === raw);
    if (found === undefined) {
      throw new ReviewGradingError(
        `${field}.fixLevel must be "critical", "major" or "minor"`,
      );
    }
    fixLevel = found;
  }
  return {
    ...(levels === undefined ? {} : { levels }),
    ...(rules === undefined ? {} : { rules }),
    ...(fixLevel === undefined ? {} : { fixLevel }),
  };
}

/** Validates one parsed review.json and returns its default and flow entries. */
export function validateReviewGrading(value: unknown): {
  readonly default: Grading;
  readonly flows: Readonly<Record<string, Grading>>;
} {
  if (!isRecord(value)) {
    throw new ReviewGradingError("must be a JSON object");
  }
  noExtra(value, ["$schema", "default", "flows"], "$");
  if (value.$schema !== undefined && typeof value.$schema !== "string") {
    throw new ReviewGradingError("$schema must be a string");
  }
  const flows: Record<string, Grading> = {};
  if (value.flows !== undefined) {
    if (!isRecord(value.flows)) {
      throw new ReviewGradingError("flows must be a JSON object");
    }
    for (const [name, entry] of Object.entries(value.flows)) {
      flows[name] = parseGrading(entry, `flows.${name}`);
    }
  }
  return {
    default:
      value.default === undefined ? {} : parseGrading(value.default, "default"),
    flows,
  };
}

/** A flow's entry over the default, field by field; levels merge per level. */
export function mergeGrading(base: Grading, over: Grading): Grading {
  const levels = { ...base.levels, ...over.levels };
  const rules = over.rules ?? base.rules;
  const fixLevel = over.fixLevel ?? base.fixLevel;
  return {
    ...(Object.keys(levels).length === 0 ? {} : { levels }),
    ...(rules === undefined ? {} : { rules }),
    ...(fixLevel === undefined ? {} : { fixLevel }),
  };
}

/**
 * Reads the repository's review.json and returns the grading of one flow. A
 * missing file gives an empty grading; an invalid one throws a
 * `ReviewGradingError` that names the file.
 */
export function readReviewGrading(
  repositoryPath: string,
  flowName: string,
): Grading {
  const path = join(repositoryPath, REVIEW_GRADING_FILE);
  if (!existsSync(path)) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ReviewGradingError(`cannot read ${path}: ${String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ReviewGradingError(`invalid JSON in ${path}: ${String(error)}`);
  }
  let file;
  try {
    file = validateReviewGrading(parsed);
  } catch (error) {
    if (error instanceof ReviewGradingError) {
      throw new ReviewGradingError(
        `invalid ${path}: ${error.message.slice("review.json: ".length)}`,
      );
    }
    throw error;
  }
  const own = Object.hasOwn(file.flows, flowName) ? file.flows[flowName] : undefined;
  return mergeGrading(file.default, own ?? {});
}
