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

/**
 * A plain JSON copy of a rule's params. Each property is read once while the
 * copy is built, so a getter cannot pass the check with one value and hand
 * back another, and the rule keeps the snapshot rather than a live object.
 */
function snapshotJsonValue(value: unknown, path: string): JsonValue {
  const seen = new WeakSet<object>();

  function walk(current: unknown, at: string): JsonValue {
    if (current === null) return null;
    switch (typeof current) {
      case "string":
      case "boolean":
        return current;
      case "number":
        if (!Number.isFinite(current)) {
          throw new Error(`${at} is not a finite JSON number`);
        }
        return current;
      case "object":
        break;
      default:
        throw new Error(`${at} is not JSON (${typeof current})`);
    }

    if (seen.has(current)) {
      throw new Error(`${at} contains a cycle`);
    }
    seen.add(current);

    // `JSON.stringify` calls `toJSON` even when it is not enumerable, so the
    // value it would store differs from the value inspected here.
    if (typeof (current as { toJSON?: unknown }).toJSON === "function") {
      throw new Error(
        `${at} has a toJSON method, so its JSON form is not the value inspected`,
      );
    }

    let copy: JsonValue;
    if (Array.isArray(current)) {
      const items: JsonValue[] = [];
      for (let index = 0; index < current.length; index += 1) {
        if (!(index in current)) {
          throw new Error(`${at}[${index}] is a hole, not a JSON value`);
        }
        items.push(walk(current[index], `${at}[${index}]`));
      }
      copy = items;
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`${at} is not a plain JSON object`);
      }
      const record: { [key: string]: JsonValue } = {};
      for (const [key, item] of Object.entries(current)) {
        Object.defineProperty(record, key, {
          value: walk(item, `${at}.${key}`),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      copy = record;
    }

    seen.delete(current);
    return copy;
  }

  return walk(value, path);
}

function readStart(value: unknown, at: string): TriggerRule["start"] {
  if (!isRecord(value)) {
    throw new TriggerError(`${at}: start: must be an object`);
  }
  checkKeys(value, START_KEYS, `${at}: start`);
  const flow = requireText(value.flow, `${at}: start.flow`, "flow");
  // An absent key means "no params"; a present key must be JSON even when its
  // value is `undefined`. The snapshot freezes every nested value at load.
  if (!Object.hasOwn(value, "params")) return { flow };
  try {
    return { flow, params: snapshotJsonValue(value.params, "start.params") };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TriggerError(`${at}: ${detail}`, { cause: error });
  }
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

/** One rule and where it came from: `user`, or the plugin that shipped it. */
export interface SourcedTriggerRule {
  readonly rule: TriggerRule;
  readonly from: string;
}

export interface LoadTriggerRulesOptions {
  readonly home: string;
  readonly registry?: PluginRegistry | undefined;
  /** Where a skipped duplicate plugin rule is reported. Defaults to stderr. */
  readonly onLog?: ((message: string) => void) | undefined;
}

function ruleKey(rule: TriggerRule): string {
  return JSON.stringify([rule.source, rule.type]);
}

/**
 * Merges the rules plugins ship with the user's rules. A user rule with the
 * same source and type removes every plugin rule for that pair. When two
 * plugins ship a rule for the same pair, the later one is skipped and named
 * in one log line.
 */
export function mergeTriggerRules(
  userRules: readonly TriggerRule[],
  pluginRules: readonly { readonly plugin: string; readonly rule: TriggerRule }[],
  onLog: (message: string) => void = (message) => console.error(message),
): readonly SourcedTriggerRule[] {
  const userPairs = new Set(userRules.map(ruleKey));
  const owner = new Map<string, string>();
  const merged: SourcedTriggerRule[] = [];

  for (const entry of pluginRules) {
    const key = ruleKey(entry.rule);
    if (userPairs.has(key)) continue;
    const first = owner.get(key);
    if (first !== undefined) {
      if (first !== entry.plugin) {
        onLog(
          `trigger rule ${entry.rule.source}/${entry.rule.type}: plugin "${entry.plugin}" is skipped; plugin "${first}" already declares it`,
        );
      }
      continue;
    }
    owner.set(key, entry.plugin);
    merged.push({ rule: entry.rule, from: entry.plugin });
  }

  for (const rule of userRules) merged.push({ rule, from: "user" });
  return merged;
}

/** Reads the user's file; a missing file is an empty rule list, not an error. */
async function readUserRules(
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

/** The rules in force, with where each came from. */
export async function loadSourcedTriggerRules(
  options: LoadTriggerRulesOptions,
): Promise<readonly SourcedTriggerRule[]> {
  const userRules = await readUserRules(options);
  const pluginRules = options.registry?.triggerRules() ?? [];
  return mergeTriggerRules(userRules, pluginRules, options.onLog);
}

/** The merged rules in force: plugin defaults, then the user's rules. */
export async function loadTriggerRules(
  options: LoadTriggerRulesOptions,
): Promise<readonly TriggerRule[]> {
  const sourced = await loadSourcedTriggerRules(options);
  return sourced.map((entry) => entry.rule);
}
