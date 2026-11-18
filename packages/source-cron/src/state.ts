/**
 * The plugin's own state file, `<home>/cron/state.json`. It holds the last
 * minute the source fired for each rule, keyed by the rule's stable identity.
 * A rule whose schedule changed no longer matches its entry, so it starts fresh.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  isRecord,
  latestCronMinute,
  parseCron,
  type TriggerRule,
} from "@operad-io/engine";

/** What the source remembers about one rule. */
export interface CronRuleState {
  /** The schedule the last minute belongs to. */
  readonly schedule: string;
  /** The start of the last minute the rule fired, in epoch milliseconds. */
  readonly last: number;
}

/** The rules' remembered state, by rule identity. */
export interface CronState {
  readonly rules: Readonly<Record<string, CronRuleState>>;
}

/** The directory the plugin keeps its own files in. */
export function cronStateDirectory(home: string): string {
  return join(home, "cron");
}

/** The file the last fired minutes are in. */
export function cronStatePath(home: string): string {
  return join(cronStateDirectory(home), "state.json");
}

/** The stable identity of a rule, independent of its position in the file. */
export function ruleStateKey(rule: TriggerRule): string {
  return JSON.stringify([
    rule.source,
    rule.type,
    rule.start.flow,
    rule.start.params ?? null,
    rule.object,
    rule.mode,
    rule.schedule,
  ]);
}

/** Starts a rule from the latest planned minute at or before `now`. */
export function baselineCronRule(
  home: string,
  rule: TriggerRule,
  now: number,
): void {
  if (rule.schedule === undefined) return;
  const last = latestCronMinute(parseCron(rule.schedule), now);
  if (last === null) return;
  const state = readCronState(home);
  writeCronState(home, {
    rules: {
      ...state.rules,
      [ruleStateKey(rule)]: { schedule: rule.schedule, last },
    },
  });
}

function ruleStateOf(value: unknown): CronRuleState | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.schedule !== "string") return undefined;
  if (typeof value.last !== "number" || !Number.isFinite(value.last)) return undefined;
  return { schedule: value.schedule, last: value.last };
}

/** The recorded rule state; empty when the file is missing or unusable. */
export function readCronState(home: string): CronState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(cronStatePath(home), "utf8"));
  } catch {
    return { rules: {} };
  }
  if (!isRecord(parsed) || !isRecord(parsed.rules)) return { rules: {} };
  const rules: Record<string, CronRuleState> = {};
  for (const [key, value] of Object.entries(parsed.rules)) {
    const state = ruleStateOf(value);
    if (state !== undefined) rules[key] = state;
  }
  return { rules };
}

/** Records the rule state, replacing the file whole. */
export function writeCronState(home: string, state: CronState): void {
  const path = cronStatePath(home);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, "utf8");
  renameSync(temporary, path);
}
