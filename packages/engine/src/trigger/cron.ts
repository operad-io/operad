/**
 * A five-field cron expression, evaluated in the machine's local time zone.
 *
 * Fields are minute, hour, day of month, month and day of week. Each accepts
 * `*`, a number, a range `a-b`, a step like `*` with `/n`, and comma lists.
 * The day fields follow the usual rule: when both are restricted, either may
 * match; when one is `*`, the other must match.
 */

export interface CronField {
  readonly values: ReadonlySet<number>;
  readonly restricted: boolean;
}

export interface CronSchedule {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly day: CronField;
  readonly month: CronField;
  readonly weekday: CronField;
}

export class CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronError";
  }
}

function parseNumber(text: string, min: number, max: number, field: string): number {
  if (!/^\d+$/.test(text)) {
    throw new CronError(`${field}: "${text}" is not a number`);
  }
  const value = Number(text);
  if (value < min || value > max) {
    throw new CronError(`${field}: ${value} is outside ${min}..${max}`);
  }
  return value;
}

function parseField(text: string, min: number, max: number, field: string): CronField {
  if (text.length === 0) throw new CronError(`${field}: must not be empty`);
  const values = new Set<number>();
  let restricted = false;

  for (const part of text.split(",")) {
    if (part.length === 0) throw new CronError(`${field}: has an empty list item`);
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined) {
      throw new CronError(`${field}: "${part}" has too many "/" parts`);
    }
    const step = stepText === undefined ? 1 : parseNumber(stepText, 1, max, `${field} step`);
    if (stepText !== undefined) restricted = true;

    let start: number;
    let end: number;
    if (range === "*") {
      start = min;
      end = max;
    } else if (range !== undefined && range.includes("-")) {
      const [left, right, more] = range.split("-");
      if (more !== undefined || left === undefined || right === undefined) {
        throw new CronError(`${field}: "${part}" is not a valid range`);
      }
      start = parseNumber(left, min, max, field);
      end = parseNumber(right, min, max, field);
      if (start > end) throw new CronError(`${field}: "${part}" is an empty range`);
      restricted = true;
    } else {
      start = parseNumber(range ?? "", min, max, field);
      end = start;
      restricted = true;
    }

    for (let value = start; value <= end; value += step) values.add(value);
  }

  if (field === "day of week" && values.has(7)) values.add(0);

  if (values.size === 0) throw new CronError(`${field}: matches no value`);
  return { values, restricted };
}

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;

const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function expandNames(text: string, names: readonly string[], min: number): string {
  return text.replace(/[a-zA-Z]{3}/g, (name) => {
    const index = names.indexOf(name.toLowerCase() as never);
    if (index < 0) throw new CronError(`unknown name "${name}"`);
    return String(index + min);
  });
}

/** Parses five fields; a schedule with seconds or years is refused. */
export function parseCron(expression: string): CronSchedule {
  if (typeof expression !== "string") {
    throw new CronError("schedule: must be a string");
  }
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronError(
      `schedule: expected five fields (minute hour day month weekday), got ${fields.length}`,
    );
  }
  const [minute, hour, day, month, weekday] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    minute: parseField(minute, 0, 59, "minute"),
    hour: parseField(hour, 0, 23, "hour"),
    day: parseField(day, 1, 31, "day of month"),
    month: parseField(expandNames(month, MONTH_NAMES, 1), 1, 12, "month"),
    weekday: parseField(expandNames(weekday, WEEKDAY_NAMES, 0), 0, 7, "day of week"),
  };
}

function weekdayValue(date: Date): number {
  return date.getDay();
}

/** True when the local date falls on the schedule. */
export function cronMatches(schedule: CronSchedule, date: Date): boolean {
  if (!schedule.minute.values.has(date.getMinutes())) return false;
  if (!schedule.hour.values.has(date.getHours())) return false;
  if (!schedule.month.values.has(date.getMonth() + 1)) return false;

  const weekday = weekdayValue(date);
  const dayMatches = schedule.day.values.has(date.getDate());
  const weekdayMatches = schedule.weekday.values.has(weekday);
  if (!schedule.day.restricted && !schedule.weekday.restricted) return true;
  if (!schedule.day.restricted) return weekdayMatches;
  if (!schedule.weekday.restricted) return dayMatches;
  // Both day fields are restricted: either one matching is enough.
  return dayMatches || weekdayMatches;
}

/** The start of the minute `time` is in, in milliseconds. */
export function minuteStart(time: number): number {
  return time - (time % 60_000);
}

/**
 * The latest scheduled minute at or before `time`, looking back at most
 * `limitDays`. Returns the minute start, or null when none matches.
 */
export function latestCronMinute(
  schedule: CronSchedule,
  time: number,
  limitDays = 366 * 2,
): number | null {
  let candidate = minuteStart(time);
  const limit = candidate - limitDays * 24 * 60 * 60_000;
  while (candidate >= limit) {
    if (cronMatches(schedule, new Date(candidate))) return candidate;
    candidate -= 60_000;
  }
  return null;
}

/** Every scheduled minute in `(after, until]`, oldest first. Kept small by callers. */
export function cronMinutesBetween(
  schedule: CronSchedule,
  after: number,
  until: number,
): number[] {
  const result: number[] = [];
  let candidate = minuteStart(after) + 60_000;
  const end = minuteStart(until);
  while (candidate <= end) {
    if (cronMatches(schedule, new Date(candidate))) result.push(candidate);
    candidate += 60_000;
  }
  return result;
}
