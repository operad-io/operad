import { afterAll, describe, expect, test } from "bun:test";
import {
  decide,
  evolve,
  initialState,
  PluginRegistry,
  type FlowDefinition,
  type Input,
  type KernelState,
  type StepShape,
} from "@operad-io/engine";
import plugin from "../src/index.ts";
import devFlow from "../flows/dev.flow.ts";
import { compileDevFlow } from "../src/flow-compiler.ts";
import { addPlan, addRepository, addTask, getTask } from "../src/service.ts";
import {
  taskData,
  type ReviewRecord,
  type TaskAttempt,
  type TaskData,
} from "../src/model.ts";
import {
  WAIT_ACTIONS,
  WAIT_STEPS,
  reviewWaitKind,
  waitChoices,
  waitKindOf,
  type WaitAction,
  type WaitKind,
} from "../src/waits.ts";
import {
  cleanupTempRoots,
  guardLockHandles,
  makeGitRepository,
  storeAt,
  tempRoot,
} from "./support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const ACTOR = { via: "test", id: "lead" } as const;

const GATED: TaskAttempt = {
  number: 1,
  run: "run-1",
  worktree: "/tmp/none",
  verified: "abc123",
  verify: { result: "pass", run: "run-1" },
  review: { result: "pass", run: "run-1", sha: "abc123" },
  reviews: 1,
};

/** The attempt a review wait leaves: its recorded reason names the wait. */
function reviewWait(reason: "timed_out" | "exhausted" | "out_of_time"): TaskAttempt {
  return {
    ...GATED,
    review: {
      result: reason === "timed_out" ? "timed_out" : "unavailable",
      decision: reason === "timed_out" ? "timed_out" : "unavailable",
      reason,
      round: 1,
    },
  };
}

interface WaitCase {
  readonly kind: WaitKind;
  readonly attempt: TaskAttempt | undefined;
}

const WAIT_CASES: readonly WaitCase[] = [
  { kind: "person", attempt: GATED },
  { kind: "review-timeout", attempt: reviewWait("timed_out") },
  { kind: "review-unavailable", attempt: reviewWait("exhausted") },
  { kind: "review-out-of-time", attempt: reviewWait("out_of_time") },
];

const REVIEW_WAIT_KINDS: readonly WaitKind[] = [
  "review-timeout",
  "review-unavailable",
  "review-out-of-time",
];

interface FlowCase {
  readonly name: string;
  readonly flow: FlowDefinition;
  readonly hasReverify: boolean;
}

const FLOWS: readonly FlowCase[] = [
  { name: "the default flow", flow: devFlow, hasReverify: true },
  {
    name: "a custom flow with a review",
    flow: compileDevFlow("wait-actions-reviewed", [
      { stage: "work" },
      { stage: "review" },
      { stage: "check" },
      { stage: "human" },
    ]),
    hasReverify: true,
  },
  {
    name: "a custom flow with no check or review",
    flow: compileDevFlow("wait-actions-plain", [
      { stage: "work" },
      { stage: "human" },
    ]),
    hasReverify: false,
  },
];

async function setup(flow: FlowDefinition, attempt: TaskAttempt | undefined) {
  const root = await tempRoot();
  const repositoryPath = await makeGitRepository(root);
  const store = storeAt(root);
  const answers: string[] = [];
  const registry = new PluginRegistry([plugin], {
    store,
    storeRoot: store.root,
    onAnswer: async (_runId, choice) => {
      answers.push(choice);
    },
  });
  const repository = await addRepository(store, { path: repositoryPath });
  const plan = await addPlan(store, { repository, slug: "work", title: "Work" });
  const task = await addTask(store, { plan: plan.id, slug: "one", title: "One" });
  const current = taskData((await getTask(store, task.id)).data);
  await store.put(
    "task",
    task.id,
    {
      ...current,
      phase: "waiting",
      flowGraph: flow,
      ...(attempt === undefined ? {} : { attempt }),
    },
    "test:wait",
  );
  return { root, store, registry, taskId: task.id, answers };
}

