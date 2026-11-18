import pkg from "../package.json" with { type: "json" };
import { definePlugin } from "@operad-io/engine";
import {
  cronMinutesBetween,
  latestCronMinute,
  minuteStart,
  parseCron,
} from "@operad-io/engine";
import type {
  CronSchedule,
  SourceContext,
  SourceHandle,
  TriggerRule,
} from "@operad-io/engine";
import { readCronState, writeCronState, type CronState } from "./state.ts";

/** How often the running source checks the clock. */
const CHECK_INTERVAL_MS = 1_000;
/** A gap much larger than the check interval means the machine slept or the clock jumped. */
const WAKE_GAP_MS = 60_000;
/** How far back a catch-up looks. */
const CATCH_UP_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

/** One cron rule and how far it has emitted. */
interface CronRule {
  readonly index: number;
  readonly rule: TriggerRule;
  readonly schedule: CronSchedule;
  readonly expression: string;
  last: number | null;
  /** A rule with no recorded last time begins at its latest planned time. */
  baseline: boolean;
}

/** The pure part: which minute a rule should emit next, if any. */
export function dueMinute(
  schedule: CronSchedule,
  last: number | null,
  now: number,
  lookbackDays = 366 * 2,
): number | null {
  if (last !== null) {
    const candidate = latestCronMinute(schedule, now);
    if (candidate === null || candidate <= last) return null;
    return candidate;
  }
  return latestCronMinute(schedule, now, lookbackDays);
}

/** The stable identity of a rule, independent of its position in the file. */
function ruleKey(rule: TriggerRule): string {
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

/** One line for history naming the times a catch-up passed over. */
export function skippedLine(skipped: readonly number[]): string {
  const shown =
    skipped.length <= 100
      ? skipped.map((minute) => new Date(minute).toISOString())
      : [
          ...skipped.slice(0, 50).map((minute) => new Date(minute).toISOString()),
          `… ${skipped.length - 50} more …`,
        ];
  return `skipped ${shown.join(", ")}: only the latest missed run is caught up`;
}

/** The cron source, in a shape a test can drive with a fake clock. */
export class CronSource {
  private readonly ctx: SourceContext;
  private readonly rules: CronRule[];
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private busy = false;
  private lastCheck: number | undefined;

  constructor(ctx: SourceContext) {
    this.ctx = ctx;
    const state = readCronState(ctx.home);
    this.rules = [];
    for (const [index, rule] of ctx.rules.entries()) {
      if (rule.source !== "cron" || rule.schedule === undefined) continue;
      const stored = state.rules[ruleKey(rule)];
      const sameSchedule = stored !== undefined && stored.schedule === rule.schedule;
      this.rules.push({
        index,
        rule,
        schedule: parseCron(rule.schedule),
        expression: rule.schedule,
        last: sameSchedule ? stored.last : null,
        baseline: !sameSchedule,
      });
    }
  }

  /** Emits at most one tick per rule, for the latest missed minute. */
  async poll(): Promise<void> {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      const now = this.ctx.clock();
      const previous = this.lastCheck;
      this.lastCheck = now;
      const catchUp = previous === undefined || now - previous > WAKE_GAP_MS;
      let changed = false;
      for (const entry of this.rules) {
        if (entry.baseline) {
          entry.last =
            latestCronMinute(entry.schedule, now, CATCH_UP_DAYS) ?? minuteStart(now);
          entry.baseline = false;
          changed = true;
          continue;
        }
        if (catchUp) {
          const result = this.catchUp(entry, now);
          if (result.kind === "baseline") {
            if (entry.last === null || result.last > entry.last) {
              entry.last = result.last;
              changed = true;
            }
            continue;
          }
          await this.emit(entry, result.minute, result.skipped, now);
          entry.last = result.minute;
          changed = true;
          continue;
        }
        const minute = dueMinute(
          entry.schedule,
          entry.last,
          now,
          CATCH_UP_DAYS,
        );
        if (minute === null) continue;
        await this.emit(entry, minute, [], now);
        entry.last = minute;
        changed = true;
      }
      if (changed) writeCronState(this.ctx.home, this.snapshot());
    } finally {
      this.busy = false;
    }
  }

  /** Finds the latest planned time in the last 7 days, and what it passed over. */
  private catchUp(
    entry: CronRule,
    now: number,
  ):
    | { kind: "tick"; minute: number; skipped: readonly number[] }
    | { kind: "baseline"; last: number } {
    const latest = latestCronMinute(entry.schedule, now, CATCH_UP_DAYS);
    if (latest === null) return { kind: "baseline", last: minuteStart(now) };
    if (entry.last !== null && latest <= entry.last) {
      return { kind: "baseline", last: entry.last };
    }
    const windowStart =
      entry.last === null
        ? minuteStart(now) - CATCH_UP_DAYS * DAY_MS
        : Math.max(entry.last, minuteStart(now) - CATCH_UP_DAYS * DAY_MS);
    if (latest <= windowStart) return { kind: "baseline", last: latest };
    const skipped =
      entry.last === null
        ? []
        : cronMinutesBetween(entry.schedule, windowStart, latest).slice(0, -1);
    return { kind: "tick", minute: latest, skipped };
  }

  private async emit(
    entry: CronRule,
    minute: number,
    skipped: readonly number[],
    now: number,
  ): Promise<void> {
    const lateSecs = Math.floor((now - minute) / 1_000);
    const late = minute < minuteStart(now) || skipped.length > 0;
    await this.ctx.emit({
      source: "cron",
      key: `${entry.index}:${new Date(minute).toISOString()}`,
      type: "tick",
      ...(skipped.length === 0 ? {} : { summary: skippedLine(skipped) }),
      ...(late
        ? {
            data: {
              scheduledAt: new Date(minute).toISOString(),
              lateSecs,
            },
          }
        : {}),
    });
  }

  private snapshot(): CronState {
    const rules: Record<string, { schedule: string; last: number }> = {};
    for (const entry of this.rules) {
      if (entry.last === null) continue;
      rules[ruleKey(entry.rule)] = {
        schedule: entry.expression,
        last: entry.last,
      };
    }
    return { rules };
  }

  start(): SourceHandle {
    this.timer = setInterval(() => {
      void this.poll();
    }, CHECK_INTERVAL_MS);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
    return {
      stop: () => {
        this.stopped = true;
        if (this.timer !== undefined) clearInterval(this.timer);
      },
    };
  }
}

export default definePlugin({
  name: "cron",
  kind: "source",
  version: pkg.version,
  start(ctx) {
    const source = new CronSource(ctx);
    void source.poll();
    return source.start();
  },
});
