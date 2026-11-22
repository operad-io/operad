import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  historyEntries,
  Kernel,
  openLog,
  PluginRegistry,
  type AskRequest,
  type StepEvent,
} from "@operad-io/engine";
import { createChatPlugin } from "@operad-io/chat";
import plugin from "../../src/index.ts";
import {
  waitingPrompt,
  waitingReason,
  waitingSummary,
  type AnnounceParams,
} from "../../src/announce.ts";
import { waitChoices } from "../../src/waits.ts";
import { stepTestHooks } from "../../src/steps.ts";
import { addPlan, addRepository, addTask, getTask } from "../../src/service.ts";
import { taskData, type TaskAttempt, type TaskData } from "../../src/model.ts";
import {
  cleanupTempRoots,
  guardLockHandles,
  makeGitRepository,
  storeAt,
  tempRoot,
} from "../support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

async function setup() {
  const root = await tempRoot();
  const repositoryPath = await makeGitRepository(root);
  const store = storeAt(root);
  const repository = await addRepository(store, { path: repositoryPath });
  const plan = await addPlan(store, {
    repository,
    slug: "work",
    title: "Work",
  });
  const task = await addTask(store, { plan: plan.id, slug: "one", title: "One" });
  const storeRoot = store.root;
  const log = openLog({ path: join(storeRoot, "log", "log.sqlite") });
  const registry = new PluginRegistry([createChatPlugin(), plugin], {
    home: root,
    cwd: repositoryPath,
    store,
    storeRoot,
  });
  const kernel = new Kernel({
    log,
    registry,
    home: root,
    storeRoot,
    rules: registry.triggerRules().map((item) => item.rule),
  });
  const object = `task:${task.id}`;
  const run = await log.startRun("dev", object);
  await log.append(run.runId, 0, [
    { kind: "run_started", payload: { flow: "dev" }, cause: "seed" },
  ]);
  return { root, store, registry, kernel, log, task, runId: run.runId, object };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function becomeWaiting(
  fixture: Fixture,
  change: Partial<TaskData>,
): Promise<void> {
  const current = taskData((await getTask(fixture.store, fixture.task.id)).data);
  await fixture.store.put(
    "task",
    fixture.task.id,
    { ...current, phase: "waiting", ...change },
    "test:waiting",
  );
}

/** Runs the announce step the way the runner does, events going to the kernel. */
async function announce(
  fixture: Fixture,
  params: AnnounceParams,
): Promise<{ readonly result: string; readonly events: StepEvent[] }> {
  const events: StepEvent[] = [];
  const found = await fixture.registry.runStep("dev/announce", params, {
    runId: fixture.runId,
    object: await getTask(fixture.store, fixture.task.id),
    emit: async (pluginName, event) => {
      events.push(event);
      await fixture.kernel.emitStep(
        fixture.runId,
        pluginName,
        event,
        fixture.object,
      );
    },
  });
  return { result: found.result, events };
}

/** Runs the announce step with the question it hands to the wait. */
async function announceQuestion(
  fixture: Fixture,
  params: AnnounceParams,
): Promise<{ readonly result: string; readonly asked: readonly AskRequest[] }> {
  const asked: AskRequest[] = [];
  const found = await fixture.registry.runStep("dev/announce", params, {
    runId: fixture.runId,
    object: await getTask(fixture.store, fixture.task.id),
    asker: {
      useGrant: async () => false,
      ask: async (request) => {
        asked.push(request);
        return {
          kind: "timeout",
          waitId: "w",
          prompt: request.prompt,
          choices: request.choices ?? [],
          ...(request.choiceInfo === undefined
            ? {}
            : { choiceInfo: request.choiceInfo }),
        };
      },
    },
  });
  return { result: found.result, asked };
}

async function receivedEvents(fixture: Fixture): Promise<number> {
  let count = 0;
  for await (const input of fixture.log.readInputs()) {
    const payload = input.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const record = payload as { type?: unknown };
    if (record.type === "dev.waiting") count += 1;
  }
  return count;
}

const GOOD: TaskAttempt = { number: 1, run: "run-1", verified: "abc123" };

interface Case {
  readonly name: string;
  readonly params: AnnounceParams;
  readonly change: Partial<TaskData>;
  readonly reason: string;
  readonly summary: string;
}

const CASES: readonly Case[] = [
  {
    name: "work did nothing",
    params: { from: "work", result: "nothing" },
    change: { attempts: 1, attempt: { ...GOOD, result: "nothing" } },
    reason: "work did nothing",
    summary: "T-0001-one waiting: work did nothing",
  },
  {
    name: "work failed, with the harness's reason",
    params: { from: "work", result: "failed" },
    change: {
      attempts: 1,
      attempt: { ...GOOD, result: "failed", workNote: "model unavailable (429)" },
    },
    reason: "work failed",
    summary: "T-0001-one waiting: work failed (model unavailable (429))",
  },
  {
    name: "a stopped worktree step names the step that stopped",
    params: { from: "worktree", result: "interrupted" },
    change: {
      attempts: 1,
      brief: "body\n\n## Changes\n- created\n- waiting: verify stopped",
    },
    reason: "run stopped during verify",
    summary: "T-0001-one waiting: run stopped during verify",
  },
  {
    name: "a stopped work step",
    params: { from: "work", result: "interrupted" },
    change: { attempts: 1, attempt: GOOD },
    reason: "run stopped during work",
    summary: "T-0001-one waiting: run stopped during work",
  },
  {
    name: "a passed review is ready to merge",
    params: { from: "review", result: "pass" },
    change: {
      attempts: 1,
      attempt: { ...GOOD, review: { result: "pass", sha: "abc123" } },
    },
    reason: "ready to merge",
    summary: "T-0001-one waiting: ready to merge",
  },
  {
    name: "a review that timed out",
    params: { from: "review", result: "failed" },
    change: {
      attempts: 1,
      attempt: {
        ...GOOD,
        review: {
          result: "failed",
          reason: "invalid_json",
          message: "the harness hit its wall time",
        },
      },
    },
    reason: "review timed out twice",
    summary: "T-0001-one waiting: review timed out twice",
  },
  {
    name: "a review that did not finish",
    params: { from: "review", result: "failed" },
    change: {
      attempts: 1,
      attempt: {
        ...GOOD,
        review: {
          result: "failed",
          reason: "no_report",
          message: "the reviewer wrote no report",
        },
      },
    },
    reason: "review did not finish",
    summary: "T-0001-one waiting: review did not finish (the reviewer wrote no report)",
  },
  {
    name: "a rework that used up the automatic passes",
    params: { from: "rework", result: "ask" },
    change: {
      attempts: 1,
      reworkStreak: 3,
      attempt: {
        ...GOOD,
        rework: { run: "run-1", source: "review", streak: 3, result: "ask" },
      },
    },
    reason: "rework limit",
    summary: "T-0001-one waiting: rework limit",
  },
  {
    name: "a merge refused by the remote",
    params: { from: "integrate", result: "failed" },
    change: {
      attempts: 1,
      attempt: {
        ...GOOD,
        integration: { result: "failed", message: "push to origin was refused" },
      },
    },
    reason: "merge refused",
    summary: "T-0001-one waiting: merge refused (push to origin was refused)",
  },
  {
    name: "a merge of a head that was never verified",
    params: { from: "integrate", result: "failed" },
    change: { attempts: 1, attempt: { number: 1, run: "run-1" } },
    reason: "no verified commit",
    summary: "T-0001-one waiting: no verified commit",
  },
];

describe("dev.waiting", () => {
  for (const item of CASES) {
    test(`${item.name}: one event, once, also when the step runs again`, async () => {
      const fixture = await setup();
      try {
        await becomeWaiting(fixture, item.change);
        const first = await announce(fixture, item.params);
        expect(first.events).toEqual([
          {
            type: "dev.waiting",
            key: `T-0001-one:1:${item.reason}`,
            summary: item.summary,
            data: expect.objectContaining({
              task: "T-0001-one",
              attempt: 1,
              reason: item.reason,
            }),
          },
        ]);
        expect(first.result).toBe(
          item.reason.startsWith("run stopped") ? "interrupted" : "done",
        );
        expect(await receivedEvents(fixture)).toBe(1);

        // A crash after the event and before the step's result replays the
        // step; the key keeps the second event from counting.
        const again = await announce(fixture, item.params);
        expect(again.events).toHaveLength(1);
        expect(await receivedEvents(fixture)).toBe(1);

        // The event is in the task's history, as the run saw it.
        const lines: string[] = [];
        for await (const entry of historyEntries(fixture.log.read(fixture.runId))) {
          lines.push(`${entry.what}: ${entry.why}`);
        }
        expect(lines.some((line) => line.includes(item.summary))).toBe(true);
      } finally {
        await fixture.log.close();
      }
    });
  }

  test("a different reason on the same attempt is another event", async () => {
    const fixture = await setup();
    try {
      await becomeWaiting(fixture, {
        attempts: 1,
        attempt: { ...GOOD, result: "nothing" },
      });
      await announce(fixture, { from: "work", result: "nothing" });
      await announce(fixture, { from: "integrate", result: "failed" });
      expect(await receivedEvents(fixture)).toBe(2);
    } finally {
      await fixture.log.close();
    }
  });

  test("a task cancelled under the step announces nothing", async () => {
    const fixture = await setup();
    try {
      await becomeWaiting(fixture, { phase: "cancelled", attempts: 1 });
      const out = await announce(fixture, { from: "work", result: "nothing" });
      expect(out.result).toBe("cancelled");
      expect(out.events).toEqual([]);
    } finally {
      await fixture.log.close();
    }
  });

  test("a task still in review says it waits once its wait is announced", async () => {
    const fixture = await setup();
    try {
      await becomeWaiting(fixture, { phase: "review", attempts: 1 });
      await announce(fixture, { from: "review", result: "failed" });
      const task = taskData((await getTask(fixture.store, fixture.task.id)).data);
      expect(task.phase).toBe("waiting");
    } finally {
      await fixture.log.close();
    }
  });

  test("a store error while marking the task waiting does not stop the announcement", async () => {
    const fixture = await setup();
    try {
      await becomeWaiting(fixture, { phase: "review", attempts: 1 });
      stepTestHooks.beforeGuardedWrite = async () => {
        throw new Error("database is locked");
      };
      let out: Awaited<ReturnType<typeof announce>>;
      try {
        out = await announce(fixture, { from: "review", result: "failed" });
      } finally {
        stepTestHooks.beforeGuardedWrite = undefined;
      }
      expect(out.events).toHaveLength(1);
      const task = taskData((await getTask(fixture.store, fixture.task.id)).data);
      expect(task.phase).toBe("review");
    } finally {
      await fixture.log.close();
    }
  });

  test("the plugin ships an observe rule for the event", () => {
    const rule = plugin.rules.find((item) => item.type === "dev.waiting");
    expect(rule).toMatchObject({
      source: "operad",
      mode: "observe",
      object: "$event.object",
    });
  });
});

describe("waitingPrompt", () => {
  const task = (attempt: TaskAttempt): TaskData =>
    ({
      repository: "r",
      plan: "p",
      title: "t",
      brief: "",
      after: [],
      phase: "waiting",
      attempts: 1,
      run: null,
      attempt,
    }) as TaskData;

  test("it says the review's verdict and its highest finding", () => {
    const reviewed = task({
      number: 1,
      review: {
        result: "findings",
        decision: "findings",
        findings: [
          { file: "a.ts", line: 5, severity: "minor", summary: "small", trigger: "t" },
          { file: "b.ts", line: 9, severity: "critical", summary: "breaks", trigger: "always" },
        ],
      },
      rework: { run: "r", source: "review", streak: 2, result: "ask", twice: true },
    });
    expect(
      waitingPrompt({ reason: "review failed twice in a row" }, reviewed, "major"),
    ).toContain("critical finding at b.ts:9: breaks");
    expect(
      waitingPrompt({ reason: "review findings" }, reviewed, "major"),
    ).toBe("The review failed: critical finding at b.ts:9: breaks (always).");
  });

  test("it names a failed check, a failed merge, a timeout and no change", () => {
    expect(
      waitingPrompt(
        { reason: "gate failed" },
        task({ number: 1, verify: { result: "fail", command: "bun test" } }),
        "major",
      ),
    ).toBe("The check failed: `bun test`.");
    expect(
      waitingPrompt(
        { reason: "merge refused", detail: "push was refused" },
        task({ number: 1 }),
        "major",
      ),
    ).toBe("The merge failed: push was refused.");
    expect(
      waitingPrompt(
        { reason: "work timed out", detail: "no output for 5 minutes" },
        task({ number: 1 }),
        "major",
      ),
    ).toBe("The worker timed out. no output for 5 minutes.");
    expect(
      waitingPrompt({ reason: "work did nothing" }, task({ number: 1 }), "major"),
    ).toBe("The worker changed nothing.");
    expect(
      waitingPrompt(
        { reason: "work did nothing", detail: "changed the main checkout: main (moved abc1234..def5678)" },
        task({ number: 1 }),
        "major",
      ),
    ).toBe(
      "The worker changed nothing in its worktree, but it changed the main checkout: main (moved abc1234..def5678).",
    );
    expect(
      waitingPrompt({ reason: "ready to merge" }, task({ number: 1 }), "major"),
    ).toContain("ready to merge");
  });
});

describe("the question an announce step hands over", () => {
  test("a failed work question says why, keeps the choices and names no primary", async () => {
    const fixture = await setup();
    try {
      await becomeWaiting(fixture, {
        attempts: 1,
        attempt: { number: 1, run: "run-1", result: "nothing" },
      });
      const choices = [...waitChoices("person", true)];
      const out = await announceQuestion(fixture, {
        from: "work",
        result: "nothing",
        choices,
      });
      expect(out.result).toBe("waiting");
      expect(out.asked[0]?.prompt).toBe("The worker changed nothing.");
      expect(out.asked[0]?.choices).toEqual(choices);
      expect(out.asked[0]?.choiceInfo?.merge?.role).toBeUndefined();
      expect(out.asked[0]?.choiceInfo?.rework?.note).toBe("required");
      expect(out.asked[0]?.choiceInfo?.reject?.role).toBe("destructive");
    } finally {
      await fixture.log.close();
    }
  });

  test("a review that passed asks with merge as the primary choice", async () => {
    const fixture = await setup();
    try {
      await becomeWaiting(fixture, {
        attempts: 1,
        attempt: {
          number: 1,
          run: "run-1",
          verified: "abc123",
          review: { result: "pass", sha: "abc123" },
        },
      });
      const out = await announceQuestion(fixture, {
        from: "review",
        result: "pass",
        choices: [...waitChoices("person", true)],
      });
      expect(out.result).toBe("waiting");
      expect(out.asked[0]?.prompt).toContain("ready to merge");
      expect(out.asked[0]?.choiceInfo?.merge?.role).toBe("primary");
    } finally {
      await fixture.log.close();
    }
  });

  test("a review finding is in the question's reason", async () => {
    const fixture = await setup();
    try {
      await becomeWaiting(fixture, {
        attempts: 1,
        reworkStreak: 2,
        attempt: {
          number: 1,
          run: "run-1",
          review: {
            result: "findings",
            decision: "findings",
            findings: [
              {
                file: "a.ts",
                line: 7,
                severity: "major",
                summary: "the cache is stale",
                trigger: "after a rename",
              },
            ],
          },
          rework: { run: "run-1", source: "review", streak: 2, result: "ask" },
        },
      });
      const out = await announceQuestion(fixture, {
        from: "rework",
        result: "ask",
        choices: [...waitChoices("person", true)],
      });
      expect(out.asked[0]?.prompt).toBe(
        "The review failed: major finding at a.ts:7: the cache is stale (after a rename).",
      );
      expect(out.asked[0]?.choiceInfo?.merge?.role).toBeUndefined();
    } finally {
      await fixture.log.close();
    }
  });
});

describe("waitingReason", () => {
  const task = (attempt: TaskAttempt): TaskData =>
    ({
      repository: "r",
      plan: "p",
      title: "t",
      brief: "",
      after: [],
      phase: "waiting",
      attempts: 1,
      run: null,
      attempt,
    }) as TaskData;

  test("a rework that was never allowed an automatic pass says what failed", () => {
    const edge = { from: "rework", result: "ask" };
    expect(
      waitingReason(
        edge,
        task({ number: 1, rework: { run: "r", source: "review", streak: 1, result: "ask" } }),
        0,
        false,
      ).reason,
    ).toBe("review findings");
    expect(
      waitingReason(
        edge,
        task({ number: 1, rework: { run: "r", source: "verify", streak: 1, result: "ask" } }),
        0,
        false,
      ).reason,
    ).toBe("gate failed");
  });

  test("a visit that changed nothing carries the main-checkout note (T-0739)", () => {
    const edge = { from: "work", result: "nothing" };
    const note = "changed the main checkout: main (moved abc1234..def5678)";
    expect(waitingReason(edge, task({ number: 1, workNote: note }), 0, false)).toEqual({
      reason: "work did nothing",
      detail: note,
    });
    expect(waitingReason(edge, task({ number: 1 }), 0, false).detail).toBeUndefined();
  });

  test("a second review failure in a row has its own reason", () => {
    expect(
      waitingReason(
        { from: "rework", result: "ask" },
        task({ number: 1, rework: { run: "r", source: "review", streak: 2, result: "ask", twice: true } }),
        4,
        false,
      ).reason,
    ).toBe("review failed twice in a row");
  });

  test("an unresolved merge after the worker is a conflict", () => {
    expect(
      waitingReason({ from: "work", result: "nothing" }, task({ number: 1 }), 2, true)
        .reason,
    ).toBe("conflict");
  });

  test("a cancelled dependency has its own reason", () => {
    expect(
      waitingReason({ from: "worktree", result: "blocked" }, task({ number: 1 }), 2, false)
        .reason,
    ).toBe("dependency cancelled");
  });

  test("the summary names the task, the reason and the detail on one line", () => {
    expect(waitingSummary("T-0001-one", { reason: "work failed", detail: "429" })).toBe(
      "T-0001-one waiting: work failed (429)",
    );
  });
});
