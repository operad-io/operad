import { describe, expect, test } from "bun:test";
import {
  decide,
  initialState,
  replay,
  validateFlow,
  type FlowDefinition,
  type StepTypeRegistry,
} from "../../src/index.ts";
import { Runner, payloadOf } from "./support.ts";

const REGISTRY: StepTypeRegistry = [
  { name: "dev/command", results: ["ok", "failed", "interrupted"] },
];

function pluginFlow(replay: "safe" | "unsafe" = "safe"): FlowDefinition {
  return validateFlow(
    {
      name: "deploy",
      entry: "run",
      steps: [
        {
          id: "run",
          kind: "plugin",
          params: { use: "dev/command", params: { command: "true" } },
          replay,
          next: { ok: "end", failed: "end", interrupted: "end" },
        },
      ],
    },
    REGISTRY,
  );
}

function personFlow(): FlowDefinition {
  return validateFlow({
    name: "greet",
    entry: "ask",
    steps: [
      {
        id: "ask",
        kind: "wait_person",
        params: { prompt: "Continue?", choices: ["yes", "no"] },
        replay: "safe",
        next: { yes: "end", no: "end", interrupted: "end" },
      },
    ],
  });
}

function timedFlow(): FlowDefinition {
  return validateFlow({
    name: "pause",
    entry: "pause",
    steps: [
      {
        id: "pause",
        kind: "wait",
        params: { afterSecs: 2 },
        replay: "safe",
        next: { ready: "end", interrupted: "end" },
      },
    ],
  });
}

function checkFlow(): FlowDefinition {
  return validateFlow(
    {
      name: "watch",
      entry: "watch",
      steps: [
        {
          id: "watch",
          kind: "wait",
          params: { check: "dev/command" },
          replay: "safe",
          next: { ready: "end", interrupted: "end" },
        },
      ],
    },
    REGISTRY,
  );
}

function loopFlow(maxVisits?: number): FlowDefinition {
  return validateFlow(
    {
      name: "loop",
      entry: "run",
      ...(maxVisits === undefined ? {} : { maxVisits }),
      steps: [
        {
          id: "run",
          kind: "plugin",
          params: { use: "dev/command", params: {} },
          replay: "safe",
          next: { ok: "run", failed: "end", interrupted: "end" },
        },
      ],
    },
    REGISTRY,
  );
}

function effectIdOf(runner: Runner): string {
  const effect = runner.state.effect;
  expect(effect).not.toBeNull();
  return effect?.id ?? "";
}

describe("decide: start", () => {
  test("starts a run and requests a plugin step", () => {
    const runner = new Runner(pluginFlow());
    const decision = runner.apply({ kind: "start", inputId: "in-1" });

    expect(decision.facts.map((fact) => fact.kind)).toEqual([
      "run_started",
      "step_entered",
      "effect_requested",
    ]);
    expect(decision.facts[0]?.cause).toBe("in-1");
    expect(decision.facts[1]?.cause).toBe(1);
    expect(decision.facts[2]?.cause).toBe(2);
    expect(decision.effects).toEqual([
      {
        kind: "run_plugin_step",
        effectId: "run:1",
        step: "run",
        use: "dev/command",
        params: { command: "true" },
        replay: "safe",
      },
    ]);

    expect(runner.state.status).toBe("running");
    expect(runner.state.step).toBe("run");
    expect(runner.state.visits).toEqual({ run: 1 });
    expect(runner.state.effect?.id).toBe("run:1");
    expect(runner.state.lastSeq).toBe(3);
    expect(payloadOf(decision.facts[0] ?? {})).toEqual({ flow: "deploy" });
  });

  test("ignores a second start", () => {
    const runner = new Runner(pluginFlow());
    runner.apply({ kind: "start" });
    const before = runner.state;
    const second = runner.apply({ kind: "start" });
    expect(second.facts).toEqual([]);
    expect(runner.state).toEqual(before);
  });

  test("enters an end step and ends the run", () => {
    const flow = validateFlow({
      name: "nothing",
      entry: "done",
      steps: [{ id: "done", kind: "end", params: { status: "failed" }, replay: "safe" }],
    });
    const decision = decide(flow, initialState(), { kind: "start" }, 0);
    expect(decision.facts.map((fact) => fact.kind)).toEqual([
      "run_started",
      "step_entered",
      "run_ended",
    ]);
    const state = replay(decision.facts);
    expect(state.status).toBe("ended");
    expect(state.endedStatus).toBe("failed");
  });
});

