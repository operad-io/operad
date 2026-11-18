import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadTriggerRules,
  openConfigLog,
  readConfig,
  type CommandContext,
  type SourceContext,
} from "@operad-io/engine";
import { cleanupTempRoots, tempRoot } from "../../engine/test/plugin/support.ts";
import {
  CronSource,
  scheduledCommand,
  type ScheduledFlow,
} from "../src/index.ts";

process.env.TZ = "UTC";

afterAll(cleanupTempRoots);

interface Emitted {
  readonly key: string;
  readonly type: string;
  readonly summary?: string;
  readonly data?: unknown;
}

async function scheduleHome(): Promise<string> {
  const root = await tempRoot();
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return home;
}

function commandContext(home: string): CommandContext {
  return {
    plugin: "cron",
    home,
    cwd: home,
    store: {} as unknown as CommandContext["store"],
    facts: {} as unknown as CommandContext["facts"],
    logger: { path: join(home, "log"), write: async () => "" },
    signal: new AbortController().signal,
    settings: {},
    secrets: {} as unknown as CommandContext["secrets"],
    flows: ["plugin-one", "plugin-two"],
  };
}

async function run(
  home: string,
  argv: readonly string[],
  now: { value: number },
): Promise<unknown> {
  return await scheduledCommand({ now: () => now.value }).run(
    commandContext(home),
    argv,
  );
}

