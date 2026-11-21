/**
 * How a chat's transcript reads in the terminal: a message header says who and
 * when in the reader's own time zone, and a run of thinking and tool lines folds
 * into one line. The server's Markdown is not changed; only these lines are.
 */

import { layoutMarkdown } from "./layout.ts";

/** One run of thinking and tool lines in a transcript. */
export interface ChatFoldRun {
  /** Stable for one position in one part of a transcript. */
  readonly id: string;
  /** How many thinking and tool lines the run holds. */
  readonly count: number;
  /** The last of them, as written. */
  readonly last: string;
  /** The first Markdown line of the run. */
  readonly start: number;
  /** The line after the run, including the blank lines that follow it. */
  readonly end: number;
  /** The last thinking or tool line. */
  readonly lastAt: number;
}

/** Where one run's rows begin and end in the drawn transcript. */
export interface ChatRunRows {
  readonly run: ChatFoldRun;
  readonly start: number;
  readonly end: number;
}

export interface ChatMarkdownOptions {
  /** The moment that decides whether a header's date is today. */
  readonly now?: number | undefined;
  /** The zone the header's time is drawn in; the terminal's when unset. */
  readonly timeZone?: string | undefined;
  /** The runs a person opened. */
  readonly open?: readonly string[] | undefined;
  /** Fold thinking and tool runs; true unless a caller says otherwise. */
  readonly fold?: boolean | undefined;
  /** The part of a transcript the run ids belong to: content or tail. */
  readonly prefix?: string | undefined;
}

/** One output line, with the run it belongs to when it is part of one. */
interface ChatSegment {
  readonly text: string;
  readonly run?: ChatFoldRun | undefined;
}