describe("decide: step_result", () => {
  test("takes the edge for a declared result and ends at end", () => {
    const runner = new Runner(pluginFlow());
    runner.apply({ kind: "start" });
    const decision = runner.apply({
      kind: "step_result",
      effectId: "run:1",
      result: "ok",
      data: { output: "fine" },
    });

    expect(decision.facts.map((fact) => fact.kind)).toEqual([
      "step_result",
      "edge_taken",
      "run_ended",
    ]);
    expect(payloadOf(decision.facts[0] ?? {})).toEqual({
      effectId: "run:1",
      step: "run",
      result: "ok",
      data: { output: "fine" },
    });
    expect(runner.state.status).toBe("ended");
    expect(runner.state.endedStatus).toBe("done");
    expect(runner.state.results["run:1"]).toEqual({ result: "ok", data: { output: "fine" } });
    expect(runner.state.effects["run:1"]).toBe("done");
  });

  test("ignores a second result for the same effect", () => {
    const runner = new Runner(pluginFlow());
    runner.apply({ kind: "start" });
    runner.apply({ kind: "step_result", effectId: "run:1", result: "ok" });
    const before = runner.state;
    const duplicate = runner.apply({ kind: "step_result", effectId: "run:1", result: "failed" });
    expect(duplicate.facts).toEqual([]);
    expect(runner.state).toEqual(before);
  });

  test("ignores a result for an unknown effect", () => {
    const runner = new Runner(pluginFlow());
    runner.apply({ kind: "start" });
    const before = runner.state;
    const unknown = runner.apply({ kind: "step_result", effectId: "ghost:1", result: "ok" });
    expect(unknown.facts).toEqual([]);
    expect(runner.state).toEqual(before);
  });

  test("ignores a result after the run left the step", () => {
    const runner = new Runner(pluginFlow("unsafe"));
    runner.apply({ kind: "start" });
    runner.apply({ kind: "recover" });
    expect(runner.state.status).toBe("ended");
    const late = runner.apply({ kind: "step_result", effectId: "run:1", result: "ok" });
    expect(late.facts).toEqual([]);
  });

  test("turns an undeclared result into an interrupted failure", () => {
    const runner = new Runner(pluginFlow());
    runner.apply({ kind: "start" });
    const decision = runner.apply({
      kind: "step_result",
      effectId: "run:1",
      result: "surprise",
    });

    expect(decision.facts.map((fact) => fact.kind)).toEqual([
      "step_interrupted",
      "edge_taken",
      "run_ended",
    ]);
    expect(payloadOf(decision.facts[0] ?? {})).toMatchObject({
      step: "run",
      effectId: "run:1",
      reason: "undeclared_result",
      result: "surprise",
    });
    expect(runner.state.status).toBe("ended");
    expect(runner.state.effects["run:1"]).toBe("abandoned");
  });
});

describe("decide: person_answer", () => {
  test("answers a wait, takes the edge, and ignores a second answer", () => {
    const runner = new Runner(personFlow());
    runner.apply({ kind: "start" });
    expect(runner.state.status).toBe("waiting_person");
    expect(runner.state.wait?.choices).toEqual(["yes", "no"]);

    const decision = runner.apply({
      kind: "person_answer",
      waitId: "ask:1",
      choice: "yes",
      note: "looks good",
    });
    expect(decision.facts.map((fact) => fact.kind)).toEqual([
      "person_answered",
      "edge_taken",
      "run_ended",
    ]);
    expect(payloadOf(decision.facts[0] ?? {})).toEqual({
      waitId: "ask:1",
      step: "ask",
      choice: "yes",
      note: "looks good",
      waitKind: "step",
    });
    expect(runner.state.answeredWaits["ask:1"]).toBe(true);

    const before = runner.state;
    const second = runner.apply({ kind: "person_answer", waitId: "ask:1", choice: "no" });
    expect(second.facts).toEqual([]);
    expect(runner.state).toEqual(before);
  });

  test("ignores a choice the wait did not offer", () => {
    const runner = new Runner(personFlow());
    runner.apply({ kind: "start" });
    const before = runner.state;
    const invalid = runner.apply({
      kind: "person_answer",
      waitId: "ask:1",
      choice: "maybe",
    });
    expect(invalid.facts).toEqual([]);
    expect(runner.state).toEqual(before);
  });

  test("notifies the pending queue when the wait starts", () => {
    const runner = new Runner(personFlow());
    const decision = runner.apply({ kind: "start" });
    expect(decision.effects).toEqual([
      {
        kind: "notify_pending",
        waitId: "ask:1",
        step: "ask",
        prompt: "Continue?",
        choices: ["yes", "no"],
        waitKind: "step",
      },
    ]);
  });
});

