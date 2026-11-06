import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  cronMatches,
  latestCronMinute,
  minuteStart,
  parseCron,
  parseTriggerRules,
  type SourceContext,
} from "@operad-io/engine";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";
import { CronSource, dueMinute } from "../src/index.ts";

process.env.TZ = "America/New_York";

afterAll(cleanupTempRoots);

interface Emitted {
  readonly source?: string;
  readonly key: string;
  readonly type: string;
}

function context(
  rules: SourceContext["rules"],
  clock: () => number,
  emitted: Emitted[],
): SourceContext {
  return {
    plugin: "cron",
    home: "/tmp",
    cwd: "/tmp",
    store: { root: "/tmp", kind: "memory" } as unknown as SourceContext["store"],
    facts: {} as unknown as SourceContext["facts"],
    logger: {} as unknown as SourceContext["logger"],
    signal: new AbortController().signal,
    rules,
    clock,
    settings: {},
    secrets: {} as unknown as SourceContext["secrets"],
    emit: async (event) => {
      emitted.push(event);
    },
  };
}

function cronRule(schedule: string): SourceContext["rules"] {
  return [
    {
      source: "cron",
      type: "tick",
      start: { flow: "one" },
      object: "job:1",
      mode: "auto",
      schedule,
    },
  ];
}

describe("the cron source", () => {
  test("emits once per due minute", async () => {
    const emitted: Emitted[] = [];
    const clock = { value: Date.parse("2026-01-01T00:00:30Z") };
    const source = new CronSource(
      context(cronRule("* * * * *"), () => clock.value, emitted),
    );
    await source.poll();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.type).toBe("tick");
    expect(emitted[0]?.key).toBe("0:2026-01-01T00:00:00.000Z");

    await source.poll();
    expect(emitted).toHaveLength(1);

    clock.value = Date.parse("2026-01-01T00:01:10Z");
    await source.poll();
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.key).toBe("0:2026-01-01T00:01:00.000Z");
  });

  test("a three-hour gap emits only the latest tick", async () => {
    const emitted: Emitted[] = [];
    const clock = { value: Date.parse("2026-01-01T00:00:10Z") };
    const source = new CronSource(
      context(cronRule("*/5 * * * *"), () => clock.value, emitted),
    );
    await source.poll();
    expect(emitted).toHaveLength(1);

    clock.value = Date.parse("2026-01-01T03:00:10Z");
    await source.poll();
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.key).toBe("0:2026-01-01T03:00:00.000Z");
  });

  test("dueMinute returns the latest missed minute, not a burst", () => {
    const schedule = parseCron("*/5 * * * *");
    const latest = dueMinute(schedule, minuteStart(Date.parse("2026-01-01T00:00:00Z")), Date.parse("2026-01-01T03:00:00Z"));
    expect(latest).toBe(Date.parse("2026-01-01T03:00:00Z"));
  });
});

describe("cron schedules", () => {
  test("spring forward skips the missing local hour", () => {
    const schedule = parseCron("30 2 * * *");
    const minute = latestCronMinute(
      schedule,
      Date.parse("2026-03-08T07:30:00Z"),
    );
    expect(minute).not.toBeNull();
    const local = new Date(minute ?? 0);
    // 02:30 does not exist on 2026-03-08 in New York, so the latest match is
    // the previous day.
    expect(local.getDate()).toBe(7);
    expect(local.getHours()).toBe(2);
    expect(local.getMinutes()).toBe(30);
  });

  test("fall back matches the repeated local hour and picks the later one", () => {
    const schedule = parseCron("30 1 * * *");
    expect(cronMatches(schedule, new Date("2026-11-01T05:30:00Z"))).toBe(true);
    expect(cronMatches(schedule, new Date("2026-11-01T06:30:00Z"))).toBe(true);
    expect(
      latestCronMinute(schedule, Date.parse("2026-11-01T07:00:00Z")),
    ).toBe(Date.parse("2026-11-01T06:30:00Z"));
  });

  test("an invalid schedule is refused with the rule index", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    await Bun.write(
      join(home, "triggers.json"),
      JSON.stringify([
        {
          source: "cron",
          type: "tick",
          start: { flow: "one" },
          object: "job:1",
          mode: "auto",
          schedule: "every minute",
        },
      ]),
    );
    const { loadTriggerRules } = await import("@operad-io/engine");
    await expect(loadTriggerRules({ home })).rejects.toThrow(/rule 0: schedule/);
  });
});