const HEADER = /^\*\*([^*]+)\*\*(?: via ([^·]+?))? · (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(.*)$/;
const FENCE = /^\s{0,3}(?:```|~~~)/;

function dateParts(
  at: Date,
  timeZone: string | undefined,
): { readonly year: string; readonly month: string; readonly day: string; readonly hour: string; readonly minute: string } | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
      parts.find((one) => one.type === type)?.value;
    const year = part("year");
    const month = part("month");
    const day = part("day");
    const hour = part("hour");
    const minute = part("minute");
    return year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined
      ? undefined
      : { year, month, day, hour, minute };
  } catch {
    return undefined;
  }
}

/** One header line with the transport left out and the time in the reader's zone. */
function headerLine(line: string, now: number, timeZone: string | undefined): string {
  const match = HEADER.exec(line);
  if (match === null) return line;
  const [, who = "", , year = "", month = "", day = "", hour = "", minute = "", rest = ""] = match;
  const at = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)));
  if (Number.isNaN(at.getTime())) return line;
  const local = dateParts(at, timeZone);
  const today = dateParts(new Date(now), timeZone);
  if (local === undefined || today === undefined) return line;
  const isToday =
    local.year === today.year && local.month === today.month && local.day === today.day;
  const when = isToday
    ? `${local.hour}:${local.minute}`
    : `${local.year}-${local.month}-${local.day} ${local.hour}:${local.minute}`;
  return `**${who}** · ${when}${rest}`;
}

type LineKind = "thinking" | "tool" | "text";

function kindOf(line: string, code: boolean): LineKind {
  if (code) return "text";
  const trimmed = line.trimStart();
  if (trimmed === ">" || trimmed.startsWith("> ")) return "thinking";
  if (trimmed.startsWith("tool ")) return "tool";
  return "text";
}

function codeLines(lines: readonly string[]): readonly boolean[] {
  const out: boolean[] = [];
  let code = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      out.push(true);
      code = !code;
    } else {
      out.push(code);
    }
  }
  return out;
}

/** The thinking and tool runs in one part of a chat transcript. */
export function chatRuns(markdown: string, prefix = "c"): readonly ChatFoldRun[] {
  if (markdown === "") return [];
  const lines = markdown.split("\n");
  const code = codeLines(lines);
  const runs: ChatFoldRun[] = [];
  let at = 0;
  while (at < lines.length) {
    if (kindOf(lines[at] ?? "", code[at] === true) === "text") {
      at += 1;
      continue;
    }
    const start = at;
    let last = "";
    let count = 0;
    let lastAt = start;
    while (at < lines.length) {
      const line = lines[at] ?? "";
      const kind = kindOf(line, code[at] === true);
      if (kind === "text" && line.trim() !== "") break;
      if (kind !== "text") {
        count += 1;
        last = line;
        lastAt = at;
      }
      at += 1;
    }
    runs.push({
      id: `${prefix}:${start}`,
      count,
      last,
      start,
      end: at,
      lastAt,
    });
  }
  return runs;
}

/** The output lines of one part of a transcript, each with the run it belongs to. */
function chatSegments(markdown: string, options: ChatMarkdownOptions): ChatSegment[] {
  if (markdown === "") return [];
  const now = options.now ?? Date.now();
  const timeZone = options.timeZone;
  const open = new Set(options.open ?? []);
  const prefix = options.prefix ?? "c";
  const lines = markdown.split("\n");
  const code = codeLines(lines);
  const source = lines.map((line, at) =>
    code[at] === true ? line : headerLine(line, now, timeZone),
  );
  if (options.fold === false) return source.map((text) => ({ text }));
  const runs = chatRuns(markdown, prefix);
  if (runs.length === 0) return source.map((text) => ({ text }));
  const byStart = new Map(runs.map((run) => [run.start, run]));
  const segments: ChatSegment[] = [];
  let at = 0;
  while (at < source.length) {
    const run = byStart.get(at);
    if (run === undefined) {
      segments.push({ text: source[at] ?? "" });
      at += 1;
      continue;
    }
    if (open.has(run.id)) {
      for (let line = run.start; line < run.end; line += 1) {
        segments.push({ text: source[line] ?? "", run });
      }
    } else {
      segments.push({ text: `${run.count} · ${run.last}`, run });
      // The blank lines after the last line keep the next message apart.
      for (let line = run.lastAt + 1; line < run.end; line += 1) {
        segments.push({ text: source[line] ?? "" });
      }
    }
    at = run.end;
  }
  return segments;
}

/** How many chat Markdown strings were built, for a test that checks the cache is used. */
export const chatStats = { computed: 0 };

interface ChatCacheEntry {
  readonly markdown: string;
  readonly day: string;
  readonly timeZone: string | undefined;
  readonly open: string;
  readonly fold: boolean;
  readonly prefix: string;
  readonly result: string;
}

const CHAT_CACHE_LIMIT = 32;
const chatCache: ChatCacheEntry[] = [];

/** The local day a header compares against; the time of day does not change the text. */
function dayOf(now: number, timeZone: string | undefined): string {
  const parts = dateParts(new Date(now), timeZone);
  return parts === undefined
    ? String(now)
    : `${parts.year}-${parts.month}-${parts.day}`;
}

function cachedChat(markdown: string, options: ChatMarkdownOptions): string | undefined {
  const day = dayOf(options.now ?? Date.now(), options.timeZone);
  const open = [...(options.open ?? [])].sort().join("\u0000");
  const fold = options.fold !== false;
  const prefix = options.prefix ?? "c";
  return chatCache.find(
    (entry) =>
      entry.markdown === markdown &&
      entry.day === day &&
      entry.timeZone === options.timeZone &&
      entry.open === open &&
      entry.fold === fold &&
      entry.prefix === prefix,
  )?.result;
}

function rememberChat(
  markdown: string,
  options: ChatMarkdownOptions,
  result: string,
): void {
  chatCache.unshift({
    markdown,
    day: dayOf(options.now ?? Date.now(), options.timeZone),
    timeZone: options.timeZone,
    open: [...(options.open ?? [])].sort().join("\u0000"),
    fold: options.fold !== false,
    prefix: options.prefix ?? "c",
    result,
  });
  if (chatCache.length > CHAT_CACHE_LIMIT) chatCache.pop();
}

/** A chat transcript's Markdown as the terminal draws it. */
export function chatMarkdown(markdown: string, options: ChatMarkdownOptions = {}): string {
  const cached = cachedChat(markdown, options);
  if (cached !== undefined) return cached;
  chatStats.computed += 1;
  const result = chatSegments(markdown, options).map((segment) => segment.text).join("\n");
  rememberChat(markdown, options, result);
  return result;
}

/** Rows a prefix takes when the next line is appended, without trimming its blanks. */
function rowsThrough(lines: readonly string[], width: number): number {
  const text = `${lines.join("\n")}\nSENTINEL`;
  return layoutMarkdown(text, width).length - 1;
}

/** Where each run's rows lie in one drawn part of a transcript. */
export function chatRunRows(
  markdown: string,
  options: ChatMarkdownOptions & { readonly width: number },
): readonly ChatRunRows[] {
  const segments = chatSegments(markdown, options);
  const seen: ChatRunRows[] = [];
  const prefix: string[] = [];
  let at = 0;
  while (at < segments.length) {
    const run = segments[at]?.run;
    if (run === undefined) {
      prefix.push(segments[at]?.text ?? "");
      at += 1;
      continue;
    }
    const start = rowsThrough(prefix, options.width);
    let end = at;
    while (end < segments.length && segments[end]?.run?.id === run.id) end += 1;
    const through = [...prefix, ...segments.slice(at, end).map((segment) => segment.text)];
    seen.push({ run, start, end: rowsThrough(through, options.width) });
    prefix.push(...segments.slice(at, end).map((segment) => segment.text));
    at = end;
  }
  return seen;
}
