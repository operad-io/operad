/** Managing the routines (scheduled flows) in `triggers.json`, from a client. */

import { messageOf } from "@operad-io/engine";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomicSync } from "@operad-io/engine/platform";
import {
  cronMatches,
  type CronField,
  isMissingFile,
  isRecord,
  minuteStart,
  openConfigLog,
  parseCron,
  parseTriggerRules,
  readConfig,
  type CommandContext,
  type CommandDefinition,
  type JsonValue,
  type TriggerMode,
  type TriggerRule,
} from "@operad-io/engine";
import {
  baselineCronRule,
  readCronState,
  ruleStateKey,
  writeCronState,
} from "./state.ts";

const DAY_MS = 24 * 60 * 60_000;
const MODES: readonly TriggerMode[] = ["observe", "candidate", "auto"];

/** A management call is refused, with a reason a client can show. */
export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

/** How one scheduled flow last ran. */
export interface ScheduledLastRun {
  readonly runId: string;
  /** `done`, `failed`, `cancelled`, or `running` before the run ends. */
  readonly result: string;
  readonly reason?: string | undefined;
  readonly endedAt?: number | undefined;
}

/** One scheduled flow as a client lists it. */
export interface ScheduledFlow {
  /** The rule's stable identity; the id add, edit, pause, resume and remove take. */
  readonly id: string;
  readonly flow: string;
  /** The command line of a routine that runs one command; the list shows it in place of the flow. */
  readonly command?: string | undefined;
  readonly schedule: string;
  readonly params?: JsonValue | undefined;
  readonly object: string;
  readonly mode: TriggerMode;
  readonly paused: boolean;
  /** The next planned minute as an ISO time; null when paused. */
  readonly nextRun: string | null;
  readonly lastRun: ScheduledLastRun | null;
}

/** The stable identity of a scheduled rule, from the fields that decide what it starts. */
export function scheduledId(rule: TriggerRule): string {
  return createHash("sha256").update(ruleStateKey(rule)).digest("hex").slice(0, 16);
}

/** The next planned minute after `now`, or null when none is within two years. */
export function nextScheduledMinute(expression: string, now: number): number | null {
  let schedule: ReturnType<typeof parseCron>;
  try {
    schedule = parseCron(expression);
  } catch {
    return null;
  }
  const first = minuteStart(now) + 60_000;
  const limit = minuteStart(now) + 366 * 2 * DAY_MS;
  // Only a day the date fields allow is scanned by minute; the rest are skipped whole.
  const anyTime: CronField = { values: new Set(range(60)), restricted: false };
  const dayOnly = { ...schedule, minute: anyTime, hour: anyTime };
  const day = new Date(first);
  day.setHours(0, 0, 0, 0);
  for (; day.getTime() <= limit; day.setDate(day.getDate() + 1)) {
    if (!cronMatches(dayOnly, day)) continue;
    for (const hour of [...schedule.hour.values].sort((a, b) => a - b)) {
      for (const minute of [...schedule.minute.values].sort((a, b) => a - b)) {
        const candidate = new Date(day);
        candidate.setHours(hour, minute, 0, 0);
        const time = candidate.getTime();
        if (time < first || time > limit) continue;
        if (cronMatches(schedule, candidate)) return time;
      }
    }
  }
  return null;
}

/** The flow a command routine starts. */
export const COMMAND_FLOW = "shell:command";
const SHELL_OFF = 'shell is off: run "operad plugin enable shell" first';

