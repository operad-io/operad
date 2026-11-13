import pkg from "../package.json" with { type: "json" };
import { definePlugin } from "@operad-io/engine";
import { latestCronMinute, parseCron } from "@operad-io/engine";
import type {
  CronSchedule,
  SourceContext,
  SourceHandle,
  TriggerRule,
} from "@operad-io/engine";

/** One cron rule and how far it has emitted. */
interface CronRule {
  readonly index: number;
  readonly rule: TriggerRule;
  readonly schedule: CronSchedule;
  last: number | null;
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

/** The cron source, in a shape a test can drive with a fake clock. */
export class CronSource {
  private readonly ctx: SourceContext;
  private readonly rules: CronRule[];
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(ctx: SourceContext) {
    this.ctx = ctx;
    this.rules = [];
    for (const [index, rule] of ctx.rules.entries()) {
      if (rule.source !== "cron" || rule.schedule === undefined) continue;
      this.rules.push({
        index,
        rule,
        schedule: parseCron(rule.schedule),
        last: null,
      });
    }
  }

  /** Emits at most one tick per rule, for the latest missed minute. */
  async poll(): Promise<void> {
    if (this.stopped) return;
    const now = this.ctx.clock();
    for (const entry of this.rules) {
      const minute = dueMinute(entry.schedule, entry.last, now);
      if (minute === null) continue;
      entry.last = minute;
      await this.ctx.emit({
        source: "cron",
        key: `${entry.index}:${new Date(minute).toISOString()}`,
        type: "tick",
      });
    }
  }

  start(): SourceHandle {
    this.timer = setInterval(() => {
      void this.poll();
    }, 1_000);
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
