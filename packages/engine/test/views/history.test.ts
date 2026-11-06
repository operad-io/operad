import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  formatHistoryEntry,
  historyEntries,
  openLog,
  type Fact,
  type NewFact,
} from "../../src/index.ts";
import { cleanupTempRoots, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const INTERNAL = ["fact", "effect", "node", "graph", "decide"];

function assertUserWords(line: string): void {
  for (const word of INTERNAL) {
    expect(line.toLowerCase()).not.toContain(word);
  }
}

function fact(kind: string, payload: object, seq: number): Fact {
  return {
    runId: "run-1",
    seq,
    kind,
    payload: payload as Fact["payload"],
    cause: seq === 1 ? "test" : seq - 1,
    time: 1_000 + seq,
  };
}

async function* from(facts: readonly Fact[]): AsyncIterable<Fact> {
  for (const item of facts) yield item;
}

describe("history view", () => {
  test("writes each step with the reason in words", async () => {
    const facts = [
      fact("run_started", { flow: "dev" }, 1),
      fact("step_entered", { step: "verify", visit: 1, kind: "plugin" }, 2),
      fact(
        "step_result",
        {
          effectId: "verify:1",
          step: "verify",
          result: "failed",
          data: {
            reason: "`bun test` exited 1",
            log: "/tmp/verify.log",
          },
        },
        3,
      ),
      fact(
        "step_interrupted",
        { step: "worker", effectId: "worker:1", reason: "recover_unsafe", result: null },
        4,
      ),
      fact("waiting_for_person", { waitId: "ask:1", step: "ask", prompt: "Continue?", choices: ["yes"] }, 5),
      fact("person_answered", { waitId: "ask:1", step: "ask", choice: "yes", note: null }, 6),
      fact("run_ended", { status: "done", reason: null }, 7),
    ];

    const lines: string[] = [];
    for await (const entry of historyEntries(from(facts))) {
      lines.push(formatHistoryEntry(entry));
    }

    expect(lines).toHaveLength(7);
    expect(lines[2]).toContain("verify failed");
    expect(lines[2]).toContain("`bun test` exited 1, log at /tmp/verify.log");
    expect(lines[3]).toContain("cannot be replayed safely");
    expect(lines[4]).toContain("waiting for you");
    expect(lines[6]).toContain("run done");
    for (const line of lines) assertUserWords(line);
  });

  test("streams 10 000 steps without joining the log into one string", async () => {
    const root = await tempRoot();
    const log = openLog({ backend: "jsonl", path: join(root, "store") });
    try {
      const info = await log.startRun("big", "job:1");
      const batch: NewFact[] = [
        { kind: "run_started", payload: { flow: "big" }, cause: "test" },
      ];
      for (let index = 0; index < 10_000; index += 1) {
        batch.push({
          kind: "step_entered",
          payload: { step: `step-${index}`, visit: 1, kind: "plugin" },
          cause: index + 1,
        });
      }
      await log.append(info.runId, 0, batch);

      let count = 0;
      let last = "";
      for await (const entry of historyEntries(log.read(info.runId))) {
        count += 1;
        last = formatHistoryEntry(entry);
        assertUserWords(last);
      }
      expect(count).toBe(10_001);
      expect(last).toContain("step-9999");
    } finally {
      await log.close();
    }
  });

  test("an unknown step kind still prints no internal word", async () => {
    const lines = [];
    for await (const entry of historyEntries(
      from([fact("mystery", { step: "x" }, 1)]),
    )) {
      lines.push(formatHistoryEntry(entry));
    }
    expect(lines[0]).toContain("something happened");
    assertUserWords(lines[0] ?? "");
  });
});
