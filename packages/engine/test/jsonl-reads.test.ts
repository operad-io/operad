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
    let now = Date.now();
    const log = openLog({ backend: "jsonl", path: join(root, "store"), clock: () => now });
    try {
      for (let index = 0; index < 100; index += 1) {
        const run = await log.startRun("old", `job:${index}`);
        await log.endRun(run.runId);
      }
      const live = await log.startRun("live", "job:live");
      now += 60_000;
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
    } finally {
      await log.close();
    }
  });
});
