/**
 * Follow-ups of a bot (ADR 0030 D16): a one-time deadline an agent sets for
 * itself in a chat. An entry is stored on the bot object (`followUps`), so it
 * survives a restart; the bot's source sends its sentence into the same chat
 * when it is due.
 */

import { CHAT_TYPE, chatData } from "@operad-io/chat";
import type {
  ActionTypeDefinition,
  CommandContext,
  JsonValue,
  ObjectStore,
  StoredObject,
} from "@operad-io/engine";
import { BOT_TYPE, BotError } from "./bot.ts";
import { localStamp } from "./schedule.ts";

/** At most this many not-yet-due follow-ups in one chat. */
export const FOLLOW_UP_PER_CHAT = 5;
/** A follow-up is due at most this many days ahead. */
export const FOLLOW_UP_DAYS = 30;
/** The longest sentence a follow-up keeps. */
export const FOLLOW_UP_TEXT_MAX = 500;
const DAY_MS = 24 * 60 * 60_000;

/** One follow-up, as the bot object stores it. */
export interface FollowUp {
  readonly id: string;
  /** The chat it was set in and returns to. */
  readonly chat: string;
  /** When it is due, in epoch milliseconds. */
  readonly at: number;
  /** One sentence of what to do. */
  readonly text: string;
  /** When it was set, in epoch milliseconds. */
  readonly setAt: number;
}

function followUpOf(value: unknown): FollowUp | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const { id, chat, at, text, setAt } = item;
  if (typeof id !== "string" || id.length === 0) return undefined;
  if (typeof chat !== "string" || chat.length === 0) return undefined;
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
  if (typeof text !== "string" || text.length === 0) return undefined;
  return { id, chat, at, text, setAt: typeof setAt === "number" && Number.isFinite(setAt) ? setAt : at };
}

/** The follow-ups written on a bot object, skipping an unusable entry. */
export function followUps(data: Readonly<Record<string, unknown>>): readonly FollowUp[] {
  const raw = data.followUps;
  if (!Array.isArray(raw)) return [];
  const found: FollowUp[] = [];
  for (const value of raw) {
    const entry = followUpOf(value);
    if (entry !== undefined) found.push(entry);
  }
  return found;
}

/** One follow-up as a client reads it from a bot row. */
export interface FollowUpView {
  readonly id: string;
  readonly chatId: string;
  /** The due time as an ISO time. */
  readonly due: string;
  readonly text: string;
}

/** The structured entries a bot row gives a client, soonest first. */
export function followUpData(entries: readonly FollowUp[]): readonly FollowUpView[] {
  return [...entries]
    .sort((a, b) => a.at - b.at)
    .map((entry) => ({
      id: entry.id,
      chatId: entry.chat,
      due: new Date(entry.at).toISOString(),
      text: entry.text,
    }));
}

/** The lines a bot page shows for its follow-ups. */
export function followUpMarkdown(entries: readonly FollowUp[]): string[] {
  if (entries.length === 0) return ["Follow-up: none."];
  const lines = ["Follow-up:"];
  for (const entry of [...entries].sort((a, b) => a.at - b.at)) {
    lines.push(`- ${entry.id}: ${localStamp(entry.at)}, chat ${entry.chat}: ${entry.text}`);
  }
  return lines;
}

const UNIT_MS: Readonly<Record<string, number>> = { m: 60_000, h: 3_600_000, d: DAY_MS };

/**
 * A due time from the agent's words: relative (`+30m`, `+2h`, `+3d`, `in 2
 * hours`) or absolute (`YYYY-MM-DD HH:mm` or an ISO time; local time when it
 * names no zone).
 */
