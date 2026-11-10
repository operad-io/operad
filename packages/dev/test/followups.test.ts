import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { collectFollowups, followupMark, followupTestHooks } from "../src/followups.ts";
import { bareId, changeClock, listAll, taskData, type ReviewNotes, type TaskData } from "../src/model.ts";
import { addPlan, addRepository, addTask, cancelTask, confirmPlan } from "../src/service.ts";
import { validateDevSettings } from "../src/settings.ts";
import { cleanupTempRoots, guardLockHandles, makeGitRepository, storeAt, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);
afterEach(() => {
  followupTestHooks.afterPropose = undefined;
  changeClock.now = () => Date.now();
});
guardLockHandles();

const CHILD = fileURLToPath(new URL("./fixtures/followups-crash-child.ts", import.meta.url));
const SETTINGS = validateDevSettings({});

function note(severity: string, file: string, line: number, summary: string) {
  return { severity, file, line, summary };
}

async function setup() {
  const root = await tempRoot();
  const store = storeAt(root);
  const path = await makeGitRepository(root);
  const repository = await addRepository(store, { path, name: "demo" });
  const plan = await addPlan(store, { repository, slug: "main", title: "Main" });
  const seed = await addTask(store, { plan: plan.id, slug: "seed", title: "seed" });
  await confirmPlan(store, plan.id);
  await cancelTask(store, seed.id);
  const collect = (settings = SETTINGS) => collectFollowups(store, "demo", settings);
  /** Adds a task and puts it in the phase, with notes and, for a merged one, the mark. */
  const task = async (
    slug: string,
    phase: TaskData["phase"],
    notes: readonly ReviewNotes[] = [],
    mergedAt = 0,
  ) => {
    const object = await addTask(store, { plan: plan.id, slug, title: slug });
    const data = taskData(object.data);
    await store.put(
      "task",
      object.id,
      {
        ...data,
        phase,
        ...(notes.length === 0 ? {} : { reviewNotes: notes }),
        ...(phase === "merged" && notes.length > 0 ? { followups: { mergedAt, state: "collect" } } : {}),
      },
      "test",
    );
    return bareId(object.id);
  };
  const all = async () => (await listAll(store, "task")).map((object) => ({ id: bareId(object.id), data: taskData(object.data) }));
  const followupTasks = async () => (await all()).filter((entry) => entry.data.followupOf !== undefined);
  return { root, store, plan, collect, task, all, followupTasks };
}

