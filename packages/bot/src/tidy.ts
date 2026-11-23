/**
 * A bot's nightly memory tidy: the check that costs no model call, the pending
 * card with Run and Skip, the automatic run, and the one commit the run leaves.
 * The memory plugin owns what changed and the rewrite guard; this module owns
 * when the botanist wakes and what a person sees.
 */

import { messageOf, type SourceContext } from "@operad-io/engine";
import { join, resolve } from "node:path";
import {
  CHAT_TYPE,
  allEntries,
  allMessages,
  chatData,
  lastReplyOutcome,
  stoppedRunAfter,
  chatFacts,
  costText,
  writingReplyNow,
} from "@operad-io/chat";
import {
  cut,
  isRecord,
  type ActionTypeDefinition,
  type ClientApi,
  type HarnessCapabilities,
  type JsonValue,
  type ObjectRow,
  type ObjectStore,
  type ObjectViews,
  type RunControl,
  type SectionContent,
  type StoredObject,
} from "@operad-io/engine";
import {
  EMPTY_LINK_REPORT,
  TIDY_COMMIT_FACT,
  TIDY_ORIGIN,
  ensureMemoryLayout,
  ensureRepository,
  linkReport,
  lockInstructions,
  memoryEnabled,
  memoryTidyState,
  openMemorySearch,
  tidyCommitForChat,
  tidyCommitSummary,
  unlockInstructions,
  wikiDirectoryOfHome,
  type LinkReport,
} from "@operad-io/memory";
import {
  BOT_TYPE,
  BotError,
  ensureBotMemory,
  readBots,
  workingDirectory,
  type BotSettings,
} from "./bot.ts";
import { ChatWatches } from "./chat-watch.ts";
import {
  ROUTINE_TYPE,
  SCHEDULE_SOURCE,
  localDate,
  mainChatDelivery,
  replySummary,
  scheduledPromptOf,
  withRun,
  droppedRuns,
  forgetRuns,
  type RoutineRun,
  type ScheduleNotice,
} from "./schedule.ts";
import { DREAMING_BUILTIN, DREAMING_NAME, dreamingId } from "./routine.ts";

/** The internal object type of one bot's tidy state and card. */
export const TIDY_TYPE = "bot-tidy";

/** The default time the nightly check runs, in local time. */
export const DEFAULT_TIDY_TIME = "03:30";

/** The longest an automatic tidy's notice is. */
const NOTICE_MAX = 300;

export type TidyState =
  | "idle"
  | "pending"
  | "requested"
  | "running"
  | "result"
  | "failed"
  | "skipped";

/** How much work the last check found. */
export interface TidyCounts {
  readonly notes: number;
  readonly chats: number;
  readonly indexOver: boolean;
}

/** What a finished tidy did and cost. */
export interface TidyOutcome {
  readonly chatId: string;
  readonly at: number;
  readonly costMicros: number | null;
  readonly changed: boolean;
  readonly voided: boolean;
  /** The run's diff-stat line from the last tidy commit, or why the run failed. */
  readonly summary: string;
  /** The agent's own one-line reply, when it gave one. */
  readonly reply: string;
}

/** The state stored on one bot's tidy object. */
export interface TidyData {
  readonly [key: string]: unknown;
  readonly bot: string;
  readonly state: TidyState;
  /** The latest planned check already handled. */
  readonly plannedAt: number;
  readonly checkedAt?: number;
  readonly counts: TidyCounts;
  readonly requestedAt?: number | undefined;
  readonly chatId?: string | undefined;
  readonly auto?: boolean | undefined;
  readonly outcome?: TidyOutcome | undefined;
  readonly lastOutcome?: TidyOutcome | undefined;
}

/** A note whose text the tidy sees. */
export interface TidyNote {
  readonly path: string;
  readonly content: string;
  /** The local date the note was last changed, `YYYY-MM-DD`. */
  readonly date: string;
}

/** One chat in the period the tidy checks. */
export interface TidyChat {
  readonly id: string;
  readonly title: string;
  readonly messages: readonly {
    readonly role: string;
    readonly text: string;
    readonly at: number;
  }[];
}

/** The link lists for the shared wiki and this bot's memory. */
export interface TidyLinks {
  readonly wiki: LinkReport;
  readonly memory: LinkReport;
}

/** What the check found: the work the card counts and the run reads. */
export interface TidyWork {
  readonly notes: readonly TidyNote[];
  readonly chats: readonly TidyChat[];
  readonly links: TidyLinks;
  readonly indexOver: boolean;
  readonly indexBytes: number;
  readonly baseline: string | undefined;
  /** The local date of this tidy, `YYYY-MM-DD`. */
  readonly today: string;
}

