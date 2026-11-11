import { afterAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { openLog } from "../src/index.ts";
import { inputIdFor } from "../src/log/facts.ts";
import { cleanupTempRoots, tempRoot } from "./plugin/support.ts";

afterAll(cleanupTempRoots);

const HISTORY = 3000;

describe("the jsonl backend over a large history", () => {
  test("a lookup or a quiet read does not read the whole files", async () => {
    const root = await tempRoot();
    const log = openLog({ backend: "jsonl", path: join(root, "store") });
    try {
      for (let index = 0; index < HISTORY; index += 1) {
        await log.recordInput(null, "manual", `k-${index}`, { n: index });
        await log.recordOutcome(inputIdFor("manual", `k-${index}`), "route", { value: "none" });
      }
      const inputs = await log.readInputsAfter(0);
      expect(inputs.inputs).toHaveLength(HISTORY);
      const outcomes = await log.readOutcomesAfter(0);
      expect(outcomes).toHaveLength(HISTORY);
      const lastSeq = outcomes[outcomes.length - 1]?.seq ?? 0;
      // Warm: the first lookup may load its index.
      await log.findInput(inputIdFor("manual", "k-5"));

      const whole = spyOn(fs, "readFileSync");
      try {
        expect((await log.findInput(inputIdFor("manual", "k-1234")))?.payload).toEqual({ n: 1234 });
        expect((await log.findInput(inputIdFor("manual", "k-0")))?.payload).toEqual({ n: 0 });
        expect((await log.readInputsAfter(inputs.position)).inputs).toEqual([]);
        // A quiet outcome read must not walk the remembered outcomes.
        const walked = spyOn(Map.prototype, "values");
        try {
          expect(await log.readOutcomesAfter(lastSeq)).toEqual([]);
          expect(walked).not.toHaveBeenCalled();
        } finally {
          walked.mockRestore();
        }
        expect((await log.readOutcome(inputIdFor("manual", "k-77"), "route"))?.payload).toEqual({ value: "none" });
        expect(whole).not.toHaveBeenCalled();
      } finally {
        whole.mockRestore();
      }

      // Only what is new comes back.
      await log.recordOutcome(inputIdFor("manual", "k-1"), "resolve", { value: "x" });
      const fresh = await log.readOutcomesAfter(lastSeq);
      expect(fresh.map((outcome) => outcome.kind)).toEqual(["resolve"]);
    } finally {
      await log.close();
    }
  }, 120_000);

  test("listing the active runs does not open the logs of ended runs", async () => {
    const root = await tempRoot();
    const log = openLog({ backend: "jsonl", path: join(root, "store") });
    try {
      for (let index = 0; index < 200; index += 1) {
        const run = await log.startRun("old", `job:${index}`);
        await log.endRun(run.runId);
      }
      const live = await log.startRun("live", "job:live");
      const opened = spyOn(fs, "openSync");
      try {
        const active = await log.runs({ active: true });
        expect(active.map((run) => run.runId)).toEqual([live.runId]);
        expect(opened.mock.calls.length).toBeLessThanOrEqual(4);
      } finally {
        opened.mockRestore();
      }
    } finally {
      await log.close();
    }
  });

  test("a quiet listing of the active runs does not list the runs directory", async () => {
    const root = await tempRoot();
    const log = openLog({ backend: "jsonl", path: join(root, "store") });
    try {
      for (let index = 0; index < 100; index += 1) {
        const run = await log.startRun("old", `job:${index}`);
        await log.endRun(run.runId);
      }
      const live = await log.startRun("live", "job:live");
      expect((await log.runs({ active: true })).map((run) => run.runId)).toEqual([live.runId]);

      const listed = spyOn(fs, "readdirSync");
      try {
        for (let pass = 0; pass < 5; pass += 1) {
          expect(await log.runs({ active: true })).toHaveLength(1);
        }
        expect(listed).not.toHaveBeenCalled();
      } finally {
        listed.mockRestore();
      }

      // A start and an end are still seen at once.
      const second = await log.startRun("live", "job:second");
      expect((await log.runs({ active: true })).map((run) => run.runId).sort()).toEqual(
        [live.runId, second.runId].sort(),
      );
      await log.endRun(live.runId);
      expect((await log.runs({ active: true })).map((run) => run.runId)).toEqual([second.runId]);

      // Right after a change nothing is listed either.
      const afterChange = spyOn(fs, "readdirSync");
      try {
        for (let pass = 0; pass < 6; pass += 1) {
          expect(await log.runs({ active: true })).toHaveLength(1);
        }
        expect(afterChange).not.toHaveBeenCalled();
      } finally {
        afterChange.mockRestore();
      }

      // Another handle, as another process, starts and ends a run between two
      // looks; nothing about time or modification dates is involved.
      const other = openLog({ backend: "jsonl", path: join(root, "store") });
      try {
        const quick = await other.startRun("quick", "job:quick");
        await other.endRun(quick.runId);
        const kept = await other.startRun("kept", "job:kept");
        const seen = (await log.runs({ active: true })).map((run) => run.runId).sort();
        expect(seen).toEqual([second.runId, kept.runId].sort());
        await other.endRun(kept.runId);
        expect((await log.runs({ active: true })).map((run) => run.runId)).toEqual([second.runId]);
      } finally {
        await other.close();
      }
    } finally {
      await log.close();
    }
  });

  test("a quiet tick costs the same with many ended runs: directory and file calls are counted", async () => {
    const root = await tempRoot();
    let fire: () => void = () => undefined;
    const events: string[] = [];
    const log = openLog({
      backend: "jsonl",
      path: join(root, "store"),
      repeat: (_ms, callback) => {
        fire = callback;
        return () => undefined;
      },
      watch: () => () => undefined,
    });
    try {
      const sub = log.subscribe;
      if (sub === undefined) throw new Error("the jsonl backend can be subscribed to");
      for (let index = 0; index < 300; index += 1) {
        const run = await log.startRun("old", `job:${index}`);
        await log.endRun(run.runId);
      }
      const live = await log.startRun("live", "job:live");
      await log.recordInput(null, "manual", "x", { n: 1 });
      const stop = sub.call(log, (change) => events.push(change.runId));
      // Settle: the first call after a change lists the directory once.
      await log.runs({ active: true });
      fire();

      const dirs = spyOn(fs, "readdirSync");
      const stats = spyOn(fs, "statSync");
      const exists = spyOn(fs, "existsSync");
      try {
        // One quiet serve tick: the active runs, the new inputs and outcomes,
        // and the subscription poll.
        const first = await log.readInputsAfter(0);
        const quiet = async (): Promise<void> => {
          await log.runs({ active: true });
          await log.readInputsAfter(first.position);
          await log.readOutcomesAfter(0);
          fire();
        };
        await quiet();
        const small = stats.mock.calls.length + exists.mock.calls.length;
        expect(dirs).not.toHaveBeenCalled();
        for (let pass = 0; pass < 5; pass += 1) await quiet();
        expect(dirs).not.toHaveBeenCalled();
        // Five more ticks cost five times one tick, never a call per ended run.
        const per = (stats.mock.calls.length + exists.mock.calls.length) / 6;
        expect(per).toBeLessThanOrEqual(small + 1);
        expect(small).toBeLessThan(30);
      } finally {
        dirs.mockRestore();
        stats.mockRestore();
        exists.mockRestore();
      }
      expect(events).toEqual([]);

      // A real change is still reported by the poll.
      await log.endRun(live.runId);
      fire();
      expect(events).toContain(live.runId);
      stop();
    } finally {
      await log.close();
    }
  });

  test("a missing or cut runs index is rebuilt from one read of the directory", async () => {
    const root = await tempRoot();
    const log = openLog({ backend: "jsonl", path: join(root, "store") });
    try {
      for (let index = 0; index < 20; index += 1) {
        const run = await log.startRun("old", `job:${index}`);
        await log.endRun(run.runId);
      }
      const live = await log.startRun("live", "job:live");
      const indexPath = join(root, "store", "runs.index");
      // Cut the index in the middle of a line, then remove it altogether.
      fs.truncateSync(indexPath, 7);
      expect((await log.runs({ active: true })).map((run) => run.runId)).toEqual([live.runId]);
      fs.rmSync(indexPath);
      expect((await log.runs({ active: true })).map((run) => run.runId)).toEqual([live.runId]);
      const reopened = openLog({ backend: "jsonl", path: join(root, "store") });
      try {
        expect((await reopened.runs({ active: true })).map((run) => run.runId)).toEqual([live.runId]);
      } finally {
        await reopened.close();
      }
    } finally {
      await log.close();
    }
  });
});
