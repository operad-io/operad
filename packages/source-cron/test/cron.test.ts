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
  readonly summary?: string;
  readonly data?: unknown;
}

function context(
  rules: SourceContext["rules"],
  clock: () => number,
  emitted: Emitted[],
  home: string,
): SourceContext {
  return {
    plugin: "cron",
    home,
    cwd: "/tmp",
    store: { root: "/tmp", kind: "memory" } as unknown as SourceContext["store"],
    facts: {} as unknown as SourceContext["facts"],
    logger: {} as unknown as SourceContext["logger"],
    signal: new AbortController().signal,
    rules,
    clock,
    settings: {},
    secrets: {} as unknown as SourceContext["secrets"],
    client: {} as unknown as SourceContext["client"],
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

async function sourceHome(): Promise<string> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return home;
}

describe("the cron source", () => {
  test("emits once per due minute", async () => {
    const emitted: Emitted[] = [];
    const clock = { value: Date.parse("2026-01-01T00:00:30Z") };
    const source = new CronSource(
      context(cronRule("* * * * *"), () => clock.value, emitted, await sourceHome()),
    );
    await source.poll();
    expect(emitted).toHaveLength(0);

    clock.value = Date.parse("2026-01-01T00:01:10Z");
    await source.poll();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.type).toBe("tick");
    expect(emitted[0]?.key).toBe("0:2026-01-01T00:01:00.000Z");

    await source.poll();
    expect(emitted).toHaveLength(1);

    clock.value = Date.parse("2026-01-01T00:02:10Z");
    await source.poll();
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.key).toBe("0:2026-01-01T00:02:00.000Z");
  });

  test("a three-hour gap emits only the latest tick", async () => {
    const emitted: Emitted[] = [];
    const clock = { value: Date.parse("2026-01-01T00:00:10Z") };
    const source = new CronSource(
      context(cronRule("*/5 * * * *"), () => clock.value, emitted, await sourceHome()),
    );
    await source.poll();
    expect(emitted).toHaveLength(0);

    clock.value = Date.parse("2026-01-01T03:00:10Z");
    await source.poll();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.key).toBe("0:2026-01-01T03:00:00.000Z");
  });

  test("dueMinute returns the latest missed minute, not a burst", () => {
    const schedule = parseCron("*/5 * * * *");
    const latest = dueMinute(schedule, minuteStart(Date.parse("2026-01-01T00:00:00Z")), Date.parse("2026-01-01T03:00:00Z"));
    expect(latest).toBe(Date.parse("2026-01-01T03:00:00Z"));
  });
});

