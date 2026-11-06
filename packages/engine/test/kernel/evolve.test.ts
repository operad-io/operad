import { describe, expect, test } from "bun:test";
import {
  evolve,
  initialState,
  replay,
  type KernelState,
  type NewFact,
} from "../../src/index.ts";

function fact(kind: string, payload: unknown, cause: number | string = 1): NewFact {
  return { kind, payload: payload as NewFact["payload"], cause };
}

function started(): KernelState {
  return replay([
    fact("run_started", { flow: "deploy" }),
    fact("step_entered", { step: "run", visit: 1, kind: "plugin" }, 1),
    fact(
      "effect_requested",
      {
        effectId: "run:1",
        effect: "run_plugin_step",
        step: "run",
        replay: "safe",
        recovery: false,
        use: "dev/command",
        params: { command: "true" },
        check: null,
        due: null,
      },
      2,
    ),
  ]);
}

describe("evolve: each fact kind", () => {
  test("run_started starts the run", () => {
    const state = evolve(initialState(), fact("run_started", { flow: "deploy" }));
    expect(state.started).toBe(true);
    expect(state.status).toBe("running");
    expect(state.lastSeq).toBe(1);
  });

  test("run_started keeps the fixed JSON the flow was started with", () => {
    const params = { prompt: "from the rule", count: 2 };
    const state = evolve(
      initialState(),
      fact("run_started", { flow: "deploy", params }),
    );
    expect(state.params).toEqual(params);
    expect(evolve(initialState(), fact("run_started", { flow: "deploy" })).params).toBeNull();
  });

  test("step_entered moves the run into one step and counts the visit", () => {
    const state = evolve(initialState(), fact("step_entered", { step: "run", visit: 2, kind: "plugin" }));
    expect(state.status).toBe("running");
    expect(state.step).toBe("run");
    expect(state.stepKind).toBe("plugin");
    expect(state.visits).toEqual({ run: 2 });
  });

  test("effect_requested records an outstanding effect and a recovery count", () => {
    const pending = started();
    const state = evolve(
      pending,
      fact(
        "effect_requested",
        {
          effectId: "run:1",
          effect: "run_plugin_step",
          step: "run",
          replay: "safe",
          recovery: true,
          use: "dev/command",
          params: {},
          check: null,
          due: null,
        },
        "recover",
      ),
    );
    expect(state.effect?.id).toBe("run:1");
    expect(state.effects["run:1"]).toBe("outstanding");
    expect(state.recoveries["run:1"]).toBe(1);
  });

  test("a wait effect puts the run in the waiting state", () => {
    const state = replay([
      fact("run_started", { flow: "pause" }),
      fact("step_entered", { step: "pause", visit: 1, kind: "wait" }, 1),
      fact(
        "effect_requested",
        {
          effectId: "pause:1",
          effect: "schedule_wake",
          step: "pause",
          replay: "safe",
          recovery: false,
          use: null,
          params: null,
          check: null,
          due: 3_000,
        },
        2,
      ),
    ]);
    expect(state.status).toBe("waiting");
    expect(state.effect?.kind).toBe("schedule_wake");
    expect(state.effect?.due).toBe(3_000);
  });

  test("step_result records the result once", () => {
    const pending = started();
    const state = evolve(
      pending,
      fact(
        "step_result",
        { effectId: "run:1", step: "run", result: "ok", data: { n: 1 } },
        "result",
      ),
    );
    expect(state.results["run:1"]).toEqual({ result: "ok", data: { n: 1 } });
    expect(state.effects["run:1"]).toBe("done");
    expect(state.effect).toBeNull();

    const again = evolve(
      state,
      fact("step_result", { effectId: "run:1", step: "run", result: "failed", data: null }),
    );
    expect(again.results["run:1"]).toEqual({ result: "ok", data: { n: 1 } });
  });

  test("edge_taken moves to the target, or out of the step at end", () => {
    const pending = started();
    const toStep = evolve(pending, fact("edge_taken", { step: "run", result: "ok", target: "next" }));
    expect(toStep.step).toBe("next");
    expect(toStep.stepKind).toBeNull();

    const toEnd = evolve(pending, fact("edge_taken", { step: "run", result: "ok", target: "end" }));
    expect(toEnd.step).toBeNull();
  });

  test("waiting_for_person records the wait", () => {
    const state = evolve(
      initialState(),
      fact("waiting_for_person", {
        waitId: "ask:1",
        step: "ask",
        prompt: "Continue?",
        choices: ["yes", "no"],
        waitKind: "step",
        effectId: null,
      }),
    );
    expect(state.status).toBe("waiting_person");
    expect(state.step).toBe("ask");
    expect(state.wait?.id).toBe("ask:1");
    expect(state.wait?.choices).toEqual(["yes", "no"]);
  });

  test("person_answered closes the wait and remembers the answer", () => {
    const waiting = replay([
      fact("waiting_for_person", {
        waitId: "ask:1",
        step: "ask",
        prompt: "Continue?",
        choices: ["yes", "no"],
        waitKind: "step",
        effectId: null,
      }),
    ]);
    const state = evolve(
      waiting,
      fact("person_answered", {
        waitId: "ask:1",
        step: "ask",
        choice: "yes",
        note: null,
        waitKind: "step",
      }),
    );
    expect(state.wait).toBeNull();
    expect(state.answeredWaits["ask:1"]).toBe(true);
  });

  test("run_ended ends the run and clears pending work", () => {
    const pending = started();
    const state = evolve(pending, fact("run_ended", { status: "cancelled", reason: "cancel" }));
    expect(state.status).toBe("ended");
    expect(state.endedStatus).toBe("cancelled");
    expect(state.step).toBeNull();
    expect(state.effect).toBeNull();
    expect(state.effects["run:1"]).toBe("abandoned");
  });

  test("step_interrupted abandons the effect", () => {
    const pending = started();
    const state = evolve(
      pending,
      fact("step_interrupted", {
        step: "run",
        effectId: "run:1",
        reason: "recover_unsafe",
        result: null,
      }),
    );
    expect(state.effect).toBeNull();
    expect(state.effects["run:1"]).toBe("abandoned");
  });

  test("crash_loop_stopped records the recovery count", () => {
    const state = evolve(
      initialState(),
      fact("crash_loop_stopped", { step: "run", effectId: "run:1", recoveries: 3 }),
    );
    expect(state.recoveries["run:1"]).toBe(3);
  });

  test("visit_limit_reached is recorded without changing the run", () => {
    const pending = started();
    const state = evolve(pending, fact("visit_limit_reached", { step: "run", visits: 11, limit: 10 }));
    expect(state).toEqual({ ...pending, lastSeq: pending.lastSeq + 1 });
  });

  test("an unknown fact only advances the sequence", () => {
    const pending = started();
    const state = evolve(pending, fact("future_fact", { anything: true }));
    expect(state).toEqual({ ...pending, lastSeq: pending.lastSeq + 1 });
  });

  test("evolve does not mutate the state it is given", () => {
    const pending = started();
    const snapshot = JSON.parse(JSON.stringify(pending)) as KernelState;
    evolve(pending, fact("run_ended", { status: "done", reason: null }));
    expect(pending).toEqual(snapshot);
  });

  test("replay folds facts in order", () => {
    const facts = [
      fact("run_started", { flow: "deploy" }),
      fact("step_entered", { step: "run", visit: 1, kind: "plugin" }, 1),
      fact("run_ended", { status: "done", reason: null }, 2),
    ];
    const state = replay(facts);
    expect(state.lastSeq).toBe(3);
    expect(state.status).toBe("ended");
    expect(state.started).toBe(true);
  });
});
