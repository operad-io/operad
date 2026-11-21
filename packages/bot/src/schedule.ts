/**
 * Scheduled prompts of a bot. The bot plugin is its own source: it reads the
 * entries from its bot objects, fires the latest planned minute when it is due,
 * opens a chat with the prompt, and when the reply ends it records the result
 * and runs the same notify command a wait uses.
 *
 * An entry lives on the bot object (`scheduled`), not in `config.json`: a
 * client's change is the owner's own edit and applies at once, and `serve` needs
 * no reload. The schedule is a five-field cron expression in the machine's local
 * time zone, with the catch-up rule of the cron source (ADR 0032 D11).
 */

import { CHAT_TYPE, allEntries, allMessages, chatFacts, writingReply } from "@operad-io/chat";
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
  type SourceContext,
  type SourceHandle,
  type StoredObject,
} from "@operad-io/engine";
import { runLine } from "@operad-io/engine/platform";
import { BOT_TYPE, BotError } from "./bot.ts";

/** The source's name for a scheduled message; a message from it is a background run. */
export const SCHEDULE_SOURCE = "bot";

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
  /** The chat the firing opened. */
  readonly chatId?: string | undefined;
  /** A short summary of the reply, or why it could not start. */
  readonly result?: string | undefined;
  /** True once the notify command was run for `result`. */
  readonly notified?: boolean | undefined;
}

/** One scheduled prompt of a bot. */
export interface ScheduledPrompt {
  readonly name: string;
  /** A five-field cron expression in the machine's local time zone. */
  readonly schedule: string;
  readonly prompt: string;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly paused: boolean;
  readonly last?: ScheduledLast | undefined;
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
    ...(text(value.chatId) === undefined ? {} : { chatId: value.chatId as string }),
    ...(text(value.result) === undefined ? {} : { result: value.result as string }),
    ...(value.notified === true ? { notified: true } : {}),
  };
}

/** One scheduled prompt from stored data, or undefined when it is unusable. */
export function scheduledPromptOf(value: unknown): ScheduledPrompt | undefined {
  if (!isRecord(value)) return undefined;
  const name = text(value.name);
  const schedule = text(value.schedule);
  const prompt = text(value.prompt);
  if (name === undefined || schedule === undefined || prompt === undefined) return undefined;
  const last = lastOf(value.last);
  return {
    name,
    schedule,
    prompt,
    ...(text(value.model) === undefined ? {} : { model: value.model as string }),
    ...(text(value.effort) === undefined ? {} : { effort: value.effort as string }),
    paused: value.paused === true,
    ...(last === undefined ? {} : { last }),
  };
}

/** The scheduled prompts written on a bot object, skipping an unusable entry. */
export function scheduledPrompts(data: Readonly<Record<string, unknown>>): readonly ScheduledPrompt[] {
  const raw = data.scheduled;
  if (!Array.isArray(raw)) return [];
  const found: ScheduledPrompt[] = [];
  for (const value of raw) {
    const entry = scheduledPromptOf(value);
    if (entry !== undefined) found.push(entry);
  }
  return found;
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
  };
}

/** The name a client uses to choose an entry; unique within one bot. */
export function checkPromptName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new BotError("a scheduled prompt needs a name");
  if (trimmed.length > 120) throw new BotError("a scheduled prompt's name is at most 120 characters");
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

/** What a bot chat's first session starts with: a schedule it writes is a proposal. */
export const SCHEDULE_INSTRUCTION =
  "To schedule something for me, propose it: call the operad `command` tool with plugin `bot`, verb `schedule`, action `add` (or `edit` or `remove`). Give the schedule both as a five-field cron expression and in words. Nothing takes effect until I approve it in Pending.";