function integer(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function countsOf(value: unknown): TidyCounts {
  if (!isRecord(value)) return { notes: 0, chats: 0, indexOver: false };
  return {
    notes: integer(value.notes),
    chats: integer(value.chats),
    indexOver: value.indexOver === true,
  };
}

function outcomeOf(value: unknown): TidyOutcome | undefined {
  if (!isRecord(value) || typeof value.chatId !== "string" || typeof value.summary !== "string") {
    return undefined;
  }
  return {
    chatId: value.chatId,
    at: integer(value.at),
    costMicros:
      typeof value.costMicros === "number" && Number.isFinite(value.costMicros)
        ? value.costMicros
        : null,
    changed: value.changed === true,
    voided: value.voided === true,
    summary: value.summary,
    reply: typeof value.reply === "string" ? value.reply : "",
  };
}

const STATES: ReadonlySet<string> = new Set([
  "idle",
  "pending",
  "requested",
  "running",
  "result",
  "failed",
  "skipped",
]);

/** Reads a tidy object, or undefined when its state is unusable. */
export function tidyDataOf(value: Readonly<Record<string, unknown>>): TidyData | undefined {
  if (typeof value.bot !== "string" || !STATES.has(String(value.state))) return undefined;
  const outcome = outcomeOf(value.outcome);
  const last = outcomeOf(value.lastOutcome);
  return {
    bot: value.bot,
    state: value.state as TidyState,
    plannedAt: integer(value.plannedAt),
    ...(typeof value.checkedAt === "number" ? { checkedAt: value.checkedAt } : {}),
    counts: countsOf(value.counts),
    ...(typeof value.requestedAt === "number" ? { requestedAt: value.requestedAt } : {}),
    ...(typeof value.chatId === "string" ? { chatId: value.chatId } : {}),
    ...(value.auto === true ? { auto: true } : {}),
    ...(outcome === undefined ? {} : { outcome }),
    ...(last === undefined ? {} : { lastOutcome: last }),
  };
}

/** The tidy time a bot names, as hour and minute; the default is between 3 and 4. */
export function tidyClock(settings: BotSettings): { readonly hour: number; readonly minute: number } {
  const written = typeof settings.tidyTime === "string" ? settings.tidyTime : DEFAULT_TIDY_TIME;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(written);
  if (match === null) return { hour: 3, minute: 30 };
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** The latest planned check at or before now, in the machine's local time zone. */
export function latestTidyMinute(settings: BotSettings, now: number): number {
  const { hour, minute } = tidyClock(settings);
  const date = new Date(now);
  const today = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    hour,
    minute,
    0,
    0,
  ).getTime();
  if (today <= now) return today;
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() - 1,
    hour,
    minute,
    0,
    0,
  ).getTime();
}

async function listAll(store: ObjectStore, type: string): Promise<readonly StoredObject[]> {
  const found: StoredObject[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list(type, { ...(cursor === undefined ? {} : { cursor }) });
    found.push(...page.objects);
    cursor = page.next;
  } while (cursor !== undefined);
  return found;
}

/** The chats of one bot whose messages fall in the tidy period. */
async function chatsToCheck(
  store: ObjectStore,
  bot: string,
  since: number | undefined,
): Promise<readonly TidyChat[]> {
  const found: TidyChat[] = [];
  for (const object of await listAll(store, CHAT_TYPE)) {
    const chat = chatData(object.data);
    if (chat.parent !== `${BOT_TYPE}:${bot}`) continue;
    if (chat.scheduled?.entry === TIDY_ORIGIN) continue;
    const messages = allMessages(store, object.id)
      // A message of a stretch that is not remembered never reaches Dreaming.
      .filter((message) => message.private !== true && (since === undefined || message.at >= since))
      .map((message) => ({
        role: message.role,
        text: cut(message.text, 1_500),
        at: message.at,
      }));
    if (messages.length === 0) continue;
    found.push({ id: object.id, title: chat.title, messages });
  }
  return found.sort((left, right) => left.id.localeCompare(right.id));
}

function emptyTidyLinks(): TidyLinks {
  return { wiki: EMPTY_LINK_REPORT, memory: EMPTY_LINK_REPORT };
}

/** The link table's lists for the wiki and this bot's memory; never blocks the check. */
async function linkLists(
  store: ObjectStore,
  cwd: string,
  home: string | undefined,
): Promise<TidyLinks> {
  if (home === undefined) return emptyTidyLinks();
  const settings = { wikiDir: wikiDirectoryOfHome(home) };
  try {
    const search = openMemorySearch(home, settings);
    try {
      await search.refresh(store);
      return {
        wiki: linkReport(search, { scope: "wiki" }),
        memory: linkReport(search, { scope: "memory", owner: resolve(cwd) }),
      };
    } finally {
      search.close();
    }
  } catch {
    return emptyTidyLinks();
  }
}

/** The work one bot's memory has for a tidy now. */
export async function tidyWork(
  store: ObjectStore,
  bot: string,
  cwd: string,
  options: { readonly home?: string | undefined; readonly now?: number | undefined } = {},
): Promise<TidyWork> {
  const now = options.now ?? Date.now();
  const memoryDir = join(cwd, "memory");
  ensureMemoryLayout(memoryDir);
  const memory = memoryTidyState(memoryDir, bot);
  const notes: TidyNote[] = [];
  for (const path of memory.notes) {
    try {
      const file = Bun.file(join(memoryDir, ...path.split("/")));
      notes.push({
        path,
        content: cut(await file.text(), 8_000),
        date: localDate(file.lastModified),
      });
    } catch {
      // A note that vanished between the check and this read is not work.
    }
  }
  return {
    notes,
    chats: await chatsToCheck(store, bot, memory.since),
    links: await linkLists(store, cwd, options.home),
    indexOver: memory.indexOver,
    indexBytes: memory.indexBytes,
    baseline: memory.baseline,
    today: localDate(now),
  };
}