async function offered(
  registry: PluginRegistry,
  taskId: string,
): Promise<WaitAction[]> {
  const pending = await registry.pending([
    { runId: "run-1", object: { type: "task", id: taskId } },
  ]);
  return (pending[0]?.actions ?? [])
    .map((action) => action.action)
    .filter((name): name is WaitAction =>
      (WAIT_ACTIONS as readonly string[]).includes(name),
    )
    .sort();
}

function personWaitSteps(flow: FlowDefinition): StepShape[] {
  return flow.steps.filter((step) => step.kind === "wait_person");
}

/** The wait a person wait step is, from its id. */
function kindOfStep(id: string): WaitKind | undefined {
  for (const kind of REVIEW_WAIT_KINDS) {
    const base = WAIT_STEPS[kind];
    if (id === base || id.startsWith(`${base}_`)) return kind;
  }
  return id === WAIT_STEPS.person || id === "human" ? "person" : undefined;
}

function choicesOf(step: StepShape): readonly string[] {
  if (step.kind !== "wait_person") {
    throw new Error(`step ${step.id} is not a person wait`);
  }
  return (step.params as { readonly choices: readonly string[] }).choices;
}

describe("the actions a waiting task offers", () => {
  for (const item of FLOWS) {
    test(`${item.name}: every person wait step takes the choices it is given`, () => {
      const steps = personWaitSteps(item.flow);
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        const kind = kindOfStep(step.id);
        expect(kind, step.id).toBeDefined();
        if (kind === undefined) continue;
        expect([...choicesOf(step)], step.id).toEqual([
          ...waitChoices(kind, item.hasReverify),
        ]);
      }
    });

    test(`${item.name}: a task offers exactly the actions its wait takes`, async () => {
      for (const wait of WAIT_CASES) {
        if (REVIEW_WAIT_KINDS.includes(wait.kind) && !item.hasReverify) continue;
        if (
          wait.kind !== "person" &&
          !personWaitSteps(item.flow).some((step) => kindOfStep(step.id) === wait.kind)
        ) {
          throw new Error(`${item.name} has no ${wait.kind} wait`);
        }
        const fixture = await setup(item.flow, wait.attempt);
        const task = taskData(
          (await getTask(fixture.store, fixture.taskId)).data,
        );
        expect(waitKindOf(task), `${item.name}, ${wait.kind}`).toBe(wait.kind);
        expect(
          await offered(fixture.registry, fixture.taskId),
          `${item.name}, ${wait.kind}`,
        ).toEqual([...waitChoices(wait.kind, item.hasReverify)].sort());
      }
    });
  }
});

describe("the wait a review leaves", () => {
  const record = (change: Partial<ReviewRecord>): ReviewRecord => ({
    result: "unavailable",
    ...change,
  });

  test("each review ending names its wait, or none when a person has nothing to answer", () => {
    expect(reviewWaitKind(record({ reason: "timed_out" }))).toBe(
      "review-timeout",
    );
    expect(reviewWaitKind(record({ reason: "exhausted" }))).toBe(
      "review-unavailable",
    );
    expect(reviewWaitKind(record({ reason: "out_of_time" }))).toBe(
      "review-out-of-time",
    );
    expect(reviewWaitKind(record({ decision: "passed" }))).toBe("person");
    expect(reviewWaitKind(record({ result: "failed" }))).toBe("person");
    expect(reviewWaitKind(record({ decision: "findings" }))).toBeUndefined();
    expect(reviewWaitKind(record({ result: "fail" }))).toBeUndefined();
    expect(
      reviewWaitKind(record({ decision: "unavailable", retryAt: 1 })),
    ).toBeUndefined();
  });

  test("a task from before the wait was recorded is not named by a review it has left", () => {
    const task = (change: Partial<TaskData>): TaskData => ({
      repository: "r",
      plan: "p",
      title: "t",
      brief: "",
      after: [],
      phase: "waiting",
      attempts: 1,
      run: null,
      ...change,
    });
    expect(waitKindOf(task({ attempt: reviewWait("timed_out") }))).toBe(
      "review-timeout",
    );
    expect(
      waitKindOf(
        task({
          attempt: {
            ...reviewWait("timed_out"),
            integration: { result: "failed" },
          },
        }),
      ),
    ).toBe("person");
  });
});

