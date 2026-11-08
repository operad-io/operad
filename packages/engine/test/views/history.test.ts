import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  formatHistoryEntry,
  historyEntries,
  openLog,
  runHistoryLines,
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

  test("a step that stopped with an unexpected result says what it reported", async () => {
    const facts = [
      fact(
        "step_interrupted",
        { step: "work", effectId: "work:1", reason: "undeclared_result", result: "failed", message: "boom" },
        1,
      ),
    ];
    const lines: string[] = [];
    for await (const entry of historyEntries(from(facts))) lines.push(formatHistoryEntry(entry));
    expect(lines[0]).toContain("boom");
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

const at = (day: number, h: number, m: number, sec: number): number =>
  new Date(2026, 10, day, h, m, sec).getTime();

function timed(kind: string, payload: object, time: number): Fact {
  return { runId: "run-1", seq: 1, kind, payload: payload as Fact["payload"], cause: "test", time };
}

const LONG = `packages/dev/src/gate.ts:1059 major ${"detail ".repeat(40)}`;

describe("readable run history", () => {
  const facts: Fact[] = [
    timed("run_started", { flow: "dev" }, at(8, 21, 38, 41)),
    timed("step_entered", { step: "worktree", visit: 1, kind: "plugin" }, at(8, 21, 38, 41)),
    timed("step_result", { step: "worktree", result: "ready", data: {} }, at(8, 21, 38, 42)),
    timed("edge_taken", { step: "worktree", result: "ready", target: "work" }, at(8, 21, 38, 42)),
    timed("step_entered", { step: "work", visit: 1, kind: "plugin" }, at(8, 21, 38, 44)),
    timed("step_result", { step: "work", result: "done", data: {} }, at(8, 22, 19, 44)),
    timed("edge_taken", { step: "work", result: "done", target: "review" }, at(8, 22, 19, 44)),
    timed("step_entered", { step: "review", visit: 1, kind: "plugin" }, at(8, 22, 20, 1)),
    timed("step_result", { step: "review", result: "fail", data: { message: LONG } }, at(8, 22, 20, 59)),
    timed("edge_taken", { step: "review", result: "fail", target: "work" }, at(8, 22, 21, 0)),
    timed("step_entered", { step: "work", visit: 2, kind: "plugin" }, at(8, 22, 21, 1)),
    timed("step_result", { step: "work", result: "done", data: {} }, at(8, 22, 22, 1)),
    timed("edge_taken", { step: "work", result: "done", target: "confirm" }, at(8, 22, 22, 1)),
    timed("step_entered", { step: "confirm", visit: 1, kind: "wait_person" }, at(8, 22, 22, 2)),
    timed("waiting_for_person", { waitId: "w", step: "confirm", prompt: "Merge?", choices: ["merge"] }, at(8, 22, 22, 2)),
    timed("person_answered", { waitId: "w", step: "confirm", choice: "merge", note: null, actor: { via: "plugin", id: "dev" } }, at(8, 22, 30, 2)),
    timed("step_result", { step: "confirm", result: "reverify", data: {} }, at(8, 22, 30, 3)),
    timed("edge_taken", { step: "confirm", result: "reverify", target: "verify" }, at(8, 22, 30, 3)),
    timed("step_entered", { step: "verify", visit: 1, kind: "plugin" }, at(8, 22, 30, 4)),
    timed("trigger_received", { source: "git", type: "push", summary: "pushed" }, at(9, 0, 10, 0)),
  ];
  const now = at(9, 0, 12, 4);

  test("one line per step attempt with time, outcome and duration", () => {
    const lines = runHistoryLines(facts, { now, full: false });
    expect(lines[0]).toBe("**2026-11-08**");
    expect(lines[1]).toBe("21:38:41  worktree  ready  1s");
    expect(lines[2]).toBe("21:38:44  work  done  41m");
    expect(lines.filter((line) => line.includes("  work  "))).toHaveLength(2);
    expect(lines.join("\n")).not.toContain("moving to");
    expect(lines.join("\n")).not.toContain("started work");
  });

  test("a rework and a reverify show why the step started", () => {
    const lines = runHistoryLines(facts, { now, full: false });
    expect(lines).toContain("22:21:01  work  attempt 2  after fail  done  1m");
    expect(lines.some((line) => line.startsWith("22:30:04  verify  after reverify  running  "))).toBe(true);
  });

  test("a running step shows how long so far, a person's answer keeps its line", () => {
    const lines = runHistoryLines(facts, { now, full: false });
    expect(lines).toContain("22:30:04  verify  after reverify  running  1h 42m");
    expect(lines).toContain("22:22:02  confirm  reverify  8m");
    expect(lines).toContain("22:30:02  you chose merge: via plugin, as dev");
  });

  test("a new day gets a date line", () => {
    const lines = runHistoryLines(facts, { now, full: false });
    const index = lines.indexOf("**2026-11-09**");
    expect(index).toBeGreaterThan(0);
    expect(lines[index + 1]).toStartWith("00:10:00  event push from git");
  });

  test("details are cut to one line, and --full keeps them", () => {
    const short = runHistoryLines(facts, { now, full: false });
    const review = short.find((line) => line.includes("  review  "));
    expect(review).toStartWith("22:20:01  review  fail  58s  packages/dev/src/gate.ts:1059 major");
    expect(review?.endsWith("…")).toBe(true);
    const full = runHistoryLines(facts, { now, full: true });
    expect(full.find((line) => line.includes("  review  "))).toContain(LONG.trim());
  });

  test("no internal words", () => {
    for (const line of runHistoryLines(facts, { now, full: false })) assertUserWords(line);
  });

  test("a run that ends on an end step has no line for that step", () => {
    const lines = runHistoryLines(
      [
        timed("step_entered", { step: "work", visit: 1, kind: "plugin" }, at(8, 9, 0, 0)),
        timed("step_result", { step: "work", result: "done", data: {} }, at(8, 9, 0, 5)),
        timed("edge_taken", { step: "work", result: "done", target: "end_done" }, at(8, 9, 0, 5)),
        timed("step_entered", { step: "end_done", visit: 1, kind: "end" }, at(8, 9, 0, 5)),
        timed("run_ended", { status: "done", reason: null }, at(8, 9, 0, 5)),
      ],
      { now: at(8, 9, 1, 0), full: false },
    );
    expect(lines).toEqual(["**2026-11-08**", "09:00:00  work  done  5s", "09:00:05  run done"]);
  });
});