/**
 * Whether any chat of this bot is writing a reply now. A latest run that the
 * host says has ended is not writing, even when a crash left no failure or
 * stopped entry for it; a host that cannot tell keeps the fact-only answer.
 */
export async function botChatReplying(
  store: ObjectStore,
  bot: string,
  runs?: RunControl,
): Promise<boolean> {
  for (const object of await listAll(store, CHAT_TYPE)) {
    const chat = chatData(object.data);
    if (chat.parent !== `${BOT_TYPE}:${bot}`) continue;
    const writing = await writingReplyNow(chatFacts(store, object.id), allMessages(store, object.id), allEntries(store, object.id), runs);
    if (writing !== undefined) return true;
  }
  return false;
}

/** The link lists for one scope, with no heading when every list is empty. */
function linkSection(title: string, report: LinkReport): string[] {
  const lines: string[] = [];
  if (report.broken.length > 0) {
    lines.push("", `Broken links (${report.broken.length}):`);
    for (const link of report.broken) {
      lines.push(`- ${link.path}:${link.line} -> ${link.target}`);
    }
  }
  if (report.orphans.length > 0) {
    lines.push("", `Notes nothing links to (${report.orphans.length}):`);
    for (const path of report.orphans) lines.push(`- ${path}`);
  }
  if (report.wanted.length > 0) {
    lines.push("", `Targets several notes link to (${report.wanted.length}):`);
    for (const wanted of report.wanted) {
      lines.push(`- ${wanted.target} (linked from ${wanted.notes} notes)`);
    }
  }
  if (report.unlinked.length > 0) {
    lines.push("", `Mentions that are not links (${report.unlinked.length}):`);
    for (const mention of report.unlinked) {
      lines.push(`- ${mention.path} mentions "${mention.title}" (${mention.target})`);
    }
  }
  return lines.length === 0 ? [] : [`### ${title}`, ...lines];
}

/** The link guidance and lists, or nothing when there is no link work. */
function linkPrompt(links: TidyLinks): string[] {
  const wiki = linkSection("Wiki", links.wiki);
  const memory = linkSection("Bot memory", links.memory);
  if (wiki.length === 0 && memory.length === 0) return [];
  return [
    "",
    "## Links to look after",
    "Fix a broken link when the right target is clear. Leave a link to a page nobody wrote yet. Consider linking an orphan from the index or a related note. Suggest, never force, turning a mention into a link. Never put an untrusted note into the index.",
    ...wiki,
    ...memory,
  ];
}

/** The prompt a tidy chat starts with. */
export function tidyPrompt(bot: string, work: TidyWork): string {
  const out = [
    `Tidy the memory of bot ${bot}.`,
    "",
    "This is the nightly memory tidy. Work only from the notes and chat records below.",
    "Fix notes that are wrong or out of date: the newer fact replaces the older one, and the old note stays where it is, marked as replaced; do not delete it.",
    `Keep memory/index.md under 8,000 characters by moving detail into topic notes. It is ${work.indexBytes} bytes now.`,
    `Today is ${work.today}. Each note below has the date it was last changed; read a time word in a note ("next week", "tomorrow", "this month") from that date, not from today.`,
    'Rewrite a sentence that is relative to a time that has passed as a plain dated fact, using the note\'s date: "Going to Singapore next week" in a note dated 2026-07-03 becomes "Went to Singapore in July 2026". Leave a sentence whose time has not passed. Never guess a date the note does not give.',
    'A fact that holds only for a while carries the date it stops holding, as "until YYYY-MM-DD"; once that date is before today, say it no longer holds. A newer fact supersedes an older one: keep the older text, marked as replaced with the date, and write the newer fact beside it; never delete it.',
    "Check only the period since the last tidy. Do not change instructions.md. End with a short summary of what changed.",
    "",
    `## Notes added or changed since the last tidy (${work.notes.length})`,
  ];
  if (work.notes.length === 0) out.push("None.");
  for (const note of work.notes) {
    out.push("", `### ${note.path} (changed ${note.date})`, "```markdown", note.content, "```");
  }
  out.push("", `## Chats in the period (${work.chats.length})`);
  if (work.chats.length === 0) out.push("None.");
  for (const chat of work.chats) {
    out.push("", `### Chat ${chat.id}: ${chat.title}`);
    for (const message of chat.messages) {
      out.push(`${message.role}: ${message.text}`);
    }
  }
  out.push(...linkPrompt(work.links));
  return out.join("\n");
}

