/**
 * How a routine shows and what a person does with it (ADR 0030 D10): a row with
 * its name, its bot, the next run and the last result; a page with the prompt,
 * the schedule and its runs as history, each run with its process and result;
 * and the actions that edit, pause, resume, run now and remove it.
 *
 * The nightly memory tidy is a built-in routine shown as Dreaming; the tidy
 * source keeps its routine object in step (see `syncDreaming`).
 */

import { CHAT_TYPE, TRANSCRIPT, chatData, chatViews } from "@operad-io/chat";
import type {
  ActionArgsSchema,
  ActionTypeDefinition,
  ClientApi,
  JsonValue,
  ObjectRow,
  ObjectStore,
  ObjectViews,
  SectionContent,
  StoredObject,
  ViewSection,
} from "@operad-io/engine";
import { BOT_TYPE } from "./bot.ts";
import {
  ROUTINE_TYPE,
  SCHEDULE_QUIET_RESULT,
  SCHEDULE_SOURCE,
  checkPromptName,
  editRoutine,
  localStamp,
  markdownCode,
  markdownText,
  nextRun,
  pauseRoutine,
  removeRoutine,
  resumeRoutine,
  runRoutineNow,
  scheduledPromptOf,
  type EditInput,
  type RoutineRun,
  type ScheduledPrompt,
} from "./schedule.ts";

/** What the built-in memory tidy is called. */
export const DREAMING_NAME = "Dreaming";

/** The `builtin` value of the routine the nightly memory tidy keeps. */
export const DREAMING_BUILTIN = "tidy";

/** The object id of one bot's Dreaming routine. */
export function dreamingId(bot: string): string {
  return `dreaming-${bot}`;
}

/** How the routine list is filtered: a removed routine is in its own filter. */
export const ROUTINE_FILTERS = [
  { name: "open", states: ["open", "paused"], default: true },
  { name: "removed", states: ["removed"] },
] as const;

/** The last result a row shows. */
export type RoutineResult = "done" | "nothing to report" | "failed";

/** How the last run of a routine ended; null before the first run and while one is running. */
export function lastResultOf(entry: ScheduledPrompt): RoutineResult | null {
  const latest = (entry.runs ?? []).at(-1);
  if (latest !== undefined) {
    if (latest.status === "running") return null;
    return latest.status === "quiet" ? "nothing to report" : latest.status;
  }
  const last = entry.last;
  if (last?.result === undefined) return null;
  if (last.failed === true) return "failed";
  return last.result === SCHEDULE_QUIET_RESULT ? "nothing to report" : "done";
}

/** The server's IANA time zone, the one cron expressions run in. */
function zone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function routineRow(object: StoredObject): ObjectRow {
  const entry = scheduledPromptOf(object.data);
  const bot = typeof object.data.bot === "string" ? object.data.bot : "";
  const builtin = typeof object.data.builtin === "string";
  if (entry === undefined) {
    return { id: object.id, title: "Routine", state: "broken", ...(bot === "" ? {} : { parent: `${BOT_TYPE}:${bot}` }) };
  }
  const now = Date.now();
  const next = nextRun(entry, now);
  const removed = object.data.removed === true;
  const result = lastResultOf(entry);
  const data: Record<string, JsonValue> = {
    bot,
    schedule: entry.schedule,
    nextRun: next === null || removed ? null : new Date(next).toISOString(),
    lastResult: result,
    lastSummary: entry.last?.result ?? null,
    paused: entry.paused,
    builtin,
    timeZone: zone(),
    ...(builtin ? {} : { prompt: entry.prompt, model: entry.model ?? null, effort: entry.effort ?? null }),
  };
  return {
    id: object.id,
    title: entry.name,
    state: removed ? "removed" : entry.paused ? "paused" : "open",
    ...(removed ? { final: true } : {}),
    note: bot,
    parent: `${BOT_TYPE}:${bot}`,
    ...(typeof object.data.state === "string" && object.data.state === "pending" ? { waiting: true as const } : {}),
    data,
  };
}

/** How many runs a routine's page lists as sections. */
const RUN_SECTIONS = 30;

function runTitle(run: RoutineRun): string {
  const how = run.status === "quiet" ? "nothing to report" : run.status;
  return `${localStamp(run.at)} · ${how}${run.manual === true ? " · run now" : ""}`;
}

function routineSections(object: StoredObject): readonly ViewSection[] {
  const entry = scheduledPromptOf(object.data);
  const runs = [...(entry?.runs ?? [])].reverse().slice(0, RUN_SECTIONS);
  return [
    { id: "routine", title: "Routine" },
    ...runs.map((run) => ({ id: `run-${run.id}`, title: runTitle(run), ...(run.status === "running" ? { live: true } : {}) })),
  ];
}

/** The lines a bot page shows for its routines. */
export function routineMarkdown(entries: readonly ScheduledPrompt[], now: number): string[] {
  if (entries.length === 0) return ["Routines: none."];
  const lines = ["Routines:"];
  for (const entry of entries) {
    const next = nextRun(entry, now);
    const state = entry.paused ? " (paused)" : next === null ? "" : `, next ${localStamp(next)}`;
    const result = lastResultOf(entry);
    const ended =
      entry.last?.result === undefined
        ? ""
        : `; last ${result ?? "done"}: ${markdownText(entry.last.result)}`;
    lines.push(`- ${markdownText(entry.name)} (${markdownCode(entry.schedule)}${state})${ended}`);
  }
  return lines;
}