describe("decide: tick", () => {
  test("does nothing before a timed wait is due", () => {
    const runner = new Runner(timedFlow(), 1_000);
    runner.apply({ kind: "start" }, 1_000);
    const decision = runner.apply({ kind: "tick" }, 2_999);
    expect(decision.facts).toEqual([]);
    expect(decision.effects).toEqual([]);
    expect(runner.state.status).toBe("waiting");
  });

  test("advances a timed wait when due", () => {
    const runner = new Runner(timedFlow(), 1_000);
    const start = runner.apply({ kind: "start" }, 1_000);
    expect(start.effects).toEqual([
      { kind: "schedule_wake", effectId: "pause:1", step: "pause", due: 3_000 },
    ]);
    const decision = runner.apply({ kind: "tick" }, 3_000);
    expect(decision.facts.map((fact) => fact.kind)).toEqual([
      "step_result",
      "edge_taken",
      "run_ended",
    ]);
    expect(payloadOf(decision.facts[0] ?? {})).toEqual({
      effectId: "pause:1",
      step: "pause",
      result: "ready",
      data: { at: 3_000 },
    });
    expect(runner.state.status).toBe("ended");
  });

  test("asks a check step to poll and resolves its result", () => {
    const runner = new Runner(checkFlow());
    const start = runner.apply({ kind: "start" });
    expect(start.effects).toEqual([
      { kind: "poll_check", effectId: "watch:1", step: "watch", check: "dev/command" },
    ]);
    expect(runner.state.status).toBe("waiting");
    const tick = runner.apply({ kind: "tick" }, 5_000);
    expect(tick.facts).toEqual([]);
    const result = runner.apply({ kind: "step_result", effectId: "watch:1", result: "ready" });
    expect(result.facts.map((fact) => fact.kind)).toEqual([
      "step_result",
      "edge_taken",
      "run_ended",
    ]);
    expect(runner.state.status).toBe("ended");
  });
});

describe("decide: recover", () => {
  test("does nothing with nothing outstanding", () => {
    const fresh = decide(pluginFlow(), initialState(), { kind: "recover" }, 0);
    expect(fresh.facts).toEqual([]);
    expect(fresh.effects).toEqual([]);

    const ended = new Runner(pluginFlow());
    ended.apply({ kind: "start" });
    ended.apply({ kind: "cancel" });
    const after = ended.apply({ kind: "recover" });
    expect(after.facts).toEqual([]);
  });

  test("keeps a person wait in place", () => {
    const runner = new Runner(personFlow());
    runner.apply({ kind: "start" });
    const before = runner.state;
    const decision = runner.apply({ kind: "recover" });
    expect(decision.facts).toEqual([]);
    expect(runner.state).toEqual(before);
    expect(runner.state.wait?.id).toBe("ask:1");
  });

  test("requests a safe step again and stops after three recoveries", () => {
    const runner = new Runner(pluginFlow("safe"));
    runner.apply({ kind: "start" });

    const first = runner.apply({ kind: "recover", inputId: "r-1" });
    expect(first.facts.map((fact) => fact.kind)).toEqual(["effect_requested"]);
    expect(payloadOf(first.facts[0] ?? {})).toMatchObject({
      effectId: "run:1",
      recovery: true,
    });
    expect(runner.state.recoveries["run:1"]).toBe(1);

    runner.apply({ kind: "recover" });
    expect(runner.state.recoveries["run:1"]).toBe(2);

    const third = runner.apply({ kind: "recover", inputId: "r-3" });
    expect(third.facts.map((fact) => fact.kind)).toEqual([
      "crash_loop_stopped",
      "waiting_for_person",
    ]);
    expect(payloadOf(third.facts[0] ?? {})).toEqual({
      step: "run",
      effectId: "run:1",
      recoveries: 3,
    });
    expect(third.effects).toEqual([
      {
        kind: "notify_pending",
        waitId: "crash:run:1",
        step: "run",
        prompt: "This step keeps crashing. Retry it or cancel the run?",
        choices: ["retry", "cancel"],
        waitKind: "crash_loop",
      },
    ]);
    expect(runner.state.status).toBe("waiting_person");
    expect(runner.state.wait?.choices).toEqual(["retry", "cancel"]);

    const whileWaiting = runner.apply({ kind: "recover" });
    expect(whileWaiting.facts).toEqual([]);
  });

  test("retries from the crash-loop wait and resets the count", () => {
    const runner = new Runner(pluginFlow("safe"));
    runner.apply({ kind: "start" });
    runner.apply({ kind: "recover" });
    runner.apply({ kind: "recover" });
    runner.apply({ kind: "recover" });

    const retry = runner.apply({
      kind: "person_answer",
      waitId: "crash:run:1",
      choice: "retry",
    });
    expect(retry.facts.map((fact) => fact.kind)).toEqual([
      "person_answered",
      "effect_requested",
    ]);
    expect(payloadOf(retry.facts[1] ?? {})).toMatchObject({
      effectId: "run:1",
      recovery: false,
    });
    expect(runner.state.recoveries["run:1"]).toBe(0);
    expect(runner.state.status).toBe("running");

    const result = runner.apply({ kind: "step_result", effectId: "run:1", result: "ok" });
    expect(result.facts.map((fact) => fact.kind)).toEqual([
      "step_result",
      "edge_taken",
      "run_ended",
    ]);
  });

  test("cancels from the crash-loop wait", () => {
    const runner = new Runner(pluginFlow("safe"));
    runner.apply({ kind: "start" });
    runner.apply({ kind: "recover" });
    runner.apply({ kind: "recover" });
    runner.apply({ kind: "recover" });
    const decision = runner.apply({
      kind: "person_answer",
      waitId: "crash:run:1",
      choice: "cancel",
    });
    expect(decision.facts.map((fact) => fact.kind)).toEqual(["person_answered", "run_ended"]);
    expect(runner.state.status).toBe("ended");
    expect(runner.state.endedStatus).toBe("cancelled");
  });

  test("interrupts an unsafe step and leaves it", () => {
    const runner = new Runner(pluginFlow("unsafe"));
    runner.apply({ kind: "start" });
    const decision = runner.apply({ kind: "recover", inputId: "r-1" });
    expect(decision.facts.map((fact) => fact.kind)).toEqual([
      "step_interrupted",
      "edge_taken",
      "run_ended",
    ]);
    expect(payloadOf(decision.facts[0] ?? {})).toEqual({
      step: "run",
      effectId: "run:1",
      reason: "recover_unsafe",
      result: null,
    });
    expect(runner.state.status).toBe("ended");
    expect(runner.state.effects["run:1"]).toBe("abandoned");
  });
});