function costPart(outcome: TidyOutcome): string {
  return outcome.costMicros === null
    ? "cost unknown"
    : `cost ${costText(outcome.costMicros, undefined)}`;
}

/** The one line a tidy sends through the notify command. */
export function tidyOutcomeLine(bot: string, outcome: TidyOutcome): string {
  const changed = outcome.changed
    ? outcome.summary
    : outcome.summary === "No file statistics." || /^no memory change\.?$/i.test(outcome.summary)
      ? "no memory change"
      : outcome.summary;
  const voided = outcome.voided ? "; only additions were kept" : "";
  return `${bot}: ${changed}; ${costPart(outcome)}${voided}`;
}

/** What a person reads on a bot's tidy card. */
export function tidyCardPrompt(data: TidyData): string {
  if (data.state === "pending" || data.state === "requested") {
    const lines = [
      `Dreaming for bot ${data.bot}: ${data.counts.notes} new or changed note${data.counts.notes === 1 ? "" : "s"}, ${data.counts.chats} chat${data.counts.chats === 1 ? "" : "s"} to check.`,
      data.counts.indexOver ? "The memory index is over its limit." : "The memory index is within its limit.",
    ];
    if (data.state === "requested") lines.push("It runs as soon as no chat of this bot is replying.");
    return lines.join(" ");
  }
  if (data.state === "running") {
    return `Dreaming for bot ${data.bot} is running.`;
  }
  const outcome = data.outcome ?? data.lastOutcome;
  if (data.state === "failed") {
    const reason = outcome === undefined ? "no reason was recorded" : outcome.summary;
    return `Dreaming for bot ${data.bot} failed: ${reason.replace(/\.$/, "")}.`;
  }
  if (outcome === undefined) return `Dreaming for bot ${data.bot}: nothing to show.`;
  return `Dreaming for bot ${data.bot} finished. ${tidyOutcomeLine(data.bot, outcome)}.${outcome.reply.length === 0 ? "" : ` Reply: ${outcome.reply}`}`;
}

/** The actions a tidy card offers: Run and Skip. */
export const tidyActions: readonly ActionTypeDefinition[] = [
  {
    name: "run",
    on: TIDY_TYPE,
    when: (state) => state.state === "pending" || state.state === "failed",
    async run(ctx) {
      const data = tidyDataOf(ctx.object.data);
      if (data === undefined) throw new BotError("this tidy card has no usable state");
      const next = { ...data, state: "requested", requestedAt: Date.now(), outcome: undefined } as TidyData;
      await ctx.store.put(TIDY_TYPE, data.bot, next as unknown as Record<string, JsonValue>, "action:bot/run");
      await syncDreaming(ctx.store, next, Date.now());
      return `Dreaming for bot ${data.bot} will run when no chat of the bot is replying`;
    },
  },
  {
    name: "skip",
    on: TIDY_TYPE,
    when: (state) => state.state === "pending" || state.state === "failed",
    async run(ctx) {
      const data = tidyDataOf(ctx.object.data);
      if (data === undefined) throw new BotError("this tidy card has no usable state");
      const next = { ...data, state: "skipped", requestedAt: undefined } as TidyData;
      await ctx.store.put(TIDY_TYPE, data.bot, next as unknown as Record<string, JsonValue>, "action:bot/skip");
      await syncDreaming(ctx.store, next, Date.now());
      return `skipped Dreaming for bot ${data.bot} until the next check finds work`;
    },
  },
];

/**
 * Keeps the Dreaming routine of a bot in step with its tidy state: the routine
 * object is what the list of routines shows. A run is added or updated by id;
 * the history keeps 30 days.
 */
export async function syncDreaming(
  store: ObjectStore,
  tidy: TidyData,
  now: number,
  options: { readonly schedule?: string | undefined; readonly run?: RoutineRun | undefined } = {},
): Promise<void> {
  const id = dreamingId(tidy.bot);
  const current = await store.get(ROUTINE_TYPE, id);
  const entry = scheduledPromptOf(current?.data);
  const schedule = options.schedule ?? entry?.schedule ?? "30 3 * * *";
  const started = options.run === undefined ? undefined : entry?.runs?.find((item) => item.id === options.run?.id)?.at;
  const run = options.run === undefined ? undefined : { ...options.run, at: started ?? options.run.at };
  const runs = run === undefined ? entry?.runs : withRun(entry?.runs, run, now);
  const outcome = tidy.outcome ?? tidy.lastOutcome;
  const data: Record<string, JsonValue> = {
    bot: tidy.bot,
    name: DREAMING_NAME,
    builtin: DREAMING_BUILTIN,
    schedule,
    prompt: "Tidy this bot's memory.",
    paused: false,
    state: tidy.state,
    ...(outcome === undefined
      ? {}
      : { last: { plannedAt: tidy.plannedAt, schedule, result: outcomeSummary(outcome), ...(tidy.state === "failed" ? { failed: true } : {}) } as unknown as JsonValue }),
    ...(runs === undefined || runs.length === 0 ? {} : { runs: runs as unknown as JsonValue }),
  };
  if (current === undefined || JSON.stringify(current.data) !== JSON.stringify(data)) {
    await store.put(ROUTINE_TYPE, id, data, "source:bot/tidy");
  }
  if (run !== undefined) await forgetRuns(store, droppedRuns(entry?.runs, run, now));
}