function pageMarkdown(object: StoredObject): string {
  const entry = scheduledPromptOf(object.data);
  const bot = typeof object.data.bot === "string" ? object.data.bot : "";
  if (entry === undefined) return "This routine has no usable data.";
  const now = Date.now();
  const next = nextRun(entry, now);
  const lines = [`**${markdownText(entry.name)}** · bot ${markdownText(bot)}`];
  if (object.data.removed === true) lines.push("Removed.");
  if (typeof object.data.builtin === "string") {
    lines.push(
      `Tidies this bot's memory every night at ${entry.schedule.split(" ").slice(0, 2).reverse().map((part) => part.padStart(2, "0")).join(":")}. It first shows a pending card and waits for Run or Skip, unless the bot's settings say to run without asking.`,
    );
  } else {
    lines.push(`Prompt: ${markdownText(entry.prompt)}`);
  }
  lines.push(
    `Schedule: ${markdownCode(entry.schedule)} (${zone()})${entry.paused ? ", paused" : next === null ? "" : `, next run ${localStamp(next)}`}`,
  );
  const result = lastResultOf(entry);
  if (result !== null) lines.push(`Last result: ${result}${entry.last?.result === undefined ? "" : ` — ${markdownText(entry.last.result)}`}`);
  const runs = entry.runs ?? [];
  lines.push(runs.length === 0 ? "No runs yet." : `Runs in the last 30 days: ${runs.length}. Each one is a section of this page.`);
  return lines.join("\n\n");
}

async function routineLoad(
  ctx: Parameters<ObjectViews["load"]>[0],
  object: StoredObject,
  sectionId: string,
  options: Parameters<ObjectViews["load"]>[3],
): Promise<SectionContent> {
  if (sectionId === "routine") return { markdown: pageMarkdown(object) };
  if (!sectionId.startsWith("run-")) return { markdown: "" };
  const runId = sectionId.slice("run-".length);
  const entry = scheduledPromptOf(object.data);
  const run = entry?.runs?.find((item) => item.id === runId);
  if (run === undefined) return { markdown: "This run is no longer in the history." };
  // The run's process and reply are in its record; the transcript renders them.
  const record = await ctx.store.get(CHAT_TYPE, runId);
  if (record !== undefined && chatData(record.data).run === true) {
    return chatViews.load(ctx, record, TRANSCRIPT, options);
  }
  return { markdown: `${runTitle(run)}${run.result === undefined ? "" : `\n\n${markdownText(run.result)}`}` };
}

/** How a routine shows in a list and on its page. */
export const routineViews: ObjectViews = {
  row: routineRow,
  sections: routineSections,
  load: routineLoad,
};

function botOf(object: { readonly data: Readonly<Record<string, unknown>> }): string {
  return typeof object.data.bot === "string" ? object.data.bot : "";
}

function nameOf(object: { readonly data: Readonly<Record<string, unknown>> }): string {
  return checkPromptName(typeof object.data.name === "string" ? object.data.name : "");
}

const editable = (state: Readonly<Record<string, unknown>>): boolean =>
  state.removed !== true && state.builtin === undefined;

const editableWhy = (object: StoredObject): string | undefined =>
  object.data.removed === true
    ? `routine ${object.id} is removed`
    : object.data.builtin !== undefined
      ? `${DREAMING_NAME} is built in; it is changed in the bot's settings`
      : undefined;

const editArgs: ActionArgsSchema = {
  type: "object",
  properties: {
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
    model: { type: "string", description: "The model a run uses; an empty value clears it." },
    effort: { type: "string", description: "The effort a run uses; an empty value clears it." },
  },
  additionalProperties: false,
};

/** The actions on a routine's own page. */
export const routineActions: readonly ActionTypeDefinition[] = [
  {
    name: "edit",
    on: ROUTINE_TYPE,
    args: editArgs,
    when: editable,
    why: editableWhy,
    run: async (ctx, args) => editRoutine(ctx.store, botOf(ctx.object), nameOf(ctx.object), args as unknown as EditInput),
  },
  {
    name: "pause",
    on: ROUTINE_TYPE,
    when: (state) => editable(state) && state.paused !== true,
    why: editableWhy,
    run: async (ctx) => pauseRoutine(ctx.store, botOf(ctx.object), nameOf(ctx.object)),
  },
  {
    name: "resume",
    on: ROUTINE_TYPE,
    when: (state) => editable(state) && state.paused === true,
    why: editableWhy,
    run: async (ctx) => resumeRoutine(ctx.store, botOf(ctx.object), nameOf(ctx.object)),
  },
  {
    name: "run-now",
    on: ROUTINE_TYPE,
    when: editable,
    why: editableWhy,
    run: async (ctx) => runRoutineNow(ctx.store, botOf(ctx.object), nameOf(ctx.object)),
  },
  {
    name: "remove",
    on: ROUTINE_TYPE,
    confirm: true,
    when: editable,
    why: editableWhy,
    run: async (ctx) => removeRoutine(ctx.store, botOf(ctx.object), nameOf(ctx.object)),
  },
];

/**
 * Closes, once, the chats that scheduled prompts and memory tidies opened
 * before runs stopped being chats (ADR 0030 D10). A run has an `R-` id and is
 * never closed here; a chat already closed is left alone.
 */
export async function closeOldScheduledChats(store: ObjectStore, client: ClientApi): Promise<number> {
  let closed = 0;
  let cursor: string | undefined;
  do {
    const page = await store.list(CHAT_TYPE, { ...(cursor === undefined ? {} : { cursor }) });
    for (const object of page.objects) {
      const chat = chatData(object.data);
      if (chat.scheduled === undefined || chat.run === true || chat.closed) continue;
      await client.act("chat:close", `${CHAT_TYPE}:${object.id}`, {
        actor: { via: SCHEDULE_SOURCE, id: "routines" },
        yes: true,
      });
      closed += 1;
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return closed;
}
