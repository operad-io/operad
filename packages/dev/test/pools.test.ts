import { describe, expect, test } from "bun:test";
import { DevError } from "../src/model.ts";
import {
  DEFAULT_DEV_SETTINGS,
  flowPool,
  poolCap,
  poolWorkers,
  repositoryTaskCap,
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

describe("pool caps and the work stage's pool (T-0379)", () => {
  const codex = { use: "harness-codex/agent", count: 3 };
  const workers = { claude, pi, codex };

  test("a pool may be an object with workers and concurrency; the list form stays valid", () => {
    const settings = validateDevSettings({
      workers,
      pools: { default: ["claude", "pi"], image: { workers: ["codex"], concurrency: 2 } },
    });
    expect(poolWorkers(settings, "image").map((worker) => worker.name)).toEqual(["codex"]);
    expect(settings.workers.pools).toEqual({ default: ["claude", "pi"], image: ["codex"] });
  });

  test("a pool's cap is its workers' counts, or its concurrency when smaller", () => {
    const settings = validateDevSettings({
      workers,
      pools: {
        default: ["claude", "pi"],
        image: { workers: ["codex"], concurrency: 2 },
        big: { workers: ["codex"], concurrency: 10 },
      },
    });
    expect(poolCap(settings, "default")).toBe(3);
    expect(poolCap(settings, "image")).toBe(2);
    expect(poolCap(settings, "big")).toBe(3);
  });

  test("each pool is capped alone; the repository's concurrency caps them together", () => {
    const pools = { default: ["claude"], image: ["codex"] };
    const open = validateDevSettings({ workers, pools });
    expect(runningTaskCap(open, "default")).toBe(2);
    expect(runningTaskCap(open, "image")).toBe(3);
    expect(repositoryTaskCap(open)).toBe(5);
    const capped = validateDevSettings({ workers, pools, concurrency: 4 });
    expect(runningTaskCap(capped, "image")).toBe(3);
    expect(repositoryTaskCap(capped)).toBe(4);
    expect(runningTaskCap(validateDevSettings({ workers, pools, concurrency: 2 }), "image")).toBe(2);
  });

  test("a bad pool object is refused with its field", () => {
    expect(refusal({ workers, pools: { default: { workers: ["claude"], concurrency: 0 } } }).field).toBe(
      "pools.default.concurrency",
    );
    expect(refusal({ workers, pools: { default: { workers: ["nope"] } } }).field).toBe(
      "pools.default.workers[0]",
    );
    expect(refusal({ workers, pools: { default: { workers: [], concurrency: 1 } } }).field).toBe(
      "pools.default.workers",
    );
    expect(refusal({ workers, pools: { default: { workers: ["claude"], extra: 1 } } }).field).toBe(
      "pools.default.extra",
    );
  });

  test("a work stage's pool is read, and an unknown pool is refused with the field named", () => {
    const stages = (pool: string) => ({ flows: { image: { stages: [{ stage: "work", pool }, { stage: "human" }] } } });
    const settings = validateDevSettings({
      workers,
      pools: { default: ["claude"], image: ["codex"] },
      ...stages("image"),
    });
    expect(flowPool(settings, "image")).toBe("image");
    expect(flowPool(settings, "default")).toBe("default");
    expect(flowPool(settings, undefined)).toBe("default");
    const error = refusal({ workers, pools: { default: ["claude"] }, ...stages("ghost") });
    expect(error.field).toBe("flows.image.stages[0].pool");
    expect(error.message).toContain("ghost");
    expect(refusal({ workers, ...stages("") }).field).toBe("flows.image.stages[0].pool");
  });

  test("a flow's pool is its first work stage's", () => {
    const settings = validateDevSettings({
      workers,
      pools: { default: ["claude"], image: ["codex"] },
      flows: {
        two: { stages: [{ stage: "work", pool: "image" }, { stage: "work" }, { stage: "human" }] },
      },
    });
    expect(flowPool(settings, "two")).toBe("image");
  });
});