function sourceContext(
  rules: SourceContext["rules"],
  clock: () => number,
  emitted: Emitted[],
  home: string,
): SourceContext {
  return {
    plugin: "cron",
    home,
    cwd: "/tmp",
    store: {} as unknown as SourceContext["store"],
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

async function list(home: string, now: { value: number }): Promise<readonly ScheduledFlow[]> {
  return (await run(home, ["list", "--json"], now)) as readonly ScheduledFlow[];
}

describe("scheduled flows", () => {
  test("adding one makes it appear in the list with its next run", async () => {
    const home = await scheduleHome();
    const now = { value: Date.parse("2026-01-01T07:30:00Z") };
    await run(
      home,
      [
        "add",
        "--flow",
        "plugin-one",
        "--schedule",
        "0 8 * * *",
        "--params",
        '{"topic":"news"}',
        "--object",
        "job:1",
      ],
      now,
    );
    const entries = await list(home, now);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      flow: "plugin-one",
      schedule: "0 8 * * *",
      params: { topic: "news" },
      object: "job:1",
      mode: "auto",
      paused: false,
      lastRun: null,
    });
    expect(entries[0]?.nextRun).toBe("2026-01-01T08:00:00.000Z");
  });

  test("pause stops ticks and survives a reload, and resume starts them again", async () => {
    const home = await scheduleHome();
    const clock = { value: Date.parse("2026-01-01T00:00:30Z") };
    await run(
      home,
      ["add", "--flow", "plugin-one", "--schedule", "* * * * *"],
      clock,
    );

    const first: Emitted[] = [];
    const initial = new CronSource(
      sourceContext(await loadTriggerRules({ home }), () => clock.value, first, home),
    );
    await initial.poll();
    clock.value = Date.parse("2026-01-01T00:01:10Z");
    await initial.poll();
    expect(first).toHaveLength(1);

    clock.value = Date.parse("2026-01-01T00:02:10Z");
    await run(home, ["pause", (await list(home, clock))[0]?.id ?? ""], clock);

    const paused: Emitted[] = [];
    const reloaded = new CronSource(
      sourceContext(await loadTriggerRules({ home }), () => clock.value, paused, home),
    );
    clock.value = Date.parse("2026-01-01T00:03:10Z");
    await reloaded.poll();
    expect(paused).toHaveLength(0);

    clock.value = Date.parse("2026-01-01T00:04:10Z");
    await reloaded.poll();
    expect(paused).toHaveLength(0);

    await run(home, ["resume", (await list(home, clock))[0]?.id ?? ""], clock);
    const resumed: Emitted[] = [];
    const again = new CronSource(
      sourceContext(await loadTriggerRules({ home }), () => clock.value, resumed, home),
    );
    clock.value = Date.parse("2026-01-01T00:04:30Z");
    await again.poll();
    expect(resumed).toHaveLength(0);
    clock.value = Date.parse("2026-01-01T00:05:10Z");
    await again.poll();
    expect(resumed).toHaveLength(1);
  });

  test("edit changes the schedule and the next run", async () => {
    const home = await scheduleHome();
    const clock = { value: Date.parse("2026-01-01T07:00:00Z") };
    await run(home, ["add", "--flow", "plugin-one", "--schedule", "0 8 * * *"], clock);
    const before = await list(home, clock);
    expect(before[0]?.nextRun).toBe("2026-01-01T08:00:00.000Z");

    await run(home, ["edit", before[0]?.id ?? "", "--schedule", "0 9 * * *"], clock);
    const after = await list(home, clock);
    expect(after[0]?.schedule).toBe("0 9 * * *");
    expect(after[0]?.nextRun).toBe("2026-01-01T09:00:00.000Z");

    const emitter = new CronSource(
      sourceContext(await loadTriggerRules({ home }), () => clock.value, [], home),
    );
    clock.value = Date.parse("2026-01-01T08:00:10Z");
    await emitter.poll();
    const emitted: Emitted[] = [];
    const source = new CronSource(
      sourceContext(await loadTriggerRules({ home }), () => clock.value, emitted, home),
    );
    await source.poll();
    expect(emitted).toHaveLength(0);
    clock.value = Date.parse("2026-01-01T09:00:10Z");
    await source.poll();
    expect(emitted).toHaveLength(1);
  });

  test("an empty --params adds none and clears the ones an edit finds", async () => {
    const home = await scheduleHome();
    const now = { value: Date.parse("2026-01-01T07:00:00Z") };
    await run(
      home,
      [
        "add",
        "--flow",
        "plugin-one",
        "--schedule",
        "0 8 * * *",
        "--params",
        '{"topic":"news"}',
      ],
      now,
    );
    const id = (await list(home, now))[0]?.id ?? "";
    expect((await list(home, now))[0]?.params).toEqual({ topic: "news" });
    await run(home, ["edit", id, "--params", ""], now);
    expect((await list(home, now))[0]?.params).toBeUndefined();
    await run(
      home,
      ["add", "--flow", "plugin-two", "--schedule", "0 9 * * *", "--params", ""],
      now,
    );
    expect((await list(home, now)).find((entry) => entry.flow === "plugin-two")?.params).toBeUndefined();
  });

  test("edit that makes a rule identical to another is refused and changes nothing", async () => {
    const home = await scheduleHome();
    const clock = { value: Date.parse("2026-01-01T07:00:00Z") };
    await run(home, ["add", "--flow", "plugin-one", "--schedule", "0 8 * * *"], clock);
    await run(home, ["add", "--flow", "plugin-one", "--schedule", "0 9 * * *"], clock);
    const before = await list(home, clock);
    const second = before.find((entry) => entry.schedule === "0 9 * * *");
    await expect(
      run(home, ["edit", second?.id ?? "", "--schedule", "0 8 * * *"], clock),
    ).rejects.toThrow("already exists");
    expect(await list(home, clock)).toEqual(before);
  });

  test("a rare schedule's next run is found: a leap day, and none within two years", async () => {
    const home = await scheduleHome();
    const clock = { value: Date.parse("2026-03-01T07:00:00Z") };
    await run(home, ["add", "--flow", "plugin-one", "--schedule", "30 4 29 2 *"], clock);
    await run(home, ["add", "--flow", "plugin-one", "--schedule", "0 0 31 2 *"], clock);
    const entries = await list(home, clock);
    expect(entries.find((entry) => entry.schedule === "30 4 29 2 *")?.nextRun).toBe(
      "2028-02-29T04:30:00.000Z",
    );
    expect(entries.find((entry) => entry.schedule === "0 0 31 2 *")?.nextRun).toBeNull();
  });

  test("the list shows a paused flow as paused, as text and as data", async () => {
    const home = await scheduleHome();
    const clock = { value: Date.parse("2026-01-01T07:00:00Z") };
    await run(home, ["add", "--flow", "plugin-one", "--schedule", "0 8 * * *"], clock);
    const id = (await list(home, clock))[0]?.id ?? "";
    await run(home, ["pause", id], clock);
    const entries = await list(home, clock);
    expect(entries[0]).toMatchObject({ paused: true, nextRun: null });
    expect(await run(home, ["list"], clock)).toContain("paused");
  });

  test("the next run is never the current minute or earlier", async () => {
    const home = await scheduleHome();
    const clock = { value: Date.parse("2026-01-01T08:00:30Z") };
    await run(home, ["add", "--flow", "plugin-one", "--schedule", "0 8 * * *"], clock);
    expect((await list(home, clock))[0]?.nextRun).toBe("2026-01-02T08:00:00.000Z");
  });

  test("a paused rule's recorded minute follows the clock, so reopening it does not catch up the pause", async () => {
    const home = await scheduleHome();
    const clock = { value: Date.parse("2026-01-01T00:00:30Z") };
    await run(home, ["add", "--flow", "plugin-one", "--schedule", "* * * * *"], clock);
    await run(home, ["pause", (await list(home, clock))[0]?.id ?? ""], clock);
    const paused = new CronSource(
      sourceContext(await loadTriggerRules({ home }), () => clock.value, [], home),
    );
    await paused.poll();
    clock.value = Date.parse("2026-01-01T00:05:10Z");
    await paused.poll();

    // The file is changed by hand, so only the source's own record can hold the line.
    const file = join(home, "triggers.json");
    const rules = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>[];
    writeFileSync(
      file,
      JSON.stringify(rules.map(({ paused: _paused, ...rest }) => rest)),
      "utf8",
    );
    clock.value = Date.parse("2026-01-01T00:05:40Z");
    const emitted: Emitted[] = [];
    await new CronSource(
      sourceContext(await loadTriggerRules({ home }), () => clock.value, emitted, home),
    ).poll();
    expect(emitted).toHaveLength(0);
  });

  test("resuming records a baseline, so a source started later does not catch up the pause", async () => {
    const home = await scheduleHome();
    const clock = { value: Date.parse("2026-01-01T00:00:30Z") };
    await run(home, ["add", "--flow", "plugin-one", "--schedule", "* * * * *"], clock);
    const id = (await list(home, clock))[0]?.id ?? "";
    clock.value = Date.parse("2026-01-01T00:00:40Z");
    await run(home, ["pause", id], clock);
    clock.value = Date.parse("2026-01-01T00:10:30Z");
    await run(home, ["resume", id], clock);
    clock.value = Date.parse("2026-01-01T00:10:40Z");
    const emitted: Emitted[] = [];
    await new CronSource(
      sourceContext(await loadTriggerRules({ home }), () => clock.value, emitted, home),
    ).poll();
    expect(emitted).toHaveLength(0);
  });

  test("remove deletes the rule", async () => {
    const home = await scheduleHome();
    const now = { value: Date.parse("2026-01-01T07:00:00Z") };
    await run(home, ["add", "--flow", "plugin-one", "--schedule", "0 8 * * *"], now);
    const id = (await list(home, now))[0]?.id ?? "";
    await run(home, ["remove", id], now);
    expect(await list(home, now)).toEqual([]);
    expect(await loadTriggerRules({ home })).toEqual([]);
  });

  test("an unknown flow is refused with the reason", async () => {
    const home = await scheduleHome();
    const now = { value: Date.parse("2026-01-01T07:00:00Z") };
    await expect(
      run(home, ["add", "--flow", "missing", "--schedule", "0 8 * * *"], now),
    ).rejects.toThrow('start.flow: unknown flow "missing"');
  });

  test("a bad cron expression is refused with the reason", async () => {
    const home = await scheduleHome();
    const now = { value: Date.parse("2026-01-01T07:00:00Z") };
    await expect(
      run(home, ["add", "--flow", "plugin-one", "--schedule", "every minute"], now),
    ).rejects.toThrow(/schedule: expected five fields/);
  });

  test("the list shows the last run's result and run id", async () => {
    const home = await scheduleHome();
    const now = { value: Date.parse("2026-01-01T07:00:00Z") };
    await run(home, ["add", "--flow", "plugin-one", "--schedule", "0 8 * * *"], now);
    const id = (await list(home, now))[0]?.id ?? "";
    const config = await readConfig(home);
    const log = openConfigLog(config);
    try {
      const key = `${id}:2026-01-01T08:00:00.000Z`;
      const input = await log.recordInput(null, "cron", key, {
        source: "cron",
        key,
        type: "tick",
        hops: 0,
      });
      const runInfo = await log.startRun("plugin-one", "job:1", input.inputId);
      await log.append(runInfo.runId, 0, [
        {
          kind: "run_ended",
          payload: { status: "failed", reason: "the step failed" },
          cause: "test",
        },
      ]);
      await log.endRun(runInfo.runId);
      const entries = await list(home, now);
      expect(entries[0]?.lastRun).toMatchObject({
        runId: runInfo.runId,
        result: "failed",
        reason: "the step failed",
      });
    } finally {
      await log.close();
    }
  });
});