/** The pending items the tidy cards make. */
export async function tidyItems(
  store: ObjectStore,
): Promise<
  readonly {
    readonly id: string;
    readonly prompt: string;
    readonly object: { readonly type: string; readonly id: string };
  }[]
> {
  const items = [];
  for (const object of await listAll(store, TIDY_TYPE)) {
    const data = tidyDataOf(object.data);
    if (data === undefined) continue;
    if (data.state !== "pending" && data.state !== "failed") continue;
    const bot = await store.get(BOT_TYPE, data.bot);
    if (bot === undefined || bot.data.removed === true) continue;
    items.push({
      id: object.id,
      prompt: tidyCardPrompt(data),
      object: { type: TIDY_TYPE, id: object.id },
    });
  }
  return items;
}

function tidyRow(object: StoredObject): ObjectRow {
  const data = tidyDataOf(object.data);
  if (data === undefined) {
    return { id: object.id, title: DREAMING_NAME, state: "broken", parent: `${BOT_TYPE}:${object.id}` };
  }
  return {
    id: object.id,
    title: `${DREAMING_NAME} for ${data.bot}`,
    state: data.state,
    parent: `${BOT_TYPE}:${data.bot}`,
    ...(data.state === "pending" || data.state === "failed"
      ? { waiting: true as const }
      : {}),
    ...(data.counts.notes === 0 && data.counts.chats === 0
      ? {}
      : { note: `${data.counts.notes} notes, ${data.counts.chats} chats` }),
  };
}

/** How a tidy card shows when it is read as an object. */
export const tidyViews: ObjectViews = {
  row: tidyRow,
  sections: () => [{ id: "tidy", title: DREAMING_NAME }],
  load: (_ctx, object): SectionContent => {
    const data = tidyDataOf(object.data);
    return {
      markdown: data === undefined ? "This tidy card has no usable state." : tidyCardPrompt(data),
    };
  },
};

export interface TidySourceContext {
  readonly store: ObjectStore;
  /** Tells whether the latest run of a chat is still running; absent when the host cannot tell. */
  readonly runs?: RunControl | undefined;
  readonly home: string;
  readonly settings: Readonly<Record<string, JsonValue>>;
  readonly clock: () => number;
  readonly logger: { write(text: string): Promise<string> };
  readonly client: ClientApi;
  /** What a delivery to the main chat needs to write; without it a result stays in the history. */
  readonly facts?: SourceContext["facts"] | undefined;
  readonly harnesses?: readonly string[] | undefined;
  readonly harnessCapabilities?: ((harness: string) => HarnessCapabilities | undefined) | undefined;
  /** How the check reads its work; a test replaces it to see whether it ran. */
  readonly work?: ((store: ObjectStore, bot: string, cwd: string) => Promise<TidyWork>) | undefined;
}

function backgroundModel(
  settings: BotSettings,
  ctx: TidySourceContext,
): string | undefined {
  if (typeof settings.backgroundModel === "string" && settings.backgroundModel.length > 0) {
    return settings.backgroundModel;
  }
  // The chat starts at "ask": the first agent that carries it, else the first loaded one.
  const harness = settings.harness ??
    ctx.harnesses?.find((name) => (ctx.harnessCapabilities?.(name)?.accessLevels ?? []).includes("ask")) ??
    ctx.harnesses?.[0];
  return harness === undefined ? undefined : ctx.harnessCapabilities?.(harness)?.backgroundModel;
}

function outcomeSummary(outcome: TidyOutcome): string {
  const line = `${outcome.summary}${outcome.voided ? "; only additions were kept" : ""}`;
  return line.length <= NOTICE_MAX ? line : `${line.slice(0, NOTICE_MAX - 1)}…`;
}

/** The bot's nightly tidy source. */
export class BotTidySource {
  private readonly ctx: TidySourceContext;
  private readonly notify: (notice: ScheduleNotice) => Promise<void>;
  private readonly chatWatches: ChatWatches;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private busy = false;
  private lastCheck: number | undefined;

  constructor(
    ctx: TidySourceContext,
    options: { readonly notify?: ((notice: ScheduleNotice) => Promise<void>) | undefined } = {},
  ) {
    this.ctx = ctx;
    this.notify = options.notify ?? mainChatDelivery(ctx);
    this.chatWatches = new ChatWatches(ctx.logger, ctx.store, ctx.runs);
  }

  /** Waits for the checks that are running now; a test calls this after a reply. */
  async settled(): Promise<void> {
    await this.chatWatches.settled();
  }