/** The text and place a bot chat starts with. */
export function scheduledChatContext(): { readonly text: string; readonly where: string } {
  return { text: SCHEDULE_INSTRUCTION, where: SCHEDULE_INSTRUCTION };
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

/** One scheduled prompt as a client reads it from a bot row, without parsing Markdown. */
export interface ScheduledPromptView {
  readonly name: string;
  readonly schedule: string;
  readonly prompt: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly paused: boolean;
  /** The next planned minute as an ISO time; null when paused or none is within two years. */
  readonly nextRun: string | null;
  /** The last reply's summary, or why it could not start; null before the first firing. */
  readonly lastResult: string | null;
  /** The chat the last firing opened; null before the first firing. */
  readonly lastChatId: string | null;
}

/** The structured entries a bot row gives a client. */
export function scheduledData(
  entries: readonly ScheduledPrompt[],
  now: number,
): readonly ScheduledPromptView[] {
  return entries.map((entry) => {
    const next = nextRun(entry, now);
    return {
      name: entry.name,
      schedule: entry.schedule,
      prompt: entry.prompt,
      model: entry.model ?? null,
      effort: entry.effort ?? null,
      paused: entry.paused,
      nextRun: next === null ? null : new Date(next).toISOString(),
      lastResult: entry.last?.result ?? null,
      lastChatId: entry.last?.chatId ?? null,
    };
  });
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
  readonly chatId: string;
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
      OPERAD_ID: `${CHAT_TYPE}:${notice.chatId}`,
      OPERAD_TITLE: notice.title,
      OPERAD_REASON: notice.summary,
      OPERAD_LINK: objectLink(CHAT_TYPE, notice.chatId),
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

/** Replaces one entry on the bot object, leaving the others and the bot's settings alone. */
async function replaceEntry(
  store: ObjectStore,
  bot: string,
  name: string,
  change: (entry: ScheduledPrompt) => ScheduledPrompt | undefined,
  cause: string,
): Promise<ScheduledPrompt | undefined> {
  const object = await botObject(store, bot);
  const entries = scheduledPrompts(object.data);
  let changed: ScheduledPrompt | undefined;
  const next: ScheduledPrompt[] = [];
  for (const entry of entries) {
    if (entry.name !== name) {
      next.push(entry);
      continue;
    }
    changed = change(entry);
    if (changed !== undefined) next.push(changed);
  }
  if (changed === undefined) return undefined;
  await store.put(
    BOT_TYPE,
    bot,
    { ...object.data, scheduled: next.map(stored) as unknown as JsonValue[] },
    cause,
  );
  return changed;
}

/** Removes one entry from the bot object. */
async function removeEntry(store: ObjectStore, bot: string, name: string): Promise<boolean> {
  const object = await botObject(store, bot);
  const entries = scheduledPrompts(object.data);
  const next = entries.filter((entry) => entry.name !== name);
  if (next.length === entries.length) return false;
  await store.put(
    BOT_TYPE,
    bot,
    { ...object.data, scheduled: next.map(stored) as unknown as JsonValue[] },
    "action:bot/schedule-remove",
  );
  return true;
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
    if (change.after === null) throw new BotError("the proposal has no scheduled prompt to add");
    await addEntry(store, bot, change.after);
    return;
  }
  if (change.action === "edit") {
    const before = change.before;
    const after = change.after;
    if (before === null || after === null) {
      throw new BotError("the proposal has no scheduled prompt to change");
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
      throw new BotError(`bot ${bot} has no scheduled prompt "${before.name}"`);
    }
    return;
  }
  if (change.before === null) {
    throw new BotError("the proposal has no scheduled prompt to remove");
  }
  if (!(await removeEntry(store, bot, change.before.name))) {
    throw new BotError(`bot ${bot} has no scheduled prompt "${change.before.name}"`);
  }
}

/** Adds one entry to the bot object. */
async function addEntry(
  store: ObjectStore,
  bot: string,
  entry: ScheduledPrompt,
): Promise<ScheduledPrompt> {
  const object = await botObject(store, bot);
  const entries = scheduledPrompts(object.data);
  if (entries.some((item) => item.name === entry.name)) {
    throw new BotError(`bot ${bot} already has a scheduled prompt "${entry.name}"`);
  }
  await store.put(
    BOT_TYPE,
    bot,
    { ...object.data, scheduled: [...entries, entry].map(stored) as unknown as JsonValue[] },
    "action:bot/schedule-add",
  );
  return entry;
}

function entryArgs(required: boolean): ActionTypeDefinition["args"] {
  return {
    type: "object",
    properties: {
      name: {
        type: "string",
        minLength: 1,
        maxLength: 120,
        ...(required ? {} : { description: "The scheduled prompt to change." }),
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
        description: "The first message of the new chat.",
      },
      model: {
        type: "string",
        description: "The model the new chat uses; the bot's model when left out. An empty value clears it.",
      },
      effort: {
        type: "string",
        description: "The effort the new chat uses; the bot's effort when left out. An empty value clears it.",
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
      name: { type: "string", minLength: 1, description: "The scheduled prompt's name." },
    },
    required: ["name"],
    additionalProperties: false,
  };
}

/** The actions a client uses to manage a bot's scheduled prompts. */
export const scheduleActions: readonly ActionTypeDefinition[] = [
  {
    name: "schedule-add",
    on: BOT_TYPE,
    args: {
      ...(entryArgs(true) as ActionArgsSchema),
      properties: {
        ...((entryArgs(true) as ActionArgsSchema).properties ?? {}),
        paused: {
          type: "boolean",
          default: false,
          description: "Start paused; it does not fire until resumed.",
        },
      },
    },
    when: (state) => state.removed !== true,
    why: (object) =>
      object.data.removed === true ? `bot ${object.id} is no longer in the settings` : undefined,
    async run(ctx, args) {
      const input = args as {
        readonly name: string;
        readonly schedule: string;
        readonly prompt: string;
        readonly model?: string;
        readonly effort?: string;
        readonly paused?: boolean;
      };
      const entry: ScheduledPrompt = {
        name: checkPromptName(input.name),
        schedule: checkSchedule(input.schedule),
        prompt: input.prompt.trim(),
        ...(text(input.model) === undefined ? {} : { model: input.model as string }),
        ...(text(input.effort) === undefined ? {} : { effort: input.effort as string }),
        paused: input.paused === true,
      };
      if (entry.prompt.length === 0) throw new BotError("a scheduled prompt needs a prompt");
      await addEntry(ctx.store, ctx.object.id, entry);
      return `scheduled prompt "${entry.name}" for bot ${ctx.object.id}`;
    },
  },
  {
    name: "schedule-edit",
    on: BOT_TYPE,
    args: entryArgs(false),
    when: (state) => state.removed !== true,
    why: (object) =>
      object.data.removed === true ? `bot ${object.id} is no longer in the settings` : undefined,
    async run(ctx, args) {
      const input = args as {
        readonly name: string;
        readonly schedule?: string;
        readonly prompt?: string;
        readonly model?: string;
        readonly effort?: string;
      };
      const name = checkPromptName(input.name);
      const changed = await replaceEntry(
        ctx.store,
        ctx.object.id,
        name,
        (entry) => {
          const schedule = input.schedule === undefined ? entry.schedule : checkSchedule(input.schedule);
          const prompt = input.prompt === undefined ? entry.prompt : input.prompt.trim();
          if (prompt.length === 0) throw new BotError("a scheduled prompt needs a prompt");
          const model = input.model === undefined ? entry.model : text(input.model);
          const effort = input.effort === undefined ? entry.effort : text(input.effort);
          return {
            ...entry,
            schedule,
            prompt,
            // An empty value clears the field; leaving it out keeps the old one.
            ...(model === undefined ? { model: undefined } : { model }),
            ...(effort === undefined ? { effort: undefined } : { effort }),
            // A changed schedule keeps `last`: the poll sees its schedule is not the
            // entry's, starts from a new baseline and keeps the chat of a firing
            // that still awaits its notification, so no missed time is caught up.
          };
        },
        "action:bot/schedule-edit",
      );
      if (changed === undefined) throw new BotError(`bot ${ctx.object.id} has no scheduled prompt "${name}"`);
      return `edited scheduled prompt "${name}" for bot ${ctx.object.id}`;
    },
  },
  {
    name: "schedule-pause",
    on: BOT_TYPE,
    args: nameArg(),
    when: (state) => state.removed !== true,
    why: (object) =>
      object.data.removed === true ? `bot ${object.id} is no longer in the settings` : undefined,
    async run(ctx, args) {
      const name = checkPromptName((args as { readonly name: string }).name);
      const changed = await replaceEntry(
        ctx.store,
        ctx.object.id,
        name,
        (entry) => (entry.paused ? undefined : { ...entry, paused: true }),
        "action:bot/schedule-pause",
      );
      if (changed === undefined) return `scheduled prompt "${name}" is already paused`;
      return `paused scheduled prompt "${name}" for bot ${ctx.object.id}`;
    },
  },
  {
    name: "schedule-resume",
    on: BOT_TYPE,
    args: nameArg(),
    when: (state) => state.removed !== true,
    why: (object) =>
      object.data.removed === true ? `bot ${object.id} is no longer in the settings` : undefined,
    async run(ctx, args) {
      const name = checkPromptName((args as { readonly name: string }).name);
      const changed = await replaceEntry(
        ctx.store,
        ctx.object.id,
        name,
        (entry) => (entry.paused ? { ...entry, paused: false } : undefined),
        "action:bot/schedule-resume",
      );
      if (changed === undefined) return `scheduled prompt "${name}" is already running`;
      return `resumed scheduled prompt "${name}" for bot ${ctx.object.id}`;
    },
  },
  {
    name: "schedule-remove",
    on: BOT_TYPE,
    args: nameArg(),
    when: (state) => state.removed !== true,
    why: (object) =>
      object.data.removed === true ? `bot ${object.id} is no longer in the settings` : undefined,
    async run(ctx, args) {
      const name = checkPromptName((args as { readonly name: string }).name);
      if (!(await removeEntry(ctx.store, ctx.object.id, name))) {
        throw new BotError(`bot ${ctx.object.id} has no scheduled prompt "${name}"`);
      }
      return `removed scheduled prompt "${name}" from bot ${ctx.object.id}`;
    },
  },
];

/** The lines a bot page shows for its scheduled prompts. */
export function scheduledMarkdown(entries: readonly ScheduledPrompt[], now: number): string[] {
  if (entries.length === 0) return ["Scheduled: none."];
  const lines = ["Scheduled:"];
  for (const entry of entries) {
    const next = nextRun(entry, now);
    const state = entry.paused ? " (paused)" : next === null ? "" : `, next ${localStamp(next)}`;
    const last = entry.last;
    const ended =
      last?.result === undefined
        ? ""
        : `; last ${last.chatId === undefined ? "" : `chat ${last.chatId}: `}${last.result}`;
    lines.push(`- ${entry.name} (${entry.schedule}${state})${ended}`);
  }
  return lines;
}

interface ScheduledSource {
  readonly store: ObjectStore;
  readonly home: string;
  readonly settings: Readonly<Record<string, JsonValue>>;
  readonly clock: () => number;
  readonly logger: PluginBaseContext["logger"];
  readonly client: SourceContext["client"];
}

/** One firing the source is watching for its reply. */
interface Watch {
  readonly stop: () => void;
  readonly check: () => Promise<void>;
}

/** The bot's own source for scheduled prompts. */
export class BotScheduleSource {
  private readonly ctx: ScheduledSource;
  private readonly notify: (notice: ScheduleNotice) => Promise<void>;
  private readonly watches = new Map<string, Watch>();
  private readonly work = new Set<Promise<void>>();
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
  }

  private async log(message: string): Promise<void> {
    await this.ctx.logger.write(message);
  }

  private track(work: Promise<void>): void {
    const tracked = work
      .catch((error: unknown) => this.log(error instanceof Error ? error.message : String(error)))
      .finally(() => this.work.delete(tracked));
    this.work.add(tracked);
  }

  /** Waits for the checks that are running now; a test calls this after a reply. */
  async settled(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work]);
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
        for (const entry of scheduledPrompts(object.data)) {
          await this.one(bot, entry, now, catchUp);
        }
      }
    } finally {
      this.busy = false;
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
        ...(entry.last?.chatId === undefined ? {} : { chatId: entry.last.chatId }),
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
    const late = minute < minuteStart(now) || skipped.length > 0;
    await this.fire(bot, entry, minute, now, late, skipped);
  }

  private async fire(
    bot: string,
    entry: ScheduledPrompt,
    minute: number,
    now: number,
    late: boolean,
    skipped: readonly number[],
  ): Promise<void> {
    const lateSecs = Math.floor((now - minute) / 1_000);
    await this.setLast(bot, entry.name, {
      plannedAt: minute,
      firedAt: now,
      schedule: entry.schedule,
    });
    const prompt = late
      ? `${entry.prompt}\n\n${latenessLine(minute, lateSecs)}`
      : entry.prompt;
    const title = `${entry.name} (${localDate(minute)})`.slice(0, 120);
    let chatId: string | undefined;
    try {
      const run = await this.ctx.client.act("bot:chat", `${BOT_TYPE}:${bot}`, {
        args: {
          title,
          message: prompt,
          ...(entry.model === undefined ? {} : { model: entry.model }),
          ...(entry.effort === undefined ? {} : { effort: entry.effort }),
        },
        // The entry's name is the origin recorded on the new chat.
        actor: { via: SCHEDULE_SOURCE, id: entry.name },
      });
      chatId = run.opens?.startsWith(`${CHAT_TYPE}:`) === true
        ? run.opens.slice(CHAT_TYPE.length + 1)
        : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.setLast(bot, entry.name, {
        plannedAt: minute,
        firedAt: now,
        schedule: entry.schedule,
        result: replySummary(`Could not start: ${message}`),
      });
      return;
    }
    if (chatId === undefined) {
      await this.log(`scheduled prompt "${entry.name}" of bot ${bot} opened no chat`);
      return;
    }
    const changed = await replaceEntry(
      this.ctx.store,
      bot,
      entry.name,
      (current) =>
        current.last?.plannedAt === minute
          ? { ...current, last: { ...current.last, chatId } }
          : undefined,
      "step:bot/scheduled",
    );
    if (changed === undefined) return;
    await this.watch(bot, entry.name, minute, chatId);
    if (skipped.length > 0) {
      await this.log(
        `scheduled prompt "${entry.name}" of bot ${bot}: skipped ${skipped
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

  private async watch(bot: string, name: string, plannedAt: number, chatId: string): Promise<void> {
    const key = `${bot}\u0000${name}\u0000${plannedAt}\u0000${chatId}`;
    if (this.watches.has(key)) return;
    let running = false;
    let stopped = false;
    let unsubscribe: (() => void) | undefined;
    const check = async (): Promise<void> => {
      if (running || stopped) return;
      running = true;
      try {
        const chat = await this.ctx.store.get(CHAT_TYPE, chatId);
        if (chat === undefined) return;
        const messages = allMessages(this.ctx.store, chatId);
        const entries = allEntries(this.ctx.store, chatId);
        // A reply that goes round again is not finished at its first message.
        if (writingReply(chatFacts(this.ctx.store, chatId), messages, entries) !== undefined) return;
        const reply = [...messages].reverse().find((message) => message.role === "assistant");
        const failure = [...entries].reverse().find((item) => item.kind === "failure");
        const result =
          reply === undefined
            ? failure === undefined
              ? undefined
              : replySummary(failure.text ?? "The reply failed.")
            : replySummary(reply.text);
        if (result === undefined) return;
        stopped = true;
        unsubscribe?.();
        this.watches.delete(key);
        await replaceEntry(
          this.ctx.store,
          bot,
          name,
          (entry) =>
            entry.last?.chatId === chatId
              ? { ...entry, last: { ...entry.last, result, notified: false } }
              : undefined,
          "step:bot/scheduled",
        );
        const title = typeof chat.data.title === "string" ? chat.data.title : chatId;
        try {
          await this.notify({ chatId, title, summary: result });
        } catch (error) {
          await this.log(
            `scheduled prompt "${name}" of bot ${bot}: notify: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await replaceEntry(
          this.ctx.store,
          bot,
          name,
          (entry) =>
            entry.last?.chatId === chatId
              ? { ...entry, last: { ...entry.last, notified: true } }
              : undefined,
          "step:bot/scheduled",
        );
      } finally {
        running = false;
      }
    };
    const blocking = {
      stop: () => {
        stopped = true;
        unsubscribe?.();
        this.watches.delete(key);
      },
      check,
    };
    this.watches.set(key, blocking);
    unsubscribe = this.ctx.store.subscribe({ type: CHAT_TYPE, id: chatId }, {}, () => {
      this.track(check());
    });
    this.track(check());
  }

  /** Watches a firing that was already started, such as one from before a restart. */
  private async resumeWatches(): Promise<void> {
    for (const object of await this.bots()) {
      if (object.data.removed === true) continue;
      for (const entry of scheduledPrompts(object.data)) {
        const last = entry.last;
        if (last?.chatId === undefined || last.notified === true) continue;
        await this.watch(object.id, entry.name, last.plannedAt, last.chatId);
      }
    }
  }

  start(): SourceHandle {
    this.timer = setInterval(() => {
      this.track(this.poll());
    }, CHECK_INTERVAL_MS);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
    return {
      stop: () => {
        this.stopped = true;
        if (this.timer !== undefined) clearInterval(this.timer);
        for (const watch of [...this.watches.values()]) watch.stop();
        this.watches.clear();
      },
    };
  }

  /** The source's first pass, after the bot plugin has made its objects. */
  async begin(): Promise<void> {
    try {
      await this.ctx.client.list(BOT_TYPE);
    } catch (error) {
      await this.log(`scheduled prompts: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.resumeWatches();
    await this.poll();
  }
}

/** Confirms that a message from this source is not a person's. */
export function scheduledMessageSource(): string {
  return SCHEDULE_SOURCE;
}

/** The source the bot plugin declares; `begin` runs before the first interval. */
export async function startScheduled(ctx: SourceContext): Promise<SourceHandle> {
  const source = new BotScheduleSource(ctx);
  await source.begin();
  return source.start();
}

