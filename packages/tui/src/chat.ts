/**
 * How a chat's transcript reads in the terminal: a message header says who and
 * when in the reader's own time zone, and a run of thinking and tool lines folds
 * into one line. The server's Markdown is not changed; only these lines are.
 */

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

/** A chat transcript's Markdown as the terminal draws it. */
export function chatMarkdown(markdown: string, options: ChatMarkdownOptions = {}): string {
  if (markdown === "") return markdown;
  const now = options.now ?? Date.now();
  const timeZone = options.timeZone;
  const open = new Set(options.open ?? []);
  const prefix = options.prefix ?? "c";
  const lines = markdown.split("\n");
  const code = codeLines(lines);
  const source = lines.map((line, at) =>
    code[at] === true ? line : headerLine(line, now, timeZone),
  );
  if (options.fold === false) return source.join("\n");
  const runs = chatRuns(markdown, prefix);
  if (runs.length === 0) return source.join("\n");
  const byStart = new Map(runs.map((run) => [run.start, run]));
  const out: string[] = [];
  let at = 0;
  while (at < source.length) {
    const run = byStart.get(at);
    if (run === undefined) {
      out.push(source[at] ?? "");
      at += 1;
      continue;
    }
    if (open.has(run.id)) {
      out.push(...source.slice(run.start, run.end));
    } else {
      out.push(`${run.count} · ${run.last}`);
      // The blank lines after the last line keep the next message apart.
      out.push(...source.slice(run.lastAt + 1, run.end));
    }
    at = run.end;
  }
  return out.join("\n");
}