describe("an action the current wait does not take", () => {
  test("is refused in the task's words, naming what it can do, with no run id", async () => {
    const fixture = await setup(devFlow, reviewWait("timed_out"));
    const object = await getTask(fixture.store, fixture.taskId);
    const definition = fixture.registry.actionDefinition("dev", "reverify", "task");
    const line =
      "T-0001-one cannot be verified again now; it can be merged, rejected or reworked";

    expect(await definition?.when?.(object.data, { store: fixture.store })).toBe(
      false,
    );
    expect(await definition?.why?.(object, { store: fixture.store })).toBe(line);
    await expect(
      fixture.registry.runAction("dev/reverify", {}, {
        object,
        runId: "run-123",
        actor: ACTOR,
      }),
    ).rejects.toThrow(line);
    expect(fixture.answers).toEqual([]);
  });

  test("a generic wait after a timed-out review offers reverify and takes it", async () => {
    const fixture = await setup(devFlow, {
      ...reviewWait("timed_out"),
      integration: { result: "failed", message: "the merge did not run" },
    });
    await fixture.registry.runStep(
      "dev/announce",
      { from: "integrate", result: "failed" },
      { runId: "run-1", object: { type: "task", id: fixture.taskId, data: {} } },
    );
    const task = taskData(
      (await getTask(fixture.store, fixture.taskId)).data,
    );
    expect(task.waitKind).toBe("person");
    expect(await offered(fixture.registry, fixture.taskId)).toEqual(
      [...waitChoices("person", true)].sort(),
    );

    await fixture.registry.runAction("dev/reverify", {}, {
      object: await getTask(fixture.store, fixture.taskId),
      runId: "run-1",
      actor: ACTOR,
    });
    expect(fixture.answers).toEqual(["reverify"]);
  });

  test("a generic wait after a stopped timed-out review takes reverify too", async () => {
    const fixture = await setup(devFlow, reviewWait("timed_out"));
    await fixture.registry.runStep(
      "dev/announce",
      { from: "worktree", result: "interrupted" },
      { runId: "run-1", object: { type: "task", id: fixture.taskId, data: {} } },
    );
    const task = taskData(
      (await getTask(fixture.store, fixture.taskId)).data,
    );
    expect(task.waitKind).toBe("person");
    expect(await offered(fixture.registry, fixture.taskId)).toEqual(
      [...waitChoices("person", true)].sort(),
    );
  });

  test("a flow with no check or review refuses reverify the same way", async () => {
    const plain = FLOWS[2];
    if (plain === undefined) throw new Error("the plain flow is missing");
    const fixture = await setup(plain.flow, GATED);
    await expect(
      fixture.registry.runAction("dev/reverify", {}, {
        object: await getTask(fixture.store, fixture.taskId),
        runId: "run-123",
        actor: ACTOR,
      }),
    ).rejects.toThrow(
      "T-0001-one cannot be verified again now; it can be merged, rejected or reworked",
    );
    expect(fixture.answers).toEqual([]);
  });
});

describe("reverify from wait_review_unavailable", () => {
  test("runs the reverify step, then verify, then review", () => {
    const step = WAIT_STEPS["review-unavailable"];
    const choices = waitChoices("review-unavailable", true);
    let state: KernelState = {
      ...initialState(),
      status: "waiting_person",
      started: true,
      step,
      stepKind: "wait_person",
      wait: {
        id: `${step}:1`,
        step,
        prompt: "review did not finish (model unavailable)",
        choices,
        kind: "step",
        effectId: null,
      },
      visits: { [step]: 1 },
      lastSeq: 10,
    };

    const apply = (input: Input): void => {
      const decision = decide(devFlow, state, input, 0);
      state = decision.facts.reduce(evolve, state);
    };
    const waitId = state.wait?.id;
    if (waitId === undefined) throw new Error("the wait is missing");
    apply({
      kind: "person_answer",
      waitId,
      choice: "reverify",
      actor: ACTOR,
    });
    expect(state.step).toBe("reverify");

    const stepResult = (result: string): void => {
      const effectId = state.effect?.id;
      if (effectId === undefined) throw new Error("the step is not running");
      apply({ kind: "step_result", effectId, result });
    };
    stepResult("ready");
    expect(state.step).toBe("verify");
    stepResult("pass");
    expect(state.step).toBe("review");
  });
});
