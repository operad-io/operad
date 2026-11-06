/** Reading and checking `$OPERAD_HOME/triggers.json`. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "../log/types.ts";
import type { PluginRegistry } from "../plugin/registry.ts";
import { CronError, parseCron } from "./cron.ts";
import type { TriggerMode, TriggerRule } from "./types.ts";

/** `triggers.json` is not usable; the message names the rule and field. */
export class TriggerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TriggerError";
  }
}

export const TRIGGERS_FILE = "triggers.json";

export function triggersPath(home: string): string {
  return join(home, TRIGGERS_FILE);
}

const RULE_KEYS = new Set(["source", "type", "start", "object", "mode", "schedule"]);
const START_KEYS = new Set(["flow", "params"]);
const MODES: readonly TriggerMode[] = ["observe", "candidate", "auto"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(
  value: unknown,
  at: string,
  field: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TriggerError(`${at}: ${field}: must be a non-empty string`);
  }
  return value;
}

function checkKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, at: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TriggerError(`${at}: ${key}: not a rule field`);
    }
  }
}

function readMode(value: unknown, at: string): TriggerMode {
  if (value === "observe" || value === "candidate" || value === "auto") {
    return value;
  }
  throw new TriggerError(
    `${at}: mode: must be ${MODES.map((mode) => `"${mode}"`).join(", ")}`,
  );
}

function readStart(value: unknown, at: string): TriggerRule["start"] {
  if (!isRecord(value)) {
    throw new TriggerError(`${at}: start: must be an object`);
  }
  checkKeys(value, START_KEYS, `${at}: start`);
  const flow = requireText(value.flow, `${at}: start.flow`, "flow");
  if (value.params === undefined) return { flow };
  return { flow, params: value.params as JsonValue };
}

function readRule(value: unknown, index: number, file: string): TriggerRule {
  const at = `${file}: rule ${index}`;
  if (!isRecord(value)) {
    throw new TriggerError(`${at}: must be an object`);
  }
  checkKeys(value, RULE_KEYS, at);

  const source = requireText(value.source, at, "source");
  const type = requireText(value.type, at, "type");
  const start = readStart(value.start, at);
  const object = requireText(value.object, at, "object");
  const mode = readMode(value.mode, at);

  let schedule: string | undefined;
  if (value.schedule !== undefined) {
    schedule = requireText(value.schedule, at, "schedule");
    try {
      parseCron(schedule);
    } catch (error) {
      const detail = error instanceof CronError ? error.message : String(error);
      throw new TriggerError(`${at}: schedule: ${detail}`, { cause: error });
    }
  }

  return schedule === undefined
    ? { source, type, start, object, mode }
    : { source, type, start, object, mode, schedule };
}

/**
 * Checks a parsed `triggers.json` value. `registry` is optional so a caller can
 * check the file before any plugin loads; when it is given, a rule whose flow
 * does not exist is refused at load.
 */
export function parseTriggerRules(
  raw: unknown,
  file: string,
  registry?: PluginRegistry,
): readonly TriggerRule[] {
  if (!Array.isArray(raw)) {
    throw new TriggerError(`${file}: must be a JSON array of rules`);
  }
  const rules = raw.map((entry, index) => readRule(entry, index, file));
  for (const [index, rule] of rules.entries()) {
    if (
      registry !== undefined &&
      registry.flow(rule.start.flow) === undefined
    ) {
      throw new TriggerError(
        `${file}: rule ${index}: start.flow: unknown flow "${rule.start.flow}"`,
      );
    }
  }
  return rules;
}

export interface LoadTriggerRulesOptions {
  readonly home: string;
  readonly registry?: PluginRegistry | undefined;
}

/** Reads the file; a missing file is an empty rule list, not an error. */
export async function loadTriggerRules(
  options: LoadTriggerRulesOptions,
): Promise<readonly TriggerRule[]> {
  const file = triggersPath(options.home);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw new TriggerError(`${file}: ${String(error)}`, { cause: error });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new TriggerError(`${file}: invalid JSON: ${String(error)}`, {
      cause: error,
    });
  }
  return parseTriggerRules(raw, file, options.registry);
}