export function parseDue(input: string, now: number): number {
  const text = input.trim();
  const relative = /^(?:in\s+|\+)\s*(\d+)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)$/i.exec(text);
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unit = (relative[2] ?? "m").charAt(0).toLowerCase();
    return now + amount * (UNIT_MS[unit] ?? 60_000);
  }
  const absolute =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?$/i.exec(text);
  if (absolute !== null) {
    if (absolute[7] !== undefined) {
      const parsed = Date.parse(text.replace(" ", "T"));
      if (Number.isFinite(parsed)) return parsed;
    } else {
      const [, y, mo, d, h, mi, s] = absolute;
      const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
      // A day the calendar rolled over (2026-02-30) is not a time.
      if (date.getMonth() === Number(mo) - 1 && date.getDate() === Number(d)) return date.getTime();
    }
  }
  throw new BotError(
    `a follow-up's time is not understood: "${input}"; give a time such as "2026-12-01 09:00" or "+2h"`,
  );
}

function newId(): string {
  return `F-${crypto.randomUUID().slice(0, 8)}`;
}

async function botObject(store: ObjectStore, bot: string): Promise<StoredObject> {
  const object = await store.get(BOT_TYPE, bot);
  if (object === undefined) throw new BotError(`there is no bot "${bot}"`);
  if (object.data.removed === true) throw new BotError(`bot ${bot} is no longer in the settings`);
  return object;
}

/** Writes the bot's follow-ups, leaving the rest of the object as it is. */
export async function writeFollowUps(
  store: ObjectStore,
  object: StoredObject,
  entries: readonly FollowUp[],
  cause: string,
): Promise<void> {
  await store.put(BOT_TYPE, object.id, { ...object.data, followUps: entries as unknown as JsonValue[] }, cause);
}

/** The bot a chat belongs to, refusing a chat that is not a bot's (and, for a new follow-up, a closed one). */
async function botOfChat(store: ObjectStore, chatId: string, forNew: boolean): Promise<string> {
  const chat = await store.get(CHAT_TYPE, chatId);
  if (chat === undefined) throw new BotError(`there is no chat "${chatId}"`);
  const parent = chatData(chat.data).parent ?? "";
  if (!parent.startsWith(`${BOT_TYPE}:`)) throw new BotError(`chat ${chatId} is not a chat of a bot`);
  if (forNew && chatData(chat.data).closed) throw new BotError(`chat ${chatId} is closed`);
  return parent.slice(BOT_TYPE.length + 1);
}

/** Sets a follow-up in a chat; it takes effect at once. Returns the line to show. */
export async function setFollowUp(
  store: ObjectStore,
  chatId: string,
  when: string,
  sentence: string,
  now: number,
): Promise<string> {
  const text = sentence.replace(/\s+/g, " ").trim();
  if (text.length === 0) throw new BotError("a follow-up needs one sentence of what to do");
  if (text.length > FOLLOW_UP_TEXT_MAX) {
    throw new BotError(`a follow-up's sentence is at most ${FOLLOW_UP_TEXT_MAX} characters`);
  }
  const at = parseDue(when, now);
  if (at <= now) throw new BotError(`a follow-up's time ${localStamp(at)} is already past`);
  if (at > now + FOLLOW_UP_DAYS * DAY_MS) {
    throw new BotError(`a follow-up is at most ${FOLLOW_UP_DAYS} days ahead; ${localStamp(at)} is further`);
  }
  const bot = await botOfChat(store, chatId, true);
  const object = await botObject(store, bot);
  const entries = followUps(object.data);
  const pending = entries.filter((entry) => entry.chat === chatId && entry.at > now).length;
  if (pending >= FOLLOW_UP_PER_CHAT) {
    throw new BotError(`chat ${chatId} already has ${FOLLOW_UP_PER_CHAT} follow-ups not yet due, the most it may have`);
  }
  const entry: FollowUp = { id: newId(), chat: chatId, at, text, setAt: now };
  await writeFollowUps(store, object, [...entries, entry], "command:bot/follow-up");
  return `follow-up ${entry.id} set for ${localStamp(at)}`;
}