describe("decide: cancel", () => {
  test("ends a running run as cancelled", () => {
    const runner = new Runner(pluginFlow());
    runner.apply({ kind: "start" });
    const decision = runner.apply({ kind: "cancel", inputId: "c-1" });
    expect(decision.facts.map((fact) => fact.kind)).toEqual(["run_ended"]);
    expect(payloadOf(decision.facts[0] ?? {})).toEqual({ status: "cancelled", reason: "cancel" });
    expect(runner.state.status).toBe("ended");
    expect(runner.state.endedStatus).toBe("cancelled");
    expect(runner.state.effect).toBeNull();
  });

  test("ends a person wait as cancelled", () => {
    const runner = new Runner(personFlow());
    runner.apply({ kind: "start" });
    runner.apply({ kind: "cancel" });
    expect(runner.state.status).toBe("ended");
    expect(runner.state.endedStatus).toBe("cancelled");
    expect(runner.state.wait).toBeNull();
  });

  test("ignores a second cancel", () => {
    const runner = new Runner(pluginFlow());
    runner.apply({ kind: "start" });
    runner.apply({ kind: "cancel" });
    const before = runner.state;
    const second = runner.apply({ kind: "cancel" });
    expect(second.facts).toEqual([]);
    expect(runner.state).toEqual(before);
  });
});

describe("decide: visits", () => {
  test("ends the run when a step is entered past the default maxVisits", () => {
    const runner = new Runner(loopFlow());
    runner.apply({ kind: "start" });
    for (let visit = 1; visit < 10; visit += 1) {
      runner.apply({ kind: "step_result", effectId: effectIdOf(runner), result: "ok" });
    }
    expect(runner.state.visits["run"]).toBe(10);
    expect(runner.state.status).toBe("running");

    const decision = runner.apply({ kind: "step_result", effectId: effectIdOf(runner), result: "ok" });
    expect(decision.facts.map((fact) => fact.kind)).toEqual([
      "step_result",
      "edge_taken",
      "visit_limit_reached",
      "run_ended",
    ]);
    expect(payloadOf(decision.facts[2] ?? {})).toEqual({ step: "run", visits: 11, limit: 10 });
    expect(runner.state.status).toBe("ended");
    expect(runner.state.endedStatus).toBe("failed");
  });

  test("honours a lower flow maxVisits", () => {
    const runner = new Runner(loopFlow(1));
    runner.apply({ kind: "start" });
    const decision = runner.apply({ kind: "step_result", effectId: "run:1", result: "ok" });
    expect(decision.facts.map((fact) => fact.kind)).toEqual([
      "step_result",
      "edge_taken",
      "visit_limit_reached",
      "run_ended",
    ]);
    expect(payloadOf(decision.facts[2] ?? {})).toMatchObject({ step: "run", visits: 2, limit: 1 });
  });
});
