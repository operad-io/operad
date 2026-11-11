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
});
