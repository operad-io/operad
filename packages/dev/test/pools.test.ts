import { describe, expect, test } from "bun:test";
import { DevError } from "../src/model.ts";
import {
  DEFAULT_DEV_SETTINGS,
  poolWorkers,
  runningTaskCap,
  validateDevSettings,
} from "../src/settings.ts";

const claude = { use: "claude/agent", args: ["--model", "sonnet"], count: 2 };
const pi = { use: "pi/agent", wallTimeSecs: 7200 };

function refusal(value: unknown): DevError {
  try {
    validateDevSettings(value);
  } catch (error) {
    if (error instanceof DevError) return error;
    throw error;
  }
  throw new Error("the settings were accepted");
}

describe("dev.json workers and pools", () => {
  test("workers and pools are parsed with the pool plugin's defaults", () => {
    const settings = validateDevSettings({
      workers: { claude, pi },
      pools: { default: ["pi", "claude"], design: ["claude"] },
    });
    expect(poolWorkers(settings, "default").map((worker) => worker.name)).toEqual(["pi", "claude"]);
    expect(settings.workers.workers[1]).toMatchObject({ name: "pi", count: 1, args: [], wallTimeSecs: 7200 });
    expect(settings.worker.use).toBe("pi/agent");
  });

  test("without pools every worker is in default", () => {
    const settings = validateDevSettings({ workers: { claude, pi } });
    expect(settings.workers.pools).toEqual({ default: ["claude", "pi"] });
  });

  test("the old worker is one worker named after its harness, with count = concurrency", () => {
    const settings = validateDevSettings({
      concurrency: 3,
      worker: { use: "pi/agent", args: ["--x"], stallSecs: 30 },
    });
    expect(settings.workers.workers).toEqual([
      { name: "pi", use: "pi/agent", args: ["--x"], count: 3, stallSecs: 30 },
    ]);
    expect(settings.workers.pools).toEqual({ default: ["pi"] });
    expect(runningTaskCap(settings)).toBe(3);
  });

  test("a file with neither form keeps the default worker with one place", () => {
    const settings = validateDevSettings({});
    expect(settings.workers.workers.map((worker) => worker.use)).toEqual([DEFAULT_DEV_SETTINGS.worker.use]);
    expect(runningTaskCap(settings)).toBe(1);
  });

  test("worker and workers together refuse the file", () => {
    const error = refusal({ worker: { use: "pi/agent" }, workers: { claude } });
    expect(error.field).toBe("worker");
    expect(error.message).toContain("workers");
  });

  test("pools without workers is refused", () => {
    expect(refusal({ pools: { default: ["claude"] } }).field).toBe("pools");
  });

  test("a pool naming an unknown worker keeps the pool plugin's field path", () => {
    expect(refusal({ workers: { claude }, pools: { default: ["claude", "nope"] } }).field).toBe(
      "pools.default[1]",
    );
  });

  test("a bad worker field keeps its path", () => {
    expect(refusal({ workers: { claude: { ...claude, count: 0 } } }).field).toBe("workers.claude.count");
    expect(refusal({ workers: { claude: { ...claude, fallback: "ghost" } } }).field).toBe(
      "workers.claude.fallback",
    );
  });

  test("a pools setting without a default pool is refused", () => {
    expect(refusal({ workers: { claude }, pools: { design: ["claude"] } }).field).toBe("pools");
  });
});

describe("the running-task cap", () => {
  test("it is the sum of the default pool's counts", () => {
    const settings = validateDevSettings({
      workers: { claude, pi, codex: { use: "harness-codex/agent", count: 9 } },
      pools: { default: ["claude", "pi"], design: ["codex"] },
    });
    expect(runningTaskCap(settings)).toBe(3);
  });

  test("concurrency, when set, caps it further and never raises it", () => {
    const workers = { claude, pi };
    expect(runningTaskCap(validateDevSettings({ workers, concurrency: 2 }))).toBe(2);
    expect(runningTaskCap(validateDevSettings({ workers, concurrency: 8 }))).toBe(3);
    expect(runningTaskCap(validateDevSettings({ workers }))).toBe(3);
  });
});
