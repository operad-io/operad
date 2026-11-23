/**
 * Routines of a bot (ADR 0030 D10). The bot plugin is its own source: it reads
 * the routine objects, fires the latest planned minute when it is due, starts a
 * run with the prompt, and when the reply ends it records the result in the
 * routine's history and runs the same notify command a wait uses.
 *
 * A run keeps its reply and process in a record the chat plugin writes, but it
 * is not a chat: it has an `R-` id, is in no chat list, and nothing a person
 * reads calls it a chat.
 *
 * A routine is an object of its own (`bot-routine`, parent its bot), not a field
 * of the bot and not in `config.json`: a client's change is the owner's own edit
 * and applies at once, and `serve` needs no reload. The schedule is a
 * five-field cron expression in the machine's local time zone, with the
 * catch-up rule of the cron source (ADR 0032 D11).
 */

import { messageOf } from "@operad-io/engine";
import { CHAT_TYPE, chatData, sendMessage } from "@operad-io/chat";
import { ChatWatches } from "./chat-watch.ts";
import {
  cronMatches,
  cronMinutesBetween,
  isRecord,
  latestCronMinute,
  minuteStart,
  NOTIFY_TIMEOUT_MS,
  objectLink,
  parseCron,
  readConfig,
  type ActionArgsSchema,
  type ActionTypeDefinition,
  type JsonValue,
  type ObjectStore,
  type PluginBaseContext,
  type RunControl,
  type SourceContext,
  type SourceHandle,
  type StoredObject,
} from "@operad-io/engine";
import { runLine } from "@operad-io/engine/platform";
import { BOT_TYPE, BotError } from "./bot.ts";
import { followUps, removeFollowUp, withBotLock, type FollowUp } from "./follow-up.ts";
import { SETUP_DEV_INSTRUCTION } from "./setup-dev.ts";
import { SETUP_GIT_INSTRUCTION } from "./setup-git.ts";
import { SETUP_INSTRUCTION } from "./setup.ts";

/** The source's name for a scheduled message; a message from it is a background run. */
export const SCHEDULE_SOURCE = "bot";

/** The object type of a routine. */
export const ROUTINE_TYPE = "bot-routine";

/** How long a routine keeps its runs in its history (ADR 0030 D10). */
export const ROUTINE_HISTORY_DAYS = 30;

/** How often the source checks the clock. */
const CHECK_INTERVAL_MS = 1_000;
/** A gap much larger than the check interval means the machine slept or the clock jumped. */
const WAKE_GAP_MS = 60_000;
/** How far back a catch-up looks. */
const CATCH_UP_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

/** What the last firing was and how it ended. */
export interface ScheduledLast {
  /** The planned minute, in epoch milliseconds. */
  readonly plannedAt: number;
  /** When the source fired it; absent when this is only a baseline. */
  readonly firedAt?: number | undefined;
  /** The schedule this planned time belongs to. */
  readonly schedule: string;
  /** True when the firing caught up after earlier planned minutes were skipped. */
  readonly skippedEarlier?: boolean | undefined;
  /** The run the firing started. */
  readonly runId?: string | undefined;
  /** A short summary of the reply, or why it could not start. */
  readonly result?: string | undefined;
  /** True when the firing could not start or its reply failed. */
  readonly failed?: boolean | undefined;
  /** True once the notify command was run for `result`. */
  readonly notified?: boolean | undefined;
  /** True when a person ran the entry now: `firedAt` is then the run's time, and `plannedAt` is untouched. */
  readonly manual?: boolean | undefined;
}

/** One finished firing kept for the next prompt. */
export interface ScheduledRecent {
  /** The planned minute of the firing, in epoch milliseconds. */
  readonly plannedAt: number;
  readonly result: string;
}

/** How many finished results an entry keeps and its next prompt carries. */
export const SCHEDULE_RECENT_COUNT = 3;
/** The longest a kept result is in the next prompt. */
export const SCHEDULE_RECENT_MAX = 120;

/** The reply that means a firing has nothing to report. */
export const SCHEDULE_QUIET_MARKER = "NOTHING_TO_REPORT";
/** What a quiet firing records as its result. */
export const SCHEDULE_QUIET_RESULT = "Nothing to report.";

/** The line every scheduled prompt ends with: how to end quietly. */
export const SCHEDULE_PREAMBLE = `If there is nothing new to report, reply with exactly ${SCHEDULE_QUIET_MARKER} and nothing else; the person is then not notified. Otherwise reply as usual.`;

/** How one run of a routine ended. */
export type RoutineRunStatus = "running" | "done" | "quiet" | "failed";

/** One run in a routine's history. */
export interface RoutineRun {
  /** The id of the run's record, which holds its process and reply. */
  readonly id: string;
  /** When the run started, in epoch milliseconds. */
  readonly at: number;
  readonly status: RoutineRunStatus;
  /** A short summary of the reply, or why it failed; absent while it runs. */
  readonly result?: string | undefined;
  /** True when a person ran it now. */
  readonly manual?: boolean | undefined;
}

/** One routine of a bot. */
export interface ScheduledPrompt {
  readonly name: string;
  /** A five-field cron expression in the machine's local time zone. */
  readonly schedule: string;
  readonly prompt: string;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly paused: boolean;
  readonly last?: ScheduledLast | undefined;
  /** The last few finished results, oldest first. */
  readonly recent?: readonly ScheduledRecent[] | undefined;
  /** When a person asked to run it now, until the source starts that run. */
  readonly runNow?: number | undefined;
  /** The runs of the last 30 days, oldest first. */
  readonly runs?: readonly RoutineRun[] | undefined;
}