describe("review follow-ups", () => {
  test("collects the findings of every round and task, deduplicated, grouped by task, duplicates kept once within a task", async () => {
    const s = await setup();
    const a = await s.task(
      "alpha",
      "merged",
      [
        { attempt: 1, round: 1, findings: [note("minor", "a.ts", 3, "naming"), note("major", "b.ts", 9, "old bug")] },
        { attempt: 1, round: 2, findings: [note("minor", "a.ts", 3, "naming  ")] },
        { attempt: 2, round: 1, findings: [note("minor", "c.ts", 1, "typo")] },
      ],
      100,
    );
    const b = await s.task(
      "beta",
      "merged",
      [{ attempt: 1, round: 1, findings: [note("minor", "a.ts", 3, "naming"), note("minor", "d.ts", 4, "spacing")] }],
      200,
    );
    const proposed = await s.collect();
    expect(proposed).toHaveLength(1);
    const [followup] = await s.followupTasks();
    const data = followup?.data;
    expect(data?.phase).toBe("proposed");
    expect(data?.title).toBe(`Follow-ups from ${bareId(s.plan.id)}'s reviews`);
    expect(followup?.id).toMatch(/^T-\d{4}-main-followups$/);
    expect(data?.after).toEqual([a, b]);
    const brief = data?.brief ?? "";
    expect(brief).toContain(`[major] b.ts:9 old bug (round 1)`);
    expect(brief).toContain(`[minor] c.ts:1 typo (round 1)`);
    expect(brief).toContain(`[minor] d.ts:4 spacing (round 1)`);
    // once within a task, again for the other task
    expect(brief.match(/a\.ts:3 naming/g)).toHaveLength(2);
    // the newest copy of a repeated finding, with its own round
    expect(brief).toContain("[minor] a.ts:3 naming (round 2)");
    expect(brief.indexOf(`## From ${a}`)).toBeLessThan(brief.indexOf(`## From ${b}`));
    expect(brief.indexOf("d.ts:4")).toBeGreaterThan(brief.indexOf(`## From ${b}`));
    expect(brief.indexOf("c.ts:1")).toBeLessThan(brief.indexOf(`## From ${b}`));
    expect(brief).toContain("Fix what still applies, and say which of them no longer apply.");
  });

  test("a leading tag that repeats the level does not make a finding different, and prints once", async () => {
    const s = await setup();
    const a = await s.task(
      "tagged",
      "merged",
      [
        { attempt: 1, round: 1, findings: [note("minor", "a.ts", 3, "naming")] },
        { attempt: 1, round: 2, findings: [note("minor", "a.ts", 3, "[Minor]  naming"), note("minor", "a.ts", 3, "[major] naming")] },
      ],
      1,
    );
    await s.collect();
    const brief = (await s.followupTasks())[0]?.data.brief ?? "";
    expect(brief.match(/\[minor\] a\.ts:3 naming \(round 2\)/g)).toHaveLength(1);
    expect(brief).not.toMatch(/\[minor\] a\.ts:3 \[minor\]/i);
    expect(brief).toContain("[minor] a.ts:3 [major] naming (round 2)");
    expect(brief).toContain(`## From ${a}`);
  });

  test("the merge order, not the id order, orders after", async () => {
    const s = await setup();
    const n = [{ attempt: 1, round: 1, findings: [note("minor", "a.ts", 1, "x")] }];
    const first = await s.task("first", "merged", n, 300);
    const second = await s.task("second", "merged", [{ attempt: 1, round: 1, findings: [note("minor", "b.ts", 1, "y")] }], 100);
    await s.collect();
    expect((await s.followupTasks())[0]?.data.after).toEqual([second, first]);
  });

  test("nothing is proposed while a task is open", async () => {
    const s = await setup();
    const n = [{ attempt: 1, round: 1, findings: [note("minor", "a.ts", 1, "x")] }];
    await s.task("done", "merged", n, 1);
    for (const phase of ["ready", "running", "review", "waiting", "paused"] as const) {
      const open = await s.task(`open-${phase}`, phase);
      expect(await s.collect()).toEqual([]);
      await cancelTask(s.store, `demo/${open}`);
    }
    expect(await s.followupTasks()).toHaveLength(0);
    expect(await s.collect()).toHaveLength(1);
  });

  test("one follow-up per collection; a task is collected once, even when its follow-up is cancelled", async () => {
    const s = await setup();
    const n = [{ attempt: 1, round: 1, findings: [note("minor", "a.ts", 1, "x")] }];
    await s.task("one", "merged", n, 1);
    expect(await s.collect()).toHaveLength(1);
    expect(await s.collect()).toHaveLength(0);
    const [followup] = await s.followupTasks();
    await cancelTask(s.store, `demo/${followup?.id}`);
    expect(await s.collect()).toHaveLength(0);
    expect(await s.followupTasks()).toHaveLength(1);
  });

  test("the slug takes -2 and -3 when taken", async () => {
    const s = await setup();
    const n = [{ attempt: 1, round: 1, findings: [note("minor", "a.ts", 1, "x")] }];
    for (const expected of ["main-followups", "main-followups-2", "main-followups-3"]) {
      await s.task(`work-${expected.length}`, "merged", n, 1);
      await s.collect();
      const latest = (await s.followupTasks()).map((entry) => entry.id).sort().at(-1);
      expect(latest).toMatch(new RegExp(`${expected}$`));
      await cancelTask(s.store, `demo/${latest}`);
    }
  });

  test("a follow-up is not collected", async () => {
    const s = await setup();
    const n: ReviewNotes[] = [{ attempt: 1, round: 1, findings: [note("minor", "a.ts", 1, "x")] }];
    await s.task("one", "merged", n, 1);
    await s.collect();
    const [followup] = await s.followupTasks();
    const merged: TaskData = {
      ...(followup?.data as TaskData),
      phase: "merged",
      reviewNotes: [{ attempt: 1, round: 1, findings: [note("minor", "z.ts", 1, "own finding")] }],
      ...followupMark({ ...(followup?.data as TaskData), reviewNotes: n }, SETTINGS),
    };
    expect(merged.followups).toBeUndefined();
    await s.store.put("task", `demo/${followup?.id}`, merged, "test");
    expect(await s.collect()).toHaveLength(0);
    expect(await s.followupTasks()).toHaveLength(1);
  });

  test("followups false turns the mark and the collection off", async () => {
    const s = await setup();
    const off = validateDevSettings({ reviewer: { followups: false } });
    const id = await s.task("one", "merged", [{ attempt: 1, round: 1, findings: [note("minor", "a.ts", 1, "x")] }], 1);
    const task = (await s.all()).find((entry) => entry.id === id)?.data as TaskData;
    expect(followupMark(task, off)).toEqual({});
    expect(followupMark({ ...task, followups: undefined }, SETTINGS).followups?.state).toBe("collect");
    expect(await s.collect(off)).toEqual([]);
    expect(await s.followupTasks()).toHaveLength(0);
  });

  test("a task without findings, or merged before the mark existed, is never collected", async () => {
    const s = await setup();
    const object = await addTask(s.store, { plan: s.plan.id, slug: "old", title: "old" });
    await s.store.put(
      "task",
      object.id,
      { ...taskData(object.data), phase: "merged", reviewNotes: [{ attempt: 1, round: 1, findings: [note("minor", "a.ts", 1, "x")] }] },
      "test",
    );
    expect(await s.collect()).toEqual([]);
    expect(followupMark({ ...taskData(object.data), reviewNotes: [{ attempt: 1, round: 1, findings: [] }] }, SETTINGS)).toEqual({});
  });

  test("a crash between the proposal and the marks proposes exactly one", async () => {
    const s = await setup();
    await s.task("one", "merged", [{ attempt: 1, round: 1, findings: [note("minor", "a.ts", 1, "x")] }], 1);
    const child = Bun.spawn({
      cmd: [process.execPath, CHILD, `${s.root}/store`, "demo"],
      stdout: "pipe",
      stderr: "pipe",
    });
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    expect(await s.followupTasks()).toHaveLength(1);
    // The follow-up is only proposed, so no task is open: without the repair
    // the next call would propose a second one.
    expect(await s.collect()).toEqual([]);
    expect(await s.collect()).toEqual([]);
    expect(await s.followupTasks()).toHaveLength(1);
  });
});