  private async put(bot: string, data: TidyData, cause: string, run?: RoutineRun): Promise<void> {
    await this.ctx.store.put(TIDY_TYPE, bot, data as unknown as Record<string, JsonValue>, cause);
    let schedule: string | undefined;
    try {
      const settings = readBots(this.ctx.home, this.ctx.settings)[bot];
      if (settings !== undefined) {
        const { hour, minute } = tidyClock(settings);
        schedule = `${minute} ${hour} * * *`;
      }
    } catch {
      // Without usable settings the routine keeps the schedule it has.
    }
    await syncDreaming(this.ctx.store, data, this.ctx.clock(), { ...(schedule === undefined ? {} : { schedule }), ...(run === undefined ? {} : { run }) });
  }

  private async bots(): Promise<readonly StoredObject[]> {
    return listAll(this.ctx.store, BOT_TYPE);
  }

  private async tidyObjects(): Promise<readonly StoredObject[]> {
    return listAll(this.ctx.store, TIDY_TYPE);
  }

  /** Creates the first baseline, then checks at the planned time and catches up once. */
  async poll(): Promise<void> {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      const now = this.ctx.clock();
      this.lastCheck = now;
      for (const object of await this.bots()) {
        if (object.data.removed === true) continue;
        await this.one(object, now);
      }
    } finally {
      this.busy = false;
    }
  }

  private async one(object: StoredObject, now: number): Promise<void> {
    const bot = object.id;
    let settings: BotSettings | undefined;
    try {
      settings = readBots(this.ctx.home, this.ctx.settings)[bot];
    } catch (error) {
      await this.chatWatches.log(`dreaming: ${messageOf(error)}`);
      return;
    }
    if (settings === undefined || !memoryEnabled(this.ctx.home)) return;
    let cwd: string;
    try {
      cwd = workingDirectory(this.ctx.home, bot, settings);
      ensureBotMemory(cwd, this.ctx.home);
    } catch (error) {
      await this.chatWatches.log(`dreaming ${bot}: ${messageOf(error)}`);
      return;
    }
    const stored = await this.ctx.store.get(TIDY_TYPE, bot);
    if (stored === undefined) {
      await this.put(
        bot,
        {
          bot,
          state: "idle",
          plannedAt: latestTidyMinute(settings, now),
          checkedAt: now,
          counts: { notes: 0, chats: 0, indexOver: false },
        },
        "source:bot/tidy",
      );
      return;
    }
    const data = tidyDataOf(stored.data);
    if (data === undefined) return;
    if (data.state === "running") return;
    if (data.state === "requested") {
      // Wait for the chats to finish before the check spawns git or reads notes.
      if (await botChatReplying(this.ctx.store, bot, this.ctx.runs)) return;
      const work = await this.workFor(bot, cwd);
      if (work.notes.length === 0 && !work.indexOver) {
        await this.put(
          bot,
          { ...data, state: "idle", counts: { notes: 0, chats: 0, indexOver: false } },
          "source:bot/tidy",
        );
        return;
      }
      await this.launch(bot, cwd, settings, data.plannedAt, work, false);
      return;
    }
    const latest = latestTidyMinute(settings, now);
    if (latest <= data.plannedAt) return;
    if (settings.runWithoutAsking === true) {
      // A reply is being written: try again on the next tick, without moving the
      // planned time past a night that has not run, and without checking its work.
      if (await botChatReplying(this.ctx.store, bot, this.ctx.runs)) return;
      const work = await this.workFor(bot, cwd);
      if (work.notes.length === 0 && !work.indexOver) {
        const keep = data.state === "result" || data.state === "failed" ? data.state : "idle";
        await this.put(
          bot,
          { ...data, state: keep, plannedAt: latest, checkedAt: now, counts: { notes: 0, chats: 0, indexOver: false } },
          "source:bot/tidy",
        );
        return;
      }
      await this.launch(bot, cwd, settings, latest, work, true);
      return;
    }
    const work = await this.workFor(bot, cwd);
    const counts: TidyCounts = {
      notes: work.notes.length,
      chats: work.chats.length,
      indexOver: work.indexOver,
    };
    if (work.notes.length === 0 && !work.indexOver) {
      const keep = data.state === "result" || data.state === "failed" ? data.state : "idle";
      await this.put(
        bot,
        { ...data, state: keep, plannedAt: latest, checkedAt: now, counts: { notes: 0, chats: 0, indexOver: false } },
        "source:bot/tidy",
      );
      return;
    }
    await this.put(
      bot,
      {
        ...data,
        state: "pending",
        plannedAt: latest,
        checkedAt: now,
        counts,
        auto: false,
        outcome: undefined,
      },
      "source:bot/tidy",
    );
  }

  private workFor(bot: string, cwd: string): Promise<TidyWork> {
    if (this.ctx.work !== undefined) return this.ctx.work(this.ctx.store, bot, cwd);
    return tidyWork(this.ctx.store, bot, cwd, { home: this.ctx.home, now: this.ctx.clock() });
  }

  /** A run that started but can no longer be watched is reported, not left running. */
  private async failStart(bot: string, data: TidyData, summary: string): Promise<void> {
    const now = this.ctx.clock();
    const outcome: TidyOutcome = {
      chatId: data.chatId ?? "",
      at: now,
      costMicros: null,
      changed: false,
      voided: false,
      summary: replySummary(summary),
      reply: "",
    };
    const auto = data.auto === true;
    await this.put(
      bot,
      {
        ...data,
        state: auto ? "idle" : "failed",
        ...(auto ? { outcome: undefined, lastOutcome: outcome } : { outcome }),
      },
      "source:bot/tidy",
      { id: data.chatId ?? `failed-${now}`, at: now, status: "failed", result: outcome.summary },
    );
    if (auto) {
      try {
        await this.notify({
          routineId: dreamingId(bot),
          runId: outcome.chatId,
          title: DREAMING_NAME,
          summary: tidyOutcomeLine(bot, outcome),
          text: tidyOutcomeLine(bot, outcome),
          failed: true,
          bot,
        });
      } catch (error) {
        await this.chatWatches.log(
          `dreaming of bot ${bot}: notify: ${messageOf(error)}`,
        );
      }
    }
  }

  private async launch(
    bot: string,
    cwd: string,
    settings: BotSettings,
    plannedAt: number,
    work: TidyWork,
    auto: boolean,
  ): Promise<void> {
    const now = this.ctx.clock();
    const counts: TidyCounts = {
      notes: work.notes.length,
      chats: work.chats.length,
      indexOver: work.indexOver,
    };
    const running: TidyData = {
      bot,
      state: "running",
      plannedAt,
      checkedAt: now,
      counts,
      auto,
    };
    await this.put(bot, running, "source:bot/tidy");
    const model = backgroundModel(settings, this.ctx);
    let chatId: string | undefined;
    // The tidy never changes the person's instructions: read-only until the run's commit.
    lockInstructions(join(cwd, "memory"));
    try {
      const run = await this.ctx.client.act("bot:chat", `${BOT_TYPE}:${bot}`, {
        args: {
          title: `${DREAMING_NAME} (${localDate(now)})`.slice(0, 120),
          message: tidyPrompt(bot, work),
          ...(model === undefined ? {} : { model }),
        },
        actor: { via: SCHEDULE_SOURCE, id: TIDY_ORIGIN },
      });
      chatId = run.opens?.startsWith(`${CHAT_TYPE}:`) === true
        ? run.opens.slice(CHAT_TYPE.length + 1)
        : undefined;
    } catch (error) {
      unlockInstructions(join(cwd, "memory"));
      const message = messageOf(error);
      await this.failStart(bot, running, `Could not start: ${message}`);
      await this.chatWatches.log(`dreaming of bot ${bot} could not start: ${message}`);
      return;
    }
    if (chatId === undefined) {
      unlockInstructions(join(cwd, "memory"));
      await this.failStart(bot, running, "Could not start: it started no run");
      await this.chatWatches.log(`dreaming of bot ${bot} started no run`);
      return;
    }
    await this.put(bot, { ...running, chatId }, "source:bot/tidy", { id: chatId, at: now, status: "running" });
    await this.watch(bot, chatId, auto, join(cwd, "memory"));
  }

  private async watch(bot: string, chatId: string, auto: boolean, memoryDir: string): Promise<void> {
    this.chatWatches.watchChatReply(
      chatId,
      chatId,
      async (read) => {
        const committed = read.facts.some(
          (fact) =>
            fact.type === TIDY_COMMIT_FACT &&
            isRecord(fact.data) &&
            fact.data["chat"] === chatId,
        );
        if (!committed) {
          // A run that ended (cancelled, failed or quiet) without its commit
          // still gives the instructions back; the commit, if it comes, restores them.
          const outcome = lastReplyOutcome(read.messages, read.entries);
          const cancelled = stoppedRunAfter(read.facts, -1) !== undefined || outcome.kind === "stopped";
          if (cancelled || outcome.kind !== "none") unlockInstructions(memoryDir);
          // A cancelled or failed run makes no commit: its card ends here, not never.
          if (!cancelled && outcome.kind !== "failed") return undefined;
          const stored = await this.ctx.store.get(CHAT_TYPE, chatId);
          if (stored === undefined) return undefined;
          const failure = [...read.entries].reverse().find((item) => item.kind === "failure");
          const reply = [...read.messages].reverse().find((message) => message.role === "assistant");
          return {
            stored,
            replyText: reply?.text,
            failureText: failure?.text ?? "The run was cancelled before it changed the memory.",
          };
        }
        const stored = await this.ctx.store.get(CHAT_TYPE, chatId);
        if (stored === undefined) return undefined;
        const reply = [...read.messages].reverse().find((message) => message.role === "assistant");
        const failure = [...read.entries].reverse().find((item) => item.kind === "failure");
        if (reply === undefined && failure === undefined) return undefined;
        return { stored, replyText: reply?.text, failureText: failure?.text };
      },
      async ({ stored, replyText, failureText }) => {
        await this.finish(bot, chatId, stored, auto, replyText, failureText);
      },
    );
  }

  private async finish(
    bot: string,
    chatId: string,
    stored: StoredObject,
    auto: boolean,
    replyText: string | undefined,
    failureText: string | undefined,
  ): Promise<void> {
    const now = this.ctx.clock();
    const chat = chatData(stored.data);
    const memoryDir = join(chat.cwd, "memory");
    ensureMemoryLayout(memoryDir);
    const repository = ensureRepository(memoryDir);
    const commit = tidyCommitForChat(repository, memoryDir, chatId);
    const summary =
      commit === undefined
        ? undefined
        : tidyCommitSummary(repository, commit, { directory: memoryDir, bot });
    const costMicros =
      typeof stored.data.costMicros === "number" && Number.isFinite(stored.data.costMicros)
        ? stored.data.costMicros
        : null;
    const outcome: TidyOutcome = {
      chatId,
      at: now,
      costMicros,
      changed: summary?.changed === true,
      voided: summary?.voided === true,
      summary:
        failureText === undefined
          ? summary?.summary ?? "No memory change."
          : replySummary(failureText),
      reply: replyText === undefined ? "" : replySummary(replyText),
    };
    const run: RoutineRun = {
      id: chatId,
      at: now,
      status: failureText !== undefined ? "failed" : outcome.changed ? "done" : "quiet",
      result: outcomeSummary(outcome),
    };
    const data = tidyDataOf((await this.ctx.store.get(TIDY_TYPE, bot))?.data ?? {});
    if (auto) {
      await this.put(
        bot,
        {
          ...(data ?? {
            bot,
            state: "idle",
            plannedAt: now,
            counts: { notes: 0, chats: 0, indexOver: false },
          }),
          state: "idle",
          chatId: undefined,
          outcome: undefined,
          lastOutcome: outcome,
        },
        "source:bot/tidy",
        run,
      );
      if (outcome.changed || failureText !== undefined) {
        try {
          await this.notify({
            routineId: dreamingId(bot),
            runId: chatId,
            title: DREAMING_NAME,
            summary: tidyOutcomeLine(bot, { ...outcome, summary: outcomeSummary(outcome) }),
            text: tidyOutcomeLine(bot, { ...outcome, summary: outcomeSummary(outcome) }),
            failed: failureText !== undefined,
            bot,
          });
        } catch (error) {
          await this.chatWatches.log(
            `dreaming of bot ${bot}: notify: ${messageOf(error)}`,
          );
        }
      }
      return;
    }
    if (failureText !== undefined) {
      await this.put(
        bot,
        {
          ...(data ?? {
            bot,
            state: "failed",
            plannedAt: now,
            counts: { notes: 0, chats: 0, indexOver: false },
          }),
          state: "failed",
          chatId: undefined,
          outcome,
        },
        "source:bot/tidy",
        run,
      );
      return;
    }
    await this.put(
      bot,
      {
        ...(data ?? {
          bot,
          state: "result",
          plannedAt: now,
          counts: { notes: 0, chats: 0, indexOver: false },
        }),
        state: "result",
        chatId: undefined,
        outcome,
      },
      "source:bot/tidy",
      run,
    );
    try {
      await this.notify({
        routineId: dreamingId(bot),
        runId: chatId,
        title: DREAMING_NAME,
        summary: tidyOutcomeLine(bot, { ...outcome, summary: outcomeSummary(outcome) }),
        text: tidyOutcomeLine(bot, { ...outcome, summary: outcomeSummary(outcome) }),
        failed: false,
        bot,
      });
    } catch (error) {
      await this.chatWatches.log(
        `dreaming of bot ${bot}: notify: ${messageOf(error)}`,
      );
    }
  }

  private async resume(): Promise<void> {
    for (const object of await this.tidyObjects()) {
      const data = tidyDataOf(object.data);
      if (data === undefined) continue;
      const memoryDir = this.memoryDirOf(data.bot);
      if (data.state !== "running") {
        // No run is going: nothing may keep the instructions read-only.
        if (memoryDir !== undefined) unlockInstructions(memoryDir);
        continue;
      }
      if (memoryDir !== undefined && data.chatId === undefined) unlockInstructions(memoryDir);
      if (data.chatId === undefined) {
        // The process died after marking the run but before recording its chat.
        await this.failStart(data.bot, data, "Could not start: the run was not recorded");
        continue;
      }
      if (memoryDir === undefined) continue;
      await this.watch(data.bot, data.chatId, data.auto === true, memoryDir);
    }
  }

  /** The bot's memory directory, or undefined when its settings cannot be read. */
  private memoryDirOf(bot: string): string | undefined {
    try {
      const settings = readBots(this.ctx.home, this.ctx.settings)[bot];
      if (settings === undefined) return undefined;
      return join(workingDirectory(this.ctx.home, bot, settings), "memory");
    } catch {
      return undefined;
    }
  }

  start(): { stop: () => void } {
    this.timer = setInterval(() => {
      this.chatWatches.track(this.poll());
    }, 1_000);
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
    await this.resume();
    await this.poll();
  }
}

/** Starts the tidy source; `begin` runs before the first interval. */
export async function startTidy(
  ctx: TidySourceContext,
): Promise<{ stop: () => void }> {
  const source = new BotTidySource(ctx);
  await source.begin();
  return source.start();
}