/** The longest summary an entry keeps and a notification carries. */
export const SCHEDULE_SUMMARY_MAX = 300;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function lastOf(value: unknown): ScheduledLast | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.plannedAt !== "number" || !Number.isFinite(value.plannedAt)) return undefined;
  if (typeof value.schedule !== "string") return undefined;
  return {
    plannedAt: value.plannedAt,
    ...(typeof value.firedAt === "number" && Number.isFinite(value.firedAt)
      ? { firedAt: value.firedAt }
      : {}),
    schedule: value.schedule,
    ...(value.skippedEarlier === true ? { skippedEarlier: true } : {}),
    // A firing recorded before routines were objects named its chat.
    ...(text(value.runId) === undefined
      ? text(value.chatId) === undefined
        ? {}
        : { runId: value.chatId as string }
      : { runId: value.runId as string }),
    ...(text(value.result) === undefined ? {} : { result: value.result as string }),
    ...(value.failed === true ? { failed: true } : {}),
    ...(value.notified === true ? { notified: true } : {}),
    ...(value.manual === true ? { manual: true } : {}),
  };
}

function runsOf(value: unknown): readonly RoutineRun[] {
  const found: RoutineRun[] = [];
  if (!Array.isArray(value)) return found;
  for (const item of value) {
    if (!isRecord(item) || text(item.id) === undefined) continue;
    if (typeof item.at !== "number" || !Number.isFinite(item.at)) continue;
    const status = item.status;
    if (status !== "running" && status !== "done" && status !== "quiet" && status !== "failed") continue;
    found.push({
      id: item.id as string,
      at: item.at,
      status,
      ...(text(item.result) === undefined ? {} : { result: item.result as string }),
      ...(item.manual === true ? { manual: true } : {}),
    });
  }
  return found;
}

/** One scheduled prompt from stored data, or undefined when it is unusable. */
export function scheduledPromptOf(value: unknown): ScheduledPrompt | undefined {
  if (!isRecord(value)) return undefined;
  const name = text(value.name);
  const schedule = text(value.schedule);
  const prompt = text(value.prompt);
  if (name === undefined || schedule === undefined || prompt === undefined) return undefined;
  const last = lastOf(value.last);
  const recent: ScheduledRecent[] = [];
  if (Array.isArray(value.recent)) {
    for (const item of value.recent) {
      if (!isRecord(item)) continue;
      if (typeof item.plannedAt !== "number" || !Number.isFinite(item.plannedAt)) continue;
      if (text(item.result) === undefined) continue;
      recent.push({ plannedAt: item.plannedAt, result: item.result as string });
    }
  }
  const runs = runsOf(value.runs);
  return {
    name,
    schedule,
    prompt,
    ...(runs.length === 0 ? {} : { runs }),
    ...(text(value.model) === undefined ? {} : { model: value.model as string }),
    ...(text(value.effort) === undefined ? {} : { effort: value.effort as string }),
    paused: value.paused === true,
    ...(last === undefined ? {} : { last }),
    ...(recent.length === 0 ? {} : { recent: recent.slice(-SCHEDULE_RECENT_COUNT) }),
    ...(typeof value.runNow === "number" && Number.isFinite(value.runNow) ? { runNow: value.runNow } : {}),
  };
}

/** The routine objects, every page. */
async function allRoutines(store: ObjectStore): Promise<readonly StoredObject[]> {
  const found: StoredObject[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list(ROUTINE_TYPE, { ...(cursor === undefined ? {} : { cursor }) });
    found.push(...page.objects);
    cursor = page.next;
  } while (cursor !== undefined);
  return found;
}

/** True for a routine a person made or a bot proposed; false for a built-in one, or a removed one. */
function isUserRoutine(object: StoredObject): boolean {
  return object.data.removed !== true && object.data.builtin === undefined;
}

/** The routine objects of one bot that a person made, in id order. */
export async function routineObjects(store: ObjectStore, bot: string): Promise<readonly StoredObject[]> {
  return (await allRoutines(store)).filter((object) => object.data.bot === bot && isUserRoutine(object));
}

/** The routines of one bot that a person made, as entries. */
export async function routinesOf(store: ObjectStore, bot: string): Promise<readonly ScheduledPrompt[]> {
  const found: ScheduledPrompt[] = [];
  for (const object of await routineObjects(store, bot)) {
    const entry = scheduledPromptOf(object.data);
    if (entry !== undefined) found.push(entry);
  }
  return found;
}

/** The routine object of a bot with this name, when there is one. */
export async function findRoutine(store: ObjectStore, bot: string, name: string): Promise<StoredObject | undefined> {
  return (await routineObjects(store, bot)).find((object) => object.data.name === name);
}