/** Removes one follow-up; false when there is none with that id. */
export async function removeFollowUp(
  store: ObjectStore,
  bot: string,
  id: string,
  cause = "action:bot/follow-up-cancel",
): Promise<boolean> {
  const object = await botObject(store, bot);
  const entries = followUps(object.data);
  const rest = entries.filter((entry) => entry.id !== id);
  if (rest.length === entries.length) return false;
  await writeFollowUps(store, object, rest, cause);
  return true;
}

const FOLLOW_UP_USAGE = "usage: operad bot follow-up <chat> --at <time> --do <one sentence>";
const FOLLOW_UPS_USAGE = "usage: operad bot follow-ups <chat> [--cancel <id>]";

function options(
  argv: readonly string[],
  names: readonly string[],
  usage: string,
): { readonly positional: readonly string[]; readonly given: Readonly<Record<string, string>> } {
  const positional: string[] = [];
  const given: Record<string, string> = {};
  for (let at = 0; at < argv.length; at += 1) {
    const word = argv[at];
    if (word === undefined) continue;
    if (word.startsWith("--")) {
      const name = word.slice(2);
      if (!names.includes(name)) throw new BotError(`there is no option ${word}; ${usage}`);
      const value = argv[at + 1];
      if (value === undefined) throw new BotError(`${word} needs a value; ${usage}`);
      given[name] = value;
      at += 1;
      continue;
    }
    positional.push(word);
  }
  return { positional, given };
}

/** `bot follow-up`: what the chat's agent calls to set a follow-up. */
export async function runFollowUpCommand(ctx: CommandContext, argv: readonly string[]): Promise<string> {
  const { positional, given } = options(argv, ["at", "do"], FOLLOW_UP_USAGE);
  const chat = positional[0];
  const at = given.at;
  const what = given.do;
  if (chat === undefined || positional.length > 1 || at === undefined || what === undefined) {
    throw new BotError(FOLLOW_UP_USAGE);
  }
  return setFollowUp(ctx.store, chat, at, what, Date.now());
}

/** `bot follow-ups`: lists the chat's follow-ups, or cancels one with `--cancel <id>`. */
export async function runFollowUpsCommand(ctx: CommandContext, argv: readonly string[]): Promise<string> {
  const { positional, given } = options(argv, ["cancel"], FOLLOW_UPS_USAGE);
  const chat = positional[0];
  if (chat === undefined || positional.length > 1) throw new BotError(FOLLOW_UPS_USAGE);
  const bot = await botOfChat(ctx.store, chat, false);
  const own = followUps((await botObject(ctx.store, bot)).data).filter((entry) => entry.chat === chat);
  const cancel = given.cancel;
  if (cancel !== undefined) {
    if (!own.some((entry) => entry.id === cancel) || !(await removeFollowUp(ctx.store, bot, cancel))) {
      throw new BotError(`chat ${chat} has no follow-up "${cancel}"`);
    }
    return `canceled follow-up ${cancel}`;
  }
  if (own.length === 0) return "no follow-ups";
  return [...own]
    .sort((a, b) => a.at - b.at)
    .map((entry) => `${entry.id}: ${localStamp(entry.at)}: ${entry.text}`)
    .join("\n");
}

/** The action a person uses to cancel a follow-up. */
export const followUpActions: readonly ActionTypeDefinition[] = [
  {
    name: "follow-up-cancel",
    on: BOT_TYPE,
    args: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, description: "The follow-up's id, from the bot's `data.followUps`." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    when: (state) => state.removed !== true,
    why: (object) =>
      object.data.removed === true ? `bot ${object.id} is no longer in the settings` : undefined,
    async run(ctx, args) {
      const id = (args as { readonly id: string }).id;
      if (!(await removeFollowUp(ctx.store, ctx.object.id, id))) {
        throw new BotError(`bot ${ctx.object.id} has no follow-up "${id}"`);
      }
      return `canceled follow-up ${id}`;
    },
  },
];