/** The command line a rule runs, when it starts the shell plugin's command flow. */
function commandOf(rule: TriggerRule): string | undefined {
  if (rule.start.flow !== COMMAND_FLOW) return undefined;
  const params = rule.start.params;
  if (!isRecord(params)) return undefined;
  return typeof params.command === "string" ? params.command : undefined;
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

function triggersFile(home: string): string {
  return join(home, "triggers.json");
}

function readRules(home: string): readonly TriggerRule[] {
  const file = triggersFile(home);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw new ScheduleError(`cannot read ${file}: ${String(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ScheduleError(`${file}: invalid JSON: ${String(error)}`);
  }
  return parseTriggerRules(raw, file);
}

function writeRules(home: string, rules: readonly TriggerRule[]): void {
  writeJsonAtomicSync(triggersFile(home), rules, { space: 2 });
}

function scheduled(rules: readonly TriggerRule[]): readonly TriggerRule[] {
  return rules.filter((rule) => rule.source === "cron" && rule.schedule !== undefined);
}

function found(rules: readonly TriggerRule[], id: string): TriggerRule {
  const rule = scheduled(rules).find((entry) => scheduledId(entry) === id);
  if (rule === undefined) throw new ScheduleError(`there is no routine "${id}"`);
  return rule;
}

function checkedFlow(ctx: CommandContext, flow: string): string {
  if (!ctx.flows.includes(flow)) {
    throw new ScheduleError(`start.flow: unknown flow "${flow}"`);
  }
  return flow;
}

function checkedSchedule(expression: string): string {
  const trimmed = expression.trim();
  try {
    parseCron(trimmed);
  } catch (error) {
    throw new ScheduleError(messageOf(error));
  }
  return trimmed;
}

function checkedMode(mode: string): TriggerMode {
  const known = MODES.find((entry) => entry === mode);
  if (known === undefined) {
    throw new ScheduleError(`mode: must be ${MODES.map((item) => `"${item}"`).join(", ")}`);
  }
  return known;
}

function checkedObject(object: string): string {
  const trimmed = object.trim();
  if (trimmed.length === 0) throw new ScheduleError("object: must be a non-empty string");
  return trimmed;
}

function checkedParams(text: string): JsonValue | undefined {
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    throw new ScheduleError(`start.params: is not valid JSON: ${String(error)}`);
  }
}

/** Replaces one rule, or throws when it is gone. */
function replace(
  rules: readonly TriggerRule[],
  id: string,
  change: (rule: TriggerRule) => TriggerRule,
): readonly TriggerRule[] {
  let replaced = false;
  const next = rules.map((rule) => {
    if (scheduledId(rule) !== id) return rule;
    replaced = true;
    return change(rule);
  });
  if (!replaced) throw new ScheduleError(`there is no routine "${id}"`);
  return next;
}

interface CronInput {
  readonly inputId: string;
  readonly source: string;
  readonly sourceKey: string;
  readonly time: number;
}

type RunLog = ReturnType<typeof openConfigLog>;

/** The last run each scheduled rule started, read from the log's inputs and run endings. */
async function lastRuns(
  home: string,
  ids: readonly string[],
): Promise<ReadonlyMap<string, ScheduledLastRun>> {
  const result = new Map<string, ScheduledLastRun>();
  if (ids.length === 0) return result;
  const config = await readConfig(home);
  const log = openConfigLog(config);
  try {
    const latest = new Map<string, CronInput>();
    for await (const input of log.readInputs()) {
      if (input.source !== "cron") continue;
      const id = ids.find((candidate) => input.sourceKey.startsWith(`${candidate}:`));
      if (id === undefined) continue;
      const current = latest.get(id);
      if (current === undefined || input.time >= current.time) latest.set(id, input);
    }
    for (const [id, input] of latest) {
      const run = (await log.runs({ startInputId: input.inputId }))[0];
      if (run === undefined) continue;
      result.set(id, await lastRunOf(log, run.runId, run.active));
    }
  } finally {
    await log.close();
  }
  return result;
}

async function lastRunOf(
  log: RunLog,
  runId: string,
  active: boolean,
): Promise<ScheduledLastRun> {
  if (active) return { runId, result: "running" };
  let result = "done";
  let reason: string | undefined;
  let stepMessage: string | undefined;
  let endedAt: number | undefined;
  for await (const fact of log.read(runId)) {
    if (fact.kind === "step_result" && isRecord(fact.payload) && isRecord(fact.payload.data)) {
      const message = fact.payload.data.message;
      stepMessage = typeof message === "string" && message.length > 0 ? message : undefined;
    }
    if (fact.kind !== "run_ended" || !isRecord(fact.payload)) continue;
    if (typeof fact.payload.status === "string") result = fact.payload.status;
    if (typeof fact.payload.reason === "string" && fact.payload.reason.length > 0) {
      reason = fact.payload.reason;
    }
    endedAt = fact.time;
  }
  if (reason === undefined && result === "failed") reason = stepMessage;
  return {
    runId,
    result,
    ...(reason === undefined ? {} : { reason }),
    ...(endedAt === undefined ? {} : { endedAt }),
  };
}

async function listFlows(
  home: string,
  now: number,
): Promise<readonly ScheduledFlow[]> {
  const rules = scheduled(readRules(home));
  const ids = rules.map(scheduledId);
  const lasts = await lastRuns(home, ids);
  return rules.map((rule) => {
    const id = scheduledId(rule);
    const schedule = rule.schedule ?? "";
    const next = rule.paused === true ? null : nextScheduledMinute(schedule, now);
    return {
      id,
      flow: rule.start.flow,
      ...(commandOf(rule) === undefined ? {} : { command: commandOf(rule) }),
      schedule,
      ...(rule.start.params === undefined ? {} : { params: rule.start.params }),
      object: rule.object,
      mode: rule.mode,
      paused: rule.paused === true,
      nextRun: next === null ? null : new Date(next).toISOString(),
      lastRun: lasts.get(id) ?? null,
    };
  });
}

function line(entry: ScheduledFlow): string {
  const last =
    entry.lastRun === null
      ? "last none"
      : `last ${entry.lastRun.result} ${entry.lastRun.runId}${entry.lastRun.reason === undefined ? "" : `: ${entry.lastRun.reason}`}`;
  const next = entry.paused
    ? "paused"
    : entry.nextRun === null
      ? "next none"
      : `next ${entry.nextRun}`;
  const params =
    entry.params === undefined || entry.command !== undefined
      ? ""
      : ` params ${JSON.stringify(entry.params)}`;
  const what = entry.command === undefined ? entry.flow : `command ${JSON.stringify(entry.command)}`;
  return `${entry.id}  ${what}  ${entry.schedule}  on ${entry.object} (${entry.mode})  ${next}  ${last}${params}`;
}

interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    if (equals >= 0) {
      values.set(arg.slice(0, equals), arg.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(arg, next);
      index += 1;
      continue;
    }
    flags.add(arg);
  }
  return { positionals, values, flags };
}

function required(parsed: ParsedArgs, name: string): string {
  const value = parsed.values.get(name);
  if (value === undefined) throw new ScheduleError(`routines: ${name} is required`);
  return value;
}

function oneId(parsed: ParsedArgs): string {
  const id = parsed.positionals[0];
  if (id === undefined) throw new ScheduleError("routines: needs a routine id");
  if (parsed.positionals.length > 1) {
    throw new ScheduleError("routines: takes one routine id");
  }
  return id;
}

/** The `routines` command: list, add, edit, pause, resume and remove. */
export function scheduledCommand(
  options: { readonly now?: (() => number) | undefined } = {},
): CommandDefinition {
  const now = options.now ?? Date.now;
  return {
    name: "routines",
    args: "list [--json] | add (--flow <flow> [--params <json>] | --command <line> [--cwd <dir>]) --schedule <expression> [--object <id>] [--mode <mode>] | edit <id> [--flow <flow>] [--schedule <expression>] [--params <json>] [--object <id>] [--mode <mode>] | pause <id> | resume <id> | remove <id>",
    async run(ctx, argv) {
      const [sub, ...rest] = argv;
      if (sub === undefined || sub === "help") {
        throw new ScheduleError("routines: use list, add, edit, pause, resume or remove");
      }
      const parsed = parseArgs(rest);

      if (sub === "list") {
        if (parsed.positionals.length > 0) {
          throw new ScheduleError("routines list takes no id");
        }
        const entries = await listFlows(ctx.home, now());
        if (parsed.flags.has("--json")) return entries;
        if (entries.length === 0) return "no routines";
        return entries.map(line).join("\n");
      }

      if (sub === "add") {
        if (parsed.positionals.length > 0) {
          throw new ScheduleError("routines add takes no id");
        }
        const commandArg = parsed.values.get("--command");
        const cwdArg = parsed.values.get("--cwd");
        let flow: string;
        let params: JsonValue | undefined;
        let defaultObject: string;
        if (commandArg === undefined) {
          if (cwdArg !== undefined) throw new ScheduleError("routines: --cwd needs --command");
          flow = checkedFlow(ctx, required(parsed, "--flow"));
          const paramsArg = parsed.values.get("--params");
          params = paramsArg === undefined ? undefined : checkedParams(paramsArg);
          defaultObject = `flow:${flow}`;
        } else {
          if (parsed.values.has("--flow") || parsed.values.has("--params")) {
            throw new ScheduleError("routines: --command does not take --flow or --params");
          }
          if (commandArg.trim().length === 0) {
            throw new ScheduleError("routines: --command: must be a non-empty string");
          }
          if (cwdArg !== undefined && cwdArg.length === 0) {
            throw new ScheduleError("routines: --cwd: must be a non-empty string");
          }
          if (!ctx.flows.includes(COMMAND_FLOW)) throw new ScheduleError(SHELL_OFF);
          flow = COMMAND_FLOW;
          params = { command: commandArg, ...(cwdArg === undefined ? {} : { cwd: cwdArg }) };
          // Two command routines at one time must not share an object, or the second is skipped.
          const digest = createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 8);
          defaultObject = `routine:${digest}`;
        }
        const schedule = checkedSchedule(required(parsed, "--schedule"));
        const object = checkedObject(parsed.values.get("--object") ?? defaultObject);
        const mode = checkedMode(parsed.values.get("--mode") ?? "auto");
        const rule: TriggerRule = {
          source: "cron",
          type: "tick",
          start: {
            flow,
            ...(params === undefined ? {} : { params }),
          },
          object,
          mode,
          schedule,
        };
        const rules = readRules(ctx.home);
        const id = scheduledId(rule);
        if (scheduled(rules).some((entry) => scheduledId(entry) === id)) {
          throw new ScheduleError(`a routine "${id}" already exists`);
        }
        writeRules(ctx.home, [...rules, rule]);
        baselineCronRule(ctx.home, rule, now());
        return `routine ${commandArg === undefined ? flow : `command ${JSON.stringify(commandArg)}`} (${id}) every ${schedule}`;
      }

      if (sub === "edit") {
        const id = oneId(parsed);
        const flowArg = parsed.values.get("--flow");
        const scheduleArg = parsed.values.get("--schedule");
        const objectArg = parsed.values.get("--object");
        const modeArg = parsed.values.get("--mode");
        const paramsArg = parsed.values.get("--params");
        let edited: TriggerRule | undefined;
        const rules = replace(readRules(ctx.home), id, (rule) => {
          const flow =
            flowArg === undefined ? rule.start.flow : checkedFlow(ctx, flowArg);
          const schedule =
            scheduleArg === undefined ? rule.schedule : checkedSchedule(scheduleArg);
          const params =
            paramsArg === undefined ? rule.start.params : checkedParams(paramsArg);
          edited = {
            ...rule,
            start: {
              flow,
              ...(params === undefined ? {} : { params }),
            },
            ...(objectArg === undefined ? {} : { object: checkedObject(objectArg) }),
            ...(modeArg === undefined ? {} : { mode: checkedMode(modeArg) }),
            ...(schedule === undefined ? {} : { schedule }),
          };
          return edited;
        });
        if (edited === undefined) throw new ScheduleError(`there is no routine "${id}"`);
        const editedId = scheduledId(edited);
        if (
          editedId !== id &&
          scheduled(rules).filter((entry) => scheduledId(entry) === editedId).length > 1
        ) {
          throw new ScheduleError(`a routine "${editedId}" already exists`);
        }
        writeRules(ctx.home, rules);
        baselineCronRule(ctx.home, edited, now());
        return `edited ${edited.start.flow} (${scheduledId(edited)})`;
      }

      if (sub === "pause" || sub === "resume") {
        const id = oneId(parsed);
        let changed: TriggerRule | undefined;
        const rules = replace(readRules(ctx.home), id, (rule) => {
          changed =
            sub === "pause"
              ? { ...rule, paused: true }
              : rule.paused === undefined
                ? rule
                : (({ paused: _paused, ...rest }) => rest)(rule);
          return changed;
        });
        if (changed === undefined) throw new ScheduleError(`there is no routine "${id}"`);
        writeRules(ctx.home, rules);
        baselineCronRule(ctx.home, changed, now());
        return sub === "pause"
          ? `paused ${changed.start.flow}`
          : `resumed ${changed.start.flow}`;
      }

      if (sub === "remove") {
        const id = oneId(parsed);
        const rules = readRules(ctx.home);
        const removed = found(rules, id);
        writeRules(
          ctx.home,
          rules.filter((rule) => scheduledId(rule) !== id),
        );
        const state = readCronState(ctx.home);
        const key = ruleStateKey(removed);
        if (state.rules[key] !== undefined) {
          const next = { ...state.rules };
          delete next[key];
          writeCronState(ctx.home, { rules: next });
        }
        return `removed ${removed.start.flow} (${id})`;
      }

      throw new ScheduleError(`routines: unknown action "${sub}"`);
    },
  };
}