async function nextRoutineId(store: ObjectStore): Promise<string> {
  let highest = 0;
  for (const object of await allRoutines(store)) {
    const match = /^RT-(\d+)$/.exec(object.id);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  return `RT-${String(highest + 1).padStart(4, "0")}`;
}

/** The entries a bot object carried before routines were objects. */
export function legacyScheduled(data: Readonly<Record<string, unknown>>): readonly ScheduledPrompt[] {
  const found: ScheduledPrompt[] = [];
  if (!Array.isArray(data.scheduled)) return found;
  for (const value of data.scheduled) {
    const entry = scheduledPromptOf(value);
    if (entry !== undefined) found.push(entry);
  }
  return found;
}

/** Moves the entries a bot object still carries into routine objects of their own. */
export async function migrateScheduled(store: ObjectStore, bot: string, data: Readonly<Record<string, unknown>>): Promise<void> {
  for (const entry of legacyScheduled(data)) {
    if ((await findRoutine(store, bot, entry.name)) !== undefined) continue;
    await store.put(ROUTINE_TYPE, await nextRoutineId(store), { ...stored(entry), bot }, "migrate:bot/routine");
  }
}

/** What a chat's schedule command asks a person to decide. */
export interface ScheduleChange {
  readonly action: "add" | "edit" | "remove";
  /** The schedule in words, as the agent wrote it. */
  readonly words?: string | undefined;
  readonly before: ScheduledPrompt | null;
  readonly after: ScheduledPrompt | null;
}

/** Reads the schedule change a proposal stores, or undefined when it is unusable. */
export function scheduleChangeOf(value: unknown): ScheduleChange | undefined {
  if (!isRecord(value)) return undefined;
  if (value.action !== "add" && value.action !== "edit" && value.action !== "remove") {
    return undefined;
  }
  const before = value.before === null ? null : scheduledPromptOf(value.before);
  const after = value.after === null ? null : scheduledPromptOf(value.after);
  if (before === undefined || after === undefined) return undefined;
  if (value.words !== undefined && typeof value.words !== "string") return undefined;
  return {
    action: value.action,
    ...(value.words === undefined ? {} : { words: value.words }),
    before,
    after,
  };
}

/** One entry as the bot object stores it. */
function stored(entry: ScheduledPrompt): Record<string, JsonValue> {
  return {
    name: entry.name,
    schedule: entry.schedule,
    prompt: entry.prompt,
    ...(entry.model === undefined ? {} : { model: entry.model }),
    ...(entry.effort === undefined ? {} : { effort: entry.effort }),
    paused: entry.paused,
    ...(entry.last === undefined ? {} : { last: entry.last as unknown as JsonValue }),
    ...(entry.recent === undefined || entry.recent.length === 0
      ? {}
      : { recent: entry.recent as unknown as JsonValue }),
    ...(entry.runNow === undefined ? {} : { runNow: entry.runNow }),
    ...(entry.runs === undefined || entry.runs.length === 0
      ? {}
      : { runs: entry.runs as unknown as JsonValue }),
  };
}

/** The runs after one is added or updated; a run older than the history keeps is dropped. */
export function withRun(runs: readonly RoutineRun[] | undefined, run: RoutineRun, now: number): readonly RoutineRun[] {
  const oldest = now - ROUTINE_HISTORY_DAYS * DAY_MS;
  return [...(runs ?? []).filter((item) => item.id !== run.id && item.at >= oldest), run];
}

/** The name a client uses to choose an entry; unique within one bot. */
export function checkPromptName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new BotError("a routine needs a name");
  if (trimmed.length > 120) throw new BotError("a routine's name is at most 120 characters");
  return trimmed;
}

/** A schedule as it is stored: trimmed, and checked as a five-field cron expression. */
export function checkSchedule(expression: string): string {
  const trimmed = expression.trim();
  parseCron(trimmed);
  return trimmed;
}

