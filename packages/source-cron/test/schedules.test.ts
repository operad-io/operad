import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
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