describe("missed runs", () => {
  test("serve down over three planned times runs only the latest, once, and history names the skipped ones", async () => {
    const home = await sourceHome();
    const clock = { value: Date.parse("2026-01-01T00:00:10Z") };
    const first: Emitted[] = [];
    const initial = new CronSource(
      context(cronRule("0 * * * *"), () => clock.value, first, home),
    );
    await initial.poll();
    expect(first).toHaveLength(0);

    clock.value = Date.parse("2026-01-01T03:00:30Z");
    const resumed: Emitted[] = [];
    const source = new CronSource(
      context(cronRule("0 * * * *"), () => clock.value, resumed, home),
    );
    await source.poll();
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.key).toBe("0:2026-01-01T03:00:00.000Z");
    expect(resumed[0]?.data).toEqual({
      scheduledAt: "2026-01-01T03:00:00.000Z",
      lateSecs: 30,
    });
    expect(resumed[0]?.summary).toContain("2026-01-01T01:00:00.000Z");
    expect(resumed[0]?.summary).toContain("2026-01-01T02:00:00.000Z");
    expect(resumed[0]?.summary).toContain("only the latest missed run is caught up");

    await source.poll();
    expect(resumed).toHaveLength(1);
  });

  test("a miss older than 7 days runs nothing", async () => {
    const home = await sourceHome();
    const clock = { value: Date.parse("2025-01-01T03:00:10-05:00") };
    const first: Emitted[] = [];
    const initial = new CronSource(
      context(cronRule("0 3 1 1 *"), () => clock.value, first, home),
    );
    await initial.poll();
    expect(first).toHaveLength(0);

    clock.value = Date.parse("2026-01-10T04:00:00-05:00");
    const later: Emitted[] = [];
    const source = new CronSource(
      context(cronRule("0 3 1 1 *"), () => clock.value, later, home),
    );
    await source.poll();
    await source.poll();
    expect(later).toHaveLength(0);
  });

  test("a wake catches up the same way", async () => {
    const home = await sourceHome();
    const clock = { value: Date.parse("2026-01-01T03:00:10-05:00") };
    const emitted: Emitted[] = [];
    const source = new CronSource(
      context(cronRule("0 3 * * *"), () => clock.value, emitted, home),
    );
    await source.poll();
    expect(emitted).toHaveLength(0);

    clock.value = Date.parse("2026-01-04T03:00:30-05:00");
    await source.poll();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.key).toBe(
      `0:${new Date(Date.parse("2026-01-04T03:00:00-05:00")).toISOString()}`,
    );
    expect(emitted[0]?.data).toEqual({
      scheduledAt: new Date(Date.parse("2026-01-04T03:00:00-05:00")).toISOString(),
      lateSecs: 30,
    });
    expect(emitted[0]?.summary).toContain(
      new Date(Date.parse("2026-01-02T03:00:00-05:00")).toISOString(),
    );
    expect(emitted[0]?.summary).toContain(
      new Date(Date.parse("2026-01-03T03:00:00-05:00")).toISOString(),
    );
  });

  test("a changed schedule does not catch up", async () => {
    const home = await sourceHome();
    const clock = { value: Date.parse("2026-01-01T03:00:10-05:00") };
    const first: Emitted[] = [];
    const initial = new CronSource(
      context(cronRule("0 3 * * *"), () => clock.value, first, home),
    );
    await initial.poll();
    expect(first).toHaveLength(0);

    clock.value = Date.parse("2026-01-02T10:00:00-05:00");
    const changed: Emitted[] = [];
    const source = new CronSource(
      context(cronRule("0 5 * * *"), () => clock.value, changed, home),
    );
    await source.poll();
    expect(changed).toHaveLength(0);

    clock.value = Date.parse("2026-01-03T05:00:10-05:00");
    await source.poll();
    expect(changed).toHaveLength(1);
    expect(changed[0]?.key).toBe(
      `0:${new Date(Date.parse("2026-01-03T05:00:00-05:00")).toISOString()}`,
    );
    expect(changed[0]?.data).toBeUndefined();
  });

  test("a new rule whose planned time passed earlier today waits for its next one", async () => {
    const home = await sourceHome();
    const clock = { value: Date.parse("2026-01-01T15:00:10Z") };
    const emitted: Emitted[] = [];
    const source = new CronSource(
      context(cronRule("0 8 * * *"), () => clock.value, emitted, home),
    );
    await source.poll();
    expect(emitted).toHaveLength(0);

    clock.value = Date.parse("2026-01-02T08:00:10-05:00");
    await source.poll();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.key).toBe(
      `0:${new Date(Date.parse("2026-01-02T08:00:00-05:00")).toISOString()}`,
    );
    expect(emitted[0]?.data).toBeUndefined();
  });

  test("removing an earlier rule does not change what a later rule catches up", async () => {
    const home = await sourceHome();
    const clock = { value: Date.parse("2026-01-01T00:10:10Z") };
    const firstRule: SourceContext["rules"][number] = {
      source: "cron",
      type: "tick",
      start: { flow: "one" },
      object: "job:a",
      mode: "auto",
      schedule: "0 * * * *",
    };
    const laterRule: SourceContext["rules"][number] = {
      source: "cron",
      type: "tick",
      start: { flow: "two" },
      object: "job:b",
      mode: "auto",
      schedule: "0 8 * * *",
    };
    const first = new CronSource(
      context([firstRule, laterRule], () => clock.value, [], home),
    );
    await first.poll();

    clock.value = Date.parse("2026-01-02T08:00:10-05:00");
    const emitted: Emitted[] = [];
    const later = new CronSource(
      context([laterRule], () => clock.value, emitted, home),
    );
    await later.poll();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.key).toBe(
      `0:${new Date(Date.parse("2026-01-02T08:00:00-05:00")).toISOString()}`,
    );
    expect(emitted[0]?.summary).toContain(
      new Date(Date.parse("2026-01-01T08:00:00-05:00")).toISOString(),
    );
  });

  test("a normal on-time tick carries no lateness", async () => {
    const home = await sourceHome();
    const clock = { value: Date.parse("2026-01-01T00:00:10Z") };
    const emitted: Emitted[] = [];
    const source = new CronSource(
      context(cronRule("* * * * *"), () => clock.value, emitted, home),
    );
    await source.poll();
    clock.value = Date.parse("2026-01-01T00:01:10Z");
    await source.poll();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.key).toBe("0:2026-01-01T00:01:00.000Z");
    expect(emitted[0]?.data).toBeUndefined();
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