/** The local date of a time, `YYYY-MM-DD`. */
export function localDate(time: number): string {
  const date = new Date(time);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The local time of a time, `YYYY-MM-DD HH:mm`. */
export function localStamp(time: number): string {
  const date = new Date(time);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${localDate(time)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** How long a catch-up is late, in words a person reads. */
export function lateText(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"}${rest === 0 ? "" : ` ${rest} minute${rest === 1 ? "" : "s"}`}`;
}

/** The one line a catch-up adds to the prompt. It is not added to an on-time run. */
export function latenessLine(scheduledAt: number, lateSecs: number): string {
  return `Scheduled for ${localStamp(scheduledAt)}; this run is ${lateText(lateSecs)} late.`;
}

/** The result of a finished firing, cut to what the next prompt carries. */
function recentText(result: string): string {
  return result.length <= SCHEDULE_RECENT_MAX
    ? result
    : `${result.slice(0, SCHEDULE_RECENT_MAX - 1)}…`;
}

/** True while the last firing's run has started and its result is not yet recorded. */
function isReplying(last: ScheduledLast | undefined): boolean {
  return last?.runId !== undefined && last.result === undefined;
}

/**
 * What a firing tells the agent beyond the person's own prompt: the earlier
 * results of the same entry so it does not repeat them, the quiet-ending line,
 * and for a catch-up the lateness line. The chat does not show it.
 */
export function scheduledInstruction(entry: ScheduledPrompt): string {
  // `last` is recorded when the firing starts, so it says what was planned and when it ran.
  const last = entry.last;
  const late =
    last?.firedAt !== undefined &&
    last.manual !== true &&
    (last.plannedAt < minuteStart(last.firedAt) || last.skippedEarlier === true)
      ? { scheduledAt: last.plannedAt, lateSecs: Math.floor((last.firedAt - last.plannedAt) / 1_000) }
      : undefined;
  const parts: string[] = [];
  const recent = (entry.recent ?? []).slice(-SCHEDULE_RECENT_COUNT);
  if (recent.length > 0) {
    const lines = recent.map((item) => `- ${localStamp(item.plannedAt)}: ${recentText(item.result)}`);
    parts.push(
      `Earlier results of this routine, oldest first; the person has already seen them, so do not repeat them:\n${lines.join("\n")}`,
    );
  }
  parts.push(SCHEDULE_PREAMBLE);
  if (late !== undefined) parts.push(latenessLine(late.scheduledAt, late.lateSecs));
  return parts.join("\n\n");
}

/** The instruction of the firing of the named routine now recorded on a bot; undefined when it has none. */
export async function scheduledInstructionFor(store: ObjectStore, bot: string, name: string): Promise<string | undefined> {
  const entry = scheduledPromptOf((await findRoutine(store, bot, name))?.data);
  return entry === undefined ? undefined : scheduledInstruction(entry);
}

/** True when a reply is exactly the quiet marker. */
export function isQuietReply(message: string): boolean {
  return message.trim() === SCHEDULE_QUIET_MARKER;
}

/** What a bot chat's first session starts with: a schedule it writes is a proposal. */
export const SCHEDULE_INSTRUCTION =
  "To schedule something for me, propose it: call the operad `command` tool with plugin `bot`, verb `schedule`, action `add` (or `edit` or `remove`). Give the schedule both as a five-field cron expression and in words. Nothing takes effect until I approve it in Pending.";

/** The line telling the agent how to set a follow-up for itself in this chat (ADR 0030 D16). */
export function followUpInstruction(chat: string): string {
  return `To look at something again later in this chat (chat ${chat}), set a follow-up: call the operad \`command\` tool with plugin \`bot\`, verb \`follow-up\`, args [\`${chat}\`, \`--at\`, <a time such as "2026-12-01 09:00" or "+2h">, \`--do\`, <one sentence of what to do>]. It takes effect at once; at most 5 not yet due per chat and at most 30 days ahead. Verb \`follow-ups\` with args [\`${chat}\`] lists them, and with \`--cancel\`, <id> cancels one. When it is due you are sent that sentence here.`;
}

/** The text and place a bot chat starts with. */
export function scheduledChatContext(chat: string): { readonly text: string; readonly where: string } {
  const line = `${SCHEDULE_INSTRUCTION} ${followUpInstruction(chat)} ${SETUP_DEV_INSTRUCTION} ${SETUP_GIT_INSTRUCTION} ${SETUP_INSTRUCTION}`;
  return { text: line, where: line };
}

/** The next planned minute after `now`, or null when none is within two years. */
export function nextRun(entry: ScheduledPrompt, now: number): number | null {
  if (entry.paused) return null;
  let schedule: ReturnType<typeof parseCron>;
  try {
    schedule = parseCron(entry.schedule);
  } catch {
    return null;
  }
  const limit = minuteStart(now) + 366 * 2 * DAY_MS;
  let candidate = minuteStart(now) + 60_000;
  while (candidate <= limit) {
    if (cronMatches(schedule, new Date(candidate))) return candidate;
    candidate += 60_000;
  }
  return null;
}

/** A short, one-line summary of a reply. */
export function replySummary(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return "The reply was empty.";
  return oneLine.length <= SCHEDULE_SUMMARY_MAX
    ? oneLine
    : `${oneLine.slice(0, SCHEDULE_SUMMARY_MAX - 1)}…`;
}

/** What a notification command is given. */
export interface ScheduleNotice {
  /** The routine's object id. */
  readonly routineId: string;
  /** The run's record id. */
  readonly runId: string;
  readonly title: string;
  readonly summary: string;
}

/** Runs the configured notify command for a finished scheduled reply. */
export async function notifyScheduledReply(
  home: string,
  notice: ScheduleNotice,
): Promise<void> {
  const config = await readConfig(home);
  const command = config.notify.command;
  if (command === null) return;
  const outcome = await runLine({
    line: command,
    cwd: home,
    env: {
      OPERAD_ID: `${ROUTINE_TYPE}:${notice.routineId}`,
      OPERAD_TITLE: notice.title,
      OPERAD_REASON: notice.summary,
      OPERAD_LINK: objectLink(ROUTINE_TYPE, notice.routineId),
    },
    timeoutMs: NOTIFY_TIMEOUT_MS,
    signal: new AbortController().signal,
  });
  if (outcome.exitCode !== 0 || outcome.timedOut || outcome.spawnError !== undefined) {
    throw new Error(
      `the notify command ${outcome.timedOut ? "timed out" : `exited ${outcome.exitCode ?? "without a code"}`}`,
    );
  }
}

/** Reads a bot object, or says why it cannot be used. */
async function botObject(store: ObjectStore, bot: string): Promise<StoredObject> {
  const object = await store.get(BOT_TYPE, bot);
  if (object === undefined) throw new BotError(`there is no bot "${bot}"`);
  if (object.data.removed === true) throw new BotError(`bot ${bot} is no longer in the settings`);
  return object;
}

/** Replaces one routine of the bot, leaving the others and the bot's settings alone. */
async function replaceEntry(
  store: ObjectStore,
  bot: string,
  name: string,
  change: (entry: ScheduledPrompt) => ScheduledPrompt | undefined,
  cause: string,
): Promise<ScheduledPrompt | undefined> {
  return withBotLock(store, bot, async () => {
    await botObject(store, bot);
    const object = await findRoutine(store, bot, name);
    const entry = scheduledPromptOf(object?.data);
    if (object === undefined || entry === undefined) return undefined;
    const changed = change(entry);
    if (changed === undefined) return undefined;
    await store.put(ROUTINE_TYPE, object.id, { ...stored(changed), bot }, cause);
    return changed;
  });
}

/** Removes one routine: its object stays, marked removed, and is in no list of routines. */
async function removeEntry(store: ObjectStore, bot: string, name: string): Promise<boolean> {
  return withBotLock(store, bot, async () => {
    await botObject(store, bot);
    const object = await findRoutine(store, bot, name);
    if (object === undefined) return false;
    await store.put(ROUTINE_TYPE, object.id, { ...object.data, removed: true }, "action:bot/schedule-remove");
    return true;
  });
}

/** The current entry with the fields the proposal changed, from `before` to `after`, applied. */
function mergedEdit(
  current: ScheduledPrompt,
  before: ScheduledPrompt,
  after: ScheduledPrompt,
): ScheduledPrompt {
  const schedule = after.schedule === before.schedule ? current.schedule : after.schedule;
  const model = after.model === before.model ? current.model : after.model;
  const effort = after.effort === before.effort ? current.effort : after.effort;
  return {
    ...current,
    name: after.name,
    schedule,
    prompt: after.prompt === before.prompt ? current.prompt : after.prompt,
    ...(model === undefined ? { model: undefined } : { model }),
    ...(effort === undefined ? { effort: undefined } : { effort }),
  };
}

/** Applies a schedule proposal: the add, edit or remove the person approved. */
export async function applyScheduleChange(
  store: ObjectStore,
  bot: string,
  change: ScheduleChange,
): Promise<void> {
  if (change.action === "add") {
    if (change.after === null) throw new BotError("the proposal has no routine to add");
    await addEntry(store, bot, change.after);
    return;
  }
  if (change.action === "edit") {
    const before = change.before;
    const after = change.after;
    if (before === null || after === null) {
      throw new BotError("the proposal has no routine to change");
    }
    const changed = await replaceEntry(
      store,
      bot,
      before.name,
      // Only what the proposal changed is applied: the pause state, last run
      // and any edit made since the proposal stay as they are now.
      (current) => mergedEdit(current, before, after),
      "action:bot/schedule-edit",
    );
    if (changed === undefined) {
      throw new BotError(`bot ${bot} has no routine "${before.name}"`);
    }
    return;
  }
  if (change.before === null) {
    throw new BotError("the proposal has no routine to remove");
  }
  if (!(await removeEntry(store, bot, change.before.name))) {
    throw new BotError(`bot ${bot} has no routine "${change.before.name}"`);
  }
}

/** Adds one routine to the bot. */
async function addEntry(
  store: ObjectStore,
  bot: string,
  entry: ScheduledPrompt,
): Promise<ScheduledPrompt> {
  return withBotLock(store, bot, async () => {
    await botObject(store, bot);
    if ((await findRoutine(store, bot, entry.name)) !== undefined) {
      throw new BotError(`bot ${bot} already has a routine "${entry.name}"`);
    }
    await store.put(ROUTINE_TYPE, await nextRoutineId(store), { ...stored(entry), bot }, "action:bot/schedule-add");
    return entry;
  });
}

function entryArgs(required: boolean): ActionTypeDefinition["args"] {
  return {
    type: "object",
    properties: {
      name: {
        type: "string",
        minLength: 1,
        maxLength: 120,
        ...(required ? {} : { description: "The routine to change." }),
      },
      schedule: {
        type: "string",
        minLength: 1,
        description: "A five-field cron schedule in the machine's local time zone, such as `0 8 * * *`.",
      },
      prompt: {
        type: "string",
        role: "note",
        minLength: 1,
        description: "What the routine asks the agent each time it runs.",
      },
      model: {
        type: "string",
        description: "The model a run uses; the bot's model when left out. An empty value clears it.",
      },
      effort: {
        type: "string",
        description: "The effort a run uses; the bot's effort when left out. An empty value clears it.",
      },
    },
    ...(required ? { required: ["name", "schedule", "prompt"] } : { required: ["name"] }),
    additionalProperties: false,
  };
}

function nameArg(): ActionTypeDefinition["args"] {
  return {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, description: "The routine's name." },
    },
    required: ["name"],
    additionalProperties: false,
  };
}

/** What `add` takes. */
export interface AddInput {
  readonly name: string;
  readonly schedule: string;
  readonly prompt: string;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly paused?: boolean | undefined;
}

/** What `edit` takes: only what is given changes. */
export interface EditInput {
  readonly schedule?: string | undefined;
  readonly prompt?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}

/** Adds a routine to a bot. */
export async function addRoutine(store: ObjectStore, bot: string, input: AddInput): Promise<string> {
  const entry: ScheduledPrompt = {
    name: checkPromptName(input.name),
    schedule: checkSchedule(input.schedule),
    prompt: input.prompt.trim(),
    ...(text(input.model) === undefined ? {} : { model: input.model as string }),
    ...(text(input.effort) === undefined ? {} : { effort: input.effort as string }),
    paused: input.paused === true,
  };
  if (entry.prompt.length === 0) throw new BotError("a routine needs a prompt");
  await addEntry(store, bot, entry);
  return `added routine "${entry.name}" to bot ${bot}`;
}

/** Changes a routine; what is left out stays, and an empty model or effort clears it. */
export async function editRoutine(store: ObjectStore, bot: string, name: string, input: EditInput): Promise<string> {
  const changed = await replaceEntry(
    store,
    bot,
    name,
    (entry) => {
      const schedule = input.schedule === undefined ? entry.schedule : checkSchedule(input.schedule);
      const prompt = input.prompt === undefined ? entry.prompt : input.prompt.trim();
      if (prompt.length === 0) throw new BotError("a routine needs a prompt");
      const model = input.model === undefined ? entry.model : text(input.model);
      const effort = input.effort === undefined ? entry.effort : text(input.effort);
      return {
        ...entry,
        schedule,
        prompt,
        ...(model === undefined ? { model: undefined } : { model }),
        ...(effort === undefined ? { effort: undefined } : { effort }),
        // A changed schedule keeps `last`: the poll sees its schedule is not the
        // entry's, starts from a new baseline and keeps the run of a firing
        // that still awaits its notification, so no missed time is caught up.
      };
    },
    "action:bot/schedule-edit",
  );
  if (changed === undefined) throw new BotError(`bot ${bot} has no routine "${name}"`);
  return `edited routine "${name}" of bot ${bot}`;
}

/** Pauses a routine. */
export async function pauseRoutine(store: ObjectStore, bot: string, name: string): Promise<string> {
  const changed = await replaceEntry(
    store,
    bot,
    name,
    (entry) => (entry.paused ? undefined : { ...entry, paused: true }),
    "action:bot/schedule-pause",
  );
  if (changed === undefined) return `routine "${name}" is already paused`;
  return `paused routine "${name}" of bot ${bot}`;
}

/** Resumes a paused routine. */
export async function resumeRoutine(store: ObjectStore, bot: string, name: string): Promise<string> {
  const changed = await replaceEntry(
    store,
    bot,
    name,
    (entry) => (entry.paused ? { ...entry, paused: false } : undefined),
    "action:bot/schedule-resume",
  );
  if (changed === undefined) return `routine "${name}" is already running`;
  return `resumed routine "${name}" of bot ${bot}`;
}

/** Asks the source to run a routine once now; its next timed run is unchanged. */
export async function runRoutineNow(store: ObjectStore, bot: string, name: string): Promise<string> {
  const current = scheduledPromptOf((await findRoutine(store, bot, name))?.data);
  if (current !== undefined && isReplying(current.last)) {
    throw new BotError(
      `routine "${name}" of bot ${bot} is still running its previous run; run it now after that run ends`,
    );
  }
  const changed = await replaceEntry(
    store,
    bot,
    name,
    (entry) => ({ ...entry, runNow: entry.runNow ?? Date.now() }),
    "action:bot/schedule-run-now",
  );
  if (changed === undefined) throw new BotError(`bot ${bot} has no routine "${name}"`);
  return `running routine "${name}" of bot ${bot} now; its next timed run is unchanged`;
}

/** Removes a routine. */
export async function removeRoutine(store: ObjectStore, bot: string, name: string): Promise<string> {
  if (!(await removeEntry(store, bot, name))) throw new BotError(`bot ${bot} has no routine "${name}"`);
  return `removed routine "${name}" from bot ${bot}`;
}

const botUsable = (state: Readonly<Record<string, unknown>>): boolean => state.removed !== true;
const botWhy = (object: StoredObject): string | undefined =>
  object.data.removed === true ? `bot ${object.id} is no longer in the settings` : undefined;

/**
 * The actions on a bot that manage its routines. They keep the `schedule-*`
 * names: the command line, the MCP tools and the clients call them by those
 * names with the routine's name as an argument, and renaming them would break
 * every one of those. A routine's own page has the same actions without the name.
 */
export const scheduleActions: readonly ActionTypeDefinition[] = [
  {
    name: "schedule-add",
    on: BOT_TYPE,
    creates: ROUTINE_TYPE,
    args: {
      ...(entryArgs(true) as ActionArgsSchema),
      properties: {
        ...((entryArgs(true) as ActionArgsSchema).properties ?? {}),
        paused: {
          type: "boolean",
          default: false,
          description: "Start paused; it does not run until resumed.",
        },
      },
    },
    when: botUsable,
    why: botWhy,
    run: async (ctx, args) => addRoutine(ctx.store, ctx.object.id, args as unknown as AddInput),
  },
  {
    name: "schedule-edit",
    on: BOT_TYPE,
    args: entryArgs(false),
    when: botUsable,
    why: botWhy,
    run: async (ctx, args) => {
      const input = args as unknown as EditInput & { readonly name: string };
      return editRoutine(ctx.store, ctx.object.id, checkPromptName(input.name), input);
    },
  },
  {
    name: "schedule-pause",
    on: BOT_TYPE,
    args: nameArg(),
    when: botUsable,
    why: botWhy,
    run: async (ctx, args) =>
      pauseRoutine(ctx.store, ctx.object.id, checkPromptName((args as { readonly name: string }).name)),
  },
  {
    name: "schedule-resume",
    on: BOT_TYPE,
    args: nameArg(),
    when: botUsable,
    why: botWhy,
    run: async (ctx, args) =>
      resumeRoutine(ctx.store, ctx.object.id, checkPromptName((args as { readonly name: string }).name)),
  },
  {
    name: "schedule-run-now",
    on: BOT_TYPE,
    args: nameArg(),
    when: botUsable,
    why: botWhy,
    run: async (ctx, args) =>
      runRoutineNow(ctx.store, ctx.object.id, checkPromptName((args as { readonly name: string }).name)),
  },
  {
    name: "schedule-remove",
    on: BOT_TYPE,
    args: nameArg(),
    when: botUsable,
    why: botWhy,
    run: async (ctx, args) =>
      removeRoutine(ctx.store, ctx.object.id, checkPromptName((args as { readonly name: string }).name)),
  },
];

/** A value shown literally in Markdown: a code span that survives a backtick inside it. */
export function markdownCode(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

/** A user's text shown as text in Markdown: the characters that format are escaped. */
export function markdownText(value: string): string {
  return value.replace(/([\\`*_{}\[\]<>#|~!])/g, "\\$1").replace(/\r?\n/g, " ");
}

interface ScheduledSource {
  readonly store: ObjectStore;
  readonly home: string;
  readonly settings: Readonly<Record<string, JsonValue>>;
  readonly clock: () => number;
  readonly logger: PluginBaseContext["logger"];
  readonly client: SourceContext["client"];
  readonly runs?: RunControl | undefined;
  /** What a follow-up needs to put its message in the chat; without them none is sent. */
  readonly facts?: SourceContext["facts"] | undefined;
  readonly emit?: SourceContext["emit"] | undefined;
}

/** The bot's own source for scheduled prompts. */
export class BotScheduleSource {
  private readonly ctx: ScheduledSource;
  private readonly notify: (notice: ScheduleNotice) => Promise<void>;
  private readonly chatWatches: ChatWatches;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private busy = false;
  private lastCheck: number | undefined;

  constructor(
    ctx: ScheduledSource,
    options: { readonly notify?: ((notice: ScheduleNotice) => Promise<void>) | undefined } = {},
  ) {
    this.ctx = ctx;
    this.notify = options.notify ?? ((notice) => notifyScheduledReply(ctx.home, notice));
    this.chatWatches = new ChatWatches(ctx.logger, ctx.store, ctx.runs);
  }

  /** Waits for the checks that are running now; a test calls this after a reply. */
  async settled(): Promise<void> {
    await this.chatWatches.settled();
  }

  /** Emits at most one tick per entry, for the latest due or missed minute. */
  async poll(): Promise<void> {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      const now = this.ctx.clock();
      const previous = this.lastCheck;
      this.lastCheck = now;
      const catchUp = previous === undefined || now - previous > WAKE_GAP_MS;
      const objects = await this.bots();
      for (const object of objects) {
        if (object.data.removed === true) continue;
        const bot = object.id;
        for (const entry of await routinesOf(this.ctx.store, bot)) {
          if (entry.runNow !== undefined) {
            // The entry read here is stale after this; the next check handles its timed run.
            await this.runNow(bot, entry, now);
            continue;
          }
          await this.one(bot, entry, now, catchUp);
        }
        for (const followUp of followUps(object.data)) {
          if (followUp.at <= now) await this.followUp(bot, followUp, now);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * Sends a due follow-up into its chat (ADR 0030 D16). The entry is removed
   * first, so a crash loses it rather than sends it twice. A late one, such as
   * after `serve` was down, says when it was set for and how late it is.
   */
  private async followUp(bot: string, entry: FollowUp, now: number): Promise<void> {
    const { facts, emit } = this.ctx;
    if (facts === undefined || emit === undefined) return;
    if (!(await removeFollowUp(this.ctx.store, bot, entry.id, "source:bot/follow-up"))) return;
    const chat = await this.ctx.store.get(CHAT_TYPE, entry.chat);
    if (chat === undefined || chatData(chat.data).closed) {
      await this.chatWatches.log(`follow-up ${entry.id} of bot ${bot}: chat ${entry.chat} is closed or gone; dropped`);
      return;
    }
    const lateMs = now - entry.at;
    const parts = [`Follow-up you set for yourself: ${entry.text}`];
    if (lateMs >= WAKE_GAP_MS) parts.push(latenessLine(entry.at, Math.floor(lateMs / 1_000)));
    try {
      await sendMessage(
        { facts, emit: (event) => emit({ source: event.source, type: event.type, key: event.key, object: event.object ?? `${CHAT_TYPE}:${entry.chat}` }), store: this.ctx.store, home: this.ctx.home, actor: { via: SCHEDULE_SOURCE, id: "follow-up" }, source: SCHEDULE_SOURCE },
        entry.chat,
        parts.join("\n\n"),
      );
    } catch (error) {
      await this.chatWatches.log(`follow-up ${entry.id} of bot ${bot}: ${messageOf(error)}`);
    }
  }

  private async bots(): Promise<readonly StoredObject[]> {
    const found: StoredObject[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.ctx.store.list(BOT_TYPE, {
        ...(cursor === undefined ? {} : { cursor }),
      });
      found.push(...page.objects);
      cursor = page.next;
    } while (cursor !== undefined);
    return found;
  }

  private async one(bot: string, entry: ScheduledPrompt, now: number, catchUp: boolean): Promise<void> {
    const latest = latestCronMinute(parseCron(entry.schedule), now, CATCH_UP_DAYS);
    const baseline = latest ?? minuteStart(now);
    if (entry.paused) {
      // A paused entry does not collect missed times: its planned time follows
      // the clock, so resuming waits for the next planned minute. Its last
      // result is kept.
      const kept =
        entry.last !== undefined && entry.last.schedule === entry.schedule
          ? entry.last
          : undefined;
      if (kept?.plannedAt !== baseline) {
        await this.setLast(bot, entry.name, {
          ...(kept ?? {}),
          plannedAt: baseline,
          schedule: entry.schedule,
        });
      }
      return;
    }
    const last =
      entry.last !== undefined && entry.last.schedule === entry.schedule ? entry.last : undefined;
    if (last === undefined) {
      await this.setLast(bot, entry.name, {
        ...(entry.last?.result === undefined
          ? {}
          : { result: entry.last.result, ...(entry.last.notified === true ? { notified: true } : {}) }),
        ...(entry.last?.runId === undefined ? {} : { runId: entry.last.runId }),
        plannedAt: baseline,
        schedule: entry.schedule,
      });
      return;
    }
    let minute: number | null;
    let skipped: readonly number[] = [];
    if (catchUp) {
      if (latest === null || latest <= last.plannedAt) return;
      const windowStart = Math.max(last.plannedAt, minuteStart(now) - CATCH_UP_DAYS * DAY_MS);
      if (latest <= windowStart) {
        await this.setLast(bot, entry.name, { ...last, plannedAt: latest });
        return;
      }
      skipped = cronMinutesBetween(parseCron(entry.schedule), windowStart, latest).slice(0, -1);
      minute = latest;
    } else {
      minute = latest !== null && latest > last.plannedAt ? latest : null;
    }
    if (minute === null) return;
    await this.fire(bot, entry, minute, now, skipped);
  }

  /**
   * Fires an entry once because a person asked. The request is cleared first, so
   * a crash loses it rather than runs it twice. The planned time and schedule of
   * `last` stay what the timed runs expect, so the next timed run is unchanged.
   */
  private async runNow(bot: string, entry: ScheduledPrompt, now: number): Promise<void> {
    const cleared = await replaceEntry(
      this.ctx.store,
      bot,
      entry.name,
      (current) => (current.runNow === undefined ? undefined : { ...current, runNow: undefined }),
      "source:bot/run-now",
    );
    if (cleared === undefined) return;
    // A firing started since the request was made still owns `last`: drop the request.
    if (isReplying(cleared.last)) {
      await this.chatWatches.log(
        `routine "${entry.name}" of bot ${bot}: run now dropped, the previous firing is still replying`,
      );
      return;
    }
    const last = entry.last !== undefined && entry.last.schedule === entry.schedule ? entry.last : undefined;
    const latest = latestCronMinute(parseCron(entry.schedule), now, CATCH_UP_DAYS);
    const planned = last?.plannedAt ?? latest ?? minuteStart(now);
    await this.fire(bot, entry, planned, now, [], true);
  }

  private async fire(
    bot: string,
    entry: ScheduledPrompt,
    minute: number,
    now: number,
    skipped: readonly number[],
    manual = false,
  ): Promise<void> {
    const recorded = {
      plannedAt: minute,
      firedAt: now,
      schedule: entry.schedule,
      ...(skipped.length > 0 ? { skippedEarlier: true } : {}),
      ...(manual ? { manual: true } : {}),
    };
    await this.setLast(bot, entry.name, recorded);
    const title = `${entry.name} (${localDate(manual ? now : minute)})`.slice(0, 120);
    let runId: string | undefined;
    try {
      const run = await this.ctx.client.act("bot:chat", `${BOT_TYPE}:${bot}`, {
        args: {
          title,
          // The person's own prompt; the bot:chat action adds what only the agent needs.
          message: entry.prompt,
          ...(entry.model === undefined ? {} : { model: entry.model }),
          ...(entry.effort === undefined ? {} : { effort: entry.effort }),
        },
        // The routine's name is the origin recorded on the run; an actor from
        // this source makes the action start a run, not a chat.
        actor: { via: SCHEDULE_SOURCE, id: entry.name },
      });
      runId = run.opens?.startsWith(`${CHAT_TYPE}:`) === true
        ? run.opens.slice(CHAT_TYPE.length + 1)
        : undefined;
    } catch (error) {
      const message = messageOf(error);
      await this.setLast(bot, entry.name, {
        ...recorded,
        result: replySummary(`Could not start: ${message}`),
        failed: true,
      });
      return;
    }
    if (runId === undefined) {
      await this.chatWatches.log(`routine "${entry.name}" of bot ${bot} started no run`);
      return;
    }
    const changed = await replaceEntry(
      this.ctx.store,
      bot,
      entry.name,
      (current) =>
        current.last?.plannedAt === minute
          ? {
              ...current,
              last: { ...current.last, runId },
              runs: withRun(current.runs, { id: runId, at: now, status: "running", ...(manual ? { manual: true } : {}) }, now),
            }
          : undefined,
      "step:bot/scheduled",
    );
    if (changed === undefined) return;
    await this.watch(bot, entry.name, manual ? now : minute, runId);
    if (skipped.length > 0) {
      await this.chatWatches.log(
        `routine "${entry.name}" of bot ${bot}: skipped ${skipped
          .map((time) => new Date(time).toISOString())
          .join(", ")}; only the latest missed run is caught up`,
      );
    }
  }

  private async setLast(bot: string, name: string, last: ScheduledLast): Promise<void> {
    await replaceEntry(
      this.ctx.store,
      bot,
      name,
      (entry) => ({ ...entry, last }),
      "source:bot/scheduled",
    );
  }

  private async watch(bot: string, name: string, plannedAt: number, runId: string): Promise<void> {
    const key = `${bot}\u0000${name}\u0000${plannedAt}\u0000${runId}`;
    this.chatWatches.watchChatReply(
      key,
      runId,
      async (read) => {
        const record = await this.ctx.store.get(CHAT_TYPE, runId);
        if (record === undefined) return undefined;
        const reply = [...read.messages].reverse().find((message) => message.role === "assistant");
        const failure = [...read.entries].reverse().find((item) => item.kind === "failure");
        // A failure after the reply means the run did not end quietly.
        const failedAfter = reply !== undefined && failure !== undefined && failure.sequence > reply.sequence;
        const quiet = reply !== undefined && !failedAfter && isQuietReply(reply.text);
        const failed = reply === undefined || failedAfter;
        const result = quiet
          ? SCHEDULE_QUIET_RESULT
          : reply === undefined
            ? failure === undefined
              ? undefined
              : replySummary(failure.text ?? "The reply failed.")
            : failedAfter
              ? replySummary(failure.text ?? "The reply failed.")
              : replySummary(reply.text);
        if (result === undefined) return undefined;
        return { result, quiet, failed };
      },
      async ({ result, quiet, failed }) => {
        const now = this.ctx.clock();
        const status: RoutineRunStatus = quiet ? "quiet" : failed ? "failed" : "done";
        await replaceEntry(
          this.ctx.store,
          bot,
          name,
          (entry) =>
            entry.last?.runId === runId
              ? {
                  ...entry,
                  last: { ...entry.last, result, notified: quiet, ...(failed ? { failed: true } : {}) },
                  recent: [
                    ...(entry.recent ?? []).filter((item) => item.plannedAt !== plannedAt),
                    { plannedAt, result },
                  ].slice(-SCHEDULE_RECENT_COUNT),
                  runs: withRun(
                    entry.runs,
                    { id: runId, at: entry.runs?.find((item) => item.id === runId)?.at ?? now, status, result, ...(entry.last.manual === true ? { manual: true } : {}) },
                    now,
                  ),
                }
              : undefined,
          "step:bot/scheduled",
        );
        // A quiet ending records its result and runs no notify command.
        if (quiet) return;
        try {
          const routine = await findRoutine(this.ctx.store, bot, name);
          await this.notify({ routineId: routine?.id ?? "", runId, title: name, summary: result });
        } catch (error) {
          await this.chatWatches.log(
            `routine "${name}" of bot ${bot}: notify: ${messageOf(error)}`,
          );
        }
        await replaceEntry(
          this.ctx.store,
          bot,
          name,
          (entry) =>
            entry.last?.runId === runId
              ? { ...entry, last: { ...entry.last, notified: true } }
              : undefined,
          "step:bot/scheduled",
        );
      },
    );
  }

  /** Watches a firing that was already started, such as one from before a restart. */
  private async resumeWatches(): Promise<void> {
    for (const object of await this.bots()) {
      if (object.data.removed === true) continue;
      for (const entry of await routinesOf(this.ctx.store, object.id)) {
        const last = entry.last;
        if (last?.runId === undefined || last.notified === true) continue;
        await this.watch(object.id, entry.name, last.manual === true && last.firedAt !== undefined ? last.firedAt : last.plannedAt, last.runId);
      }
    }
  }

  start(): SourceHandle {
    this.timer = setInterval(() => {
      this.chatWatches.track(this.poll());
    }, CHECK_INTERVAL_MS);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
    return {
      stop: () => {
        this.stopped = true;
        if (this.timer !== undefined) clearInterval(this.timer);
        this.chatWatches.stopAll();
      },
    };
  }

  /** The source's first pass, after the bot plugin has made its objects. */
  async begin(): Promise<void> {
    try {
      await this.ctx.client.list(BOT_TYPE);
    } catch (error) {
      await this.chatWatches.log(`routines: ${messageOf(error)}`);
    }
    await this.resumeWatches();
    await this.poll();
  }
}

/** The source the bot plugin declares; `begin` runs before the first interval. */
export async function startScheduled(ctx: SourceContext): Promise<SourceHandle> {
  const source = new BotScheduleSource(ctx);
  await source.begin();
  return source.start();
}

