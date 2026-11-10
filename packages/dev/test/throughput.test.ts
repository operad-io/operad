import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { FilePluginStore, type ViewContext } from "@operad-io/engine";
import { addPlan, addRepository, addTask, findRepository, getTask } from "../src/service.ts";
import { taskData, type TaskData } from "../src/model.ts";
import { percentile, repositoryMetrics } from "../src/throughput.ts";
import { repoViews } from "../src/views.ts";
import { cleanupTempRoots, makeGitRepository, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 2026-11-09 14:30 UTC. */
const NOW = Date.UTC(2026, 10, 9, 14, 30);

type Segments = { step: string; person: boolean; from: number; to: number | null }[];

async function world() {
  const root = await tempRoot();
  const path = await makeGitRepository(root);
  let clock = NOW - 8 * DAY;
  const store = new FilePluginStore({ root: join(root, "store"), clock: () => clock });
  const repository = await addRepository(store, { path });
  const plan = await addPlan(store, { repository, slug: "p", title: "P", request: "r" });
  const runs = new Map<string, Segments>();
  const ctx = {
    store,
    runTimes: async (id: string) => {
      const segments = runs.get(id);
      return segments === undefined
        ? undefined
        : { startedAt: segments[0]?.from ?? 0, endedAt: null, segments };
    },
  } as unknown as ViewContext;
  let count = 0;
  /** A task that writes the given facts, each at its own time, and ends merged at `mergedAt`. */
  async function merged(options: {
    mergedAt: number;
    cost?: number;
    attempts?: number;
    segments?: Segments;
    waitingFor?: { step: string; attempt: Record<string, unknown> }[];
    queuedFrom?: number;
    /** A later write of the task (a cleanup), long after it merged. */
    touchedAt?: number;
    /** A second write of a task that is still waiting, by another step. */
    repeatWaiting?: boolean;
  }): Promise<void> {
    count += 1;
    const slug = `t${count}`;
    const task = await addTask(store, { plan: plan.id, slug, title: slug, brief: "b" });
    const base: TaskData = taskData((await getTask(store, task.id)).data);
    const run = `run-${count}`;
    if (options.segments !== undefined) runs.set(run, options.segments);
    const put = async (at: number, cause: string, data: Record<string, unknown>) => {
      clock = at;
      await store.put("task", task.id, { ...base, run, ...data }, cause);
    };
    const first = options.mergedAt - 3 * HOUR;
    await put(first, "test:start", { phase: "running", attempt: { number: 1, run } });
    for (const [index, stop] of (options.waitingFor ?? []).entries()) {
      await put(first + (index + 1) * 1000, `dev:${stop.step}`, {
        phase: "waiting",
        attempt: { number: 1, run, ...stop.attempt },
      });
      if (options.repeatWaiting === true) {
        await put(first + (index + 1) * 1000 + 250, "dev:note", {
          phase: "waiting",
          attempt: { number: 1, run },
        });
      }
      await put(first + (index + 1) * 1000 + 500, "test:resume", { phase: "running", attempt: { number: 1, run } });
    }
    if (options.queuedFrom !== undefined) {
      await put(options.queuedFrom, "dev:integrate", {
        phase: "running",
        attempt: { number: options.attempts ?? 1, run, integrationWait: "T-0001 is integrating" },
      });
      await put(options.queuedFrom + 4 * 60_000, "dev:integrate", {
        phase: "running",
        attempt: { number: options.attempts ?? 1, run, integrating: run },
      });
    }
    await put(options.mergedAt, "dev:integrate", {
      phase: "merged",
      attempts: options.attempts ?? 1,
      ...(options.cost === undefined ? {} : { cost: options.cost }),
      attempt: { number: options.attempts ?? 1, run },
    });
    if (options.touchedAt !== undefined) {
      await put(options.touchedAt, "dev:cleanup", {
        phase: "merged",
        attempt: { number: options.attempts ?? 1, run },
      });
    }
  }
  return { store, repository, ctx, merged };
}

describe("repository metrics", () => {
  test("an empty repository shows an empty-state line", async () => {
    const { ctx, store, repository } = await world();
    const object = await findRepository(store, repository.name);
    if (object === undefined) throw new Error("no repository");
    expect(await repositoryMetrics(ctx, object, NOW)).toBe("_No merged tasks in the last 7 days._");
    expect(repoViews.sections(object).map((section) => section.id)).toEqual(["overview", "metrics"]);
  });

  test("counts per hour and per day, cost per merge, and step times", async () => {
    const w = await world();
    const MIN = 60_000;
    const seg = (step: string, from: number, to: number, person = false) => ({ step, person, from, to });
    const at = (hoursAgo: number) => NOW - hoursAgo * HOUR;
    // 14:30 now: the 14:00 hour holds 14:10 and 14:20; 13:00 holds one; 11-08 holds two; 11-02 is out of the window.
    await w.merged({
      mergedAt: Date.UTC(2026, 10, 9, 14, 10), cost: 1,
      segments: [seg("work", 0, 10 * MIN), seg("verify", 10 * MIN, 20 * MIN), seg("review", 20 * MIN, 30 * MIN),
        seg("work", 30 * MIN, 40 * MIN, true), seg("integrate", 40 * MIN, 60 * MIN)],
      queuedFrom: Date.UTC(2026, 10, 9, 14, 0),
      waitingFor: [{ step: "review", attempt: { review: { result: "findings", findings: [{}, {}] } } }],
    });
    await w.merged({
      mergedAt: Date.UTC(2026, 10, 9, 14, 20), cost: 3, attempts: 3, repeatWaiting: true,
      segments: [seg("work", 0, 30 * MIN), seg("verify", 0, 30 * MIN), seg("review", 0, 30 * MIN), seg("integrate", 0, 10 * MIN)],
      waitingFor: [
        { step: "review", attempt: { review: { result: "findings", findings: [{}] } } },
        { step: "integrate", attempt: { integration: { result: "conflict" } } },
      ],
    });
    await w.merged({ mergedAt: Date.UTC(2026, 10, 9, 13, 5), segments: [seg("work", 0, 50 * MIN)] });
    await w.merged({ mergedAt: Date.UTC(2026, 10, 8, 9, 0), cost: 2, segments: [seg("work", 0, 20 * MIN)] });
    await w.merged({ mergedAt: Date.UTC(2026, 10, 8, 23, 59), cost: 2 });
    // Merged 8 days ago and written again a minute ago: it is not in the window.
    await w.merged({ mergedAt: at(8 * 24), touchedAt: NOW - 60_000, cost: 9 });
    const object = await findRepository(w.store, w.repository.name);
    if (object === undefined) throw new Error("no repository");
    const text = await repositoryMetrics(w.ctx, object, NOW);
    const rows = text.split("\n");
    expect(text).toContain("**Last 24 hours** 4 merged");
    expect(rows).toContain("| 11-09 14:00 | 2 | $2.00 |");
    expect(rows).toContain("| 11-09 13:00 | 1 | - |");
    expect(rows).toContain("| 11-09 12:00 | 0 | - |");
    expect(rows).toContain("| 11-08 23:00 | 1 | $2.00 |");
    expect(rows.filter((row) => /^\| 11-\d\d \d\d:00 \|/.test(row))).toHaveLength(24);
    expect(text).toContain("**Last 7 days** 5 merged");
    expect(rows).toContain("| 2026-11-09 | 3 | $2.00 |");
    expect(rows).toContain("| 2026-11-08 | 2 | $2.00 |");
    expect(rows).toContain("| 2026-11-03 | 0 | - |");
    expect(rows.filter((row) => /^\| 2026-11-\d\d \|/.test(row))).toHaveLength(7);
    // Work: 10m, 30m, 50m, 20m (the fifth has no run on record). Nearest rank: median 20m, p90 50m.
    expect(rows).toContain("| work | 20m | 50m |");
    expect(rows).toContain("| verify | 0s | 30m |");
    // The first task waited 10 minutes for a person; the others none.
    expect(rows).toContain("| wait for a person | 0s | 10m |");
    // 4 minutes of the first task's 20-minute integrate was waiting for its turn.
    expect(rows).toContain("| waiting to integrate | 0s | 4m |");
    expect(rows).toContain("| integrate | 0s | 16m |");
    expect(rows).toContain("| rework rounds | 0 | 2 |");
    expect(text).toContain("_Times are from 4 of 5 tasks; the others have no run on record._");
    // Two of five stopped for a person; review findings count once per task.
    expect(text).toContain("**Stopped for a person** 2 of 5 tasks (40%)");
    expect(rows).toContain("| review: findings | 2 |");
    expect(rows).toContain("| conflict | 1 |");
    // A write of a task that is already waiting is not a new stop.
    expect(text).not.toContain("| note |");
  });

  test("a home with 300 merged tasks opens well under the section limit", async () => {
    const w = await world();
    const seg = (step: string, from: number, to: number) => ({ step, person: false, from, to });
    for (let i = 0; i < 300; i += 1) {
      await w.merged({
        mergedAt: NOW - (i % 150) * HOUR - 1000,
        cost: 0.5,
        segments: [seg("work", 0, 60_000), seg("verify", 60_000, 120_000)],
      });
    }
    const object = await findRepository(w.store, w.repository.name);
    if (object === undefined) throw new Error("no repository");
    const started = performance.now();
    const text = await repositoryMetrics(w.ctx, object, NOW);
    const elapsed = performance.now() - started;
    expect(text).toContain("**Last 7 days** 300 merged");
    expect(elapsed).toBeLessThan(5000);
  }, 120_000);

  test("percentiles use the nearest rank", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
  });
});
