import { describe, expect, test } from "bun:test";
import {
  validateFlow,
  type FlowDefinition,
  type Input,
  type PendingEffect,
  type StepTypeRegistry,
} from "../../src/index.ts";
import { Runner } from "./support.ts";

const REGISTRY: StepTypeRegistry = [
  { name: "dev/command", results: ["ok", "failed", "interrupted"] },
  { name: "dev/worker", results: ["ok", "failed", "interrupted"] },
  { name: "dev/review", results: ["ok", "failed", "interrupted"] },
  { name: "dev/merge", results: ["ok", "failed", "interrupted"] },
];

/** A flow shaped like the dev loop: worktree, worker, verify, review, gate, merge. */
function devFlow(): FlowDefinition {
  return validateFlow(
    {
      name: "dev",
      entry: "worktree",
      steps: [
        {
          id: "worktree",
          kind: "plugin",
          params: { use: "dev/command", params: { command: "worktree add" } },
          replay: "safe",
          next: { ok: "worker", failed: "end_failed", interrupted: "end_failed" },
        },
        {
          id: "worker",
          kind: "plugin",
          params: { use: "dev/worker", params: { harness: "fake" } },
          replay: "unsafe",
          next: { ok: "verify", failed: "worktree", interrupted: "end_failed" },
        },
        {
          id: "verify",
          kind: "plugin",
          params: { use: "dev/command", params: { command: "verify" } },
          replay: "safe",
          next: { ok: "review", failed: "worker", interrupted: "end_failed" },
        },
        {
          id: "review",
          kind: "plugin",
          params: { use: "dev/review", params: {} },
          replay: "safe",
          next: { ok: "gate", failed: "worker", interrupted: "end_failed" },
        },
        {
          id: "gate",
          kind: "wait_person",
          params: { prompt: "Merge?", choices: ["merge", "reject"] },
          replay: "safe",
          next: { merge: "merge", reject: "end_rejected", interrupted: "end_failed" },
        },
        {
          id: "merge",
          kind: "plugin",
          params: { use: "dev/merge", params: {} },
          replay: "unsafe",
          next: { ok: "cleanup", failed: "worktree", interrupted: "end_failed" },
        },
        { id: "cleanup", kind: "end", params: { status: "done" }, replay: "safe" },
        { id: "end_failed", kind: "end", params: { status: "failed" }, replay: "safe" },
        { id: "end_rejected", kind: "end", params: { status: "cancelled" }, replay: "safe" },
      ],
    },
    REGISTRY,
  );
}

/** A three-step flow with a cycle, used by the bounded enumeration. */
function threeStepFlow(): FlowDefinition {
  return validateFlow(
    {
      name: "three",
      entry: "work",
      maxVisits: 4,
      steps: [
        {
          id: "work",
          kind: "plugin",
          params: { use: "dev/command", params: {} },
          replay: "safe",
          next: { ok: "ask", failed: "done", interrupted: "done" },
        },
        {
          id: "ask",
          kind: "wait_person",
          params: { prompt: "Again?", choices: ["again", "stop"] },
          replay: "safe",
          next: { again: "work", stop: "done", interrupted: "done" },
        },
        { id: "done", kind: "end", params: { status: "done" }, replay: "safe" },
      ],
    },
    REGISTRY,
  );
}

function resultNames(flow: FlowDefinition, effect: PendingEffect): string[] {
  const step = flow.steps.find((candidate) => candidate.id === effect.step);
  if (step === undefined) return ["ok"];
  if (step.kind === "plugin") {
    const next = step.next as Record<string, string> | undefined;
    return next === undefined ? ["ok"] : Object.keys(next);
  }
  if (step.kind === "wait") return ["ready", "interrupted"];
  if (step.kind === "wait_person") {
    const params = step.params as { readonly choices?: readonly string[] };
    return [...(params.choices ?? []), "interrupted"];
  }
  return ["ok"];
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function chooseInput(
  flow: FlowDefinition,
  runner: Runner,
  rand: () => number,
  id: string,
): Input {
  const state = runner.state;

  if (state.status === "idle") return { kind: "start", inputId: id };

  if (state.status === "ended") {
    const roll = rand();
    if (roll < 0.3 && runner.lastInput !== null) return runner.lastInput;
    if (roll < 0.6) return { kind: "start", inputId: id };
    if (roll < 0.8) return { kind: "recover", inputId: id };
    return { kind: "cancel", inputId: id };
  }

  if (state.status === "waiting_person") {
    const wait = state.wait;
    if (wait === null) return { kind: "recover", inputId: id };
    const roll = rand();
    if (roll < 0.6) {
      const index = Math.floor(rand() * wait.choices.length);
      const choice = wait.choices[index] ?? wait.choices[0] ?? "cancel";
      return {
        kind: "person_answer",
        waitId: wait.id,
        choice,
        note: "sim",
        actor: { via: "sim", id: "bot" },
        inputId: id,
      };
    }
    if (roll < 0.7) {
      return {
        kind: "person_answer",
        waitId: wait.id,
        choice: "bogus",
        actor: { via: "sim", id: "bot" },
        inputId: id,
      };
    }
    if (roll < 0.8 && runner.lastInput !== null) return runner.lastInput;
    if (roll < 0.9) return { kind: "recover", inputId: id };
    return { kind: "tick", inputId: id };
  }

  const effect = state.effect;
  if (effect !== null) {
    const roll = rand();
    if (roll < 0.55) {
      const names = resultNames(flow, effect);
      const index = Math.floor(rand() * names.length);
      const result = rand() < 0.05 ? "surprise" : (names[index] ?? "ok");
      return { kind: "step_result", effectId: effect.id, result, data: { id }, inputId: id };
    }
    if (roll < 0.7) return { kind: "recover", inputId: id };
    if (roll < 0.82 && runner.lastInput !== null) return runner.lastInput;
    if (roll < 0.9) return { kind: "tick", inputId: id };
    return { kind: "cancel", inputId: id };
  }

  return { kind: "recover", inputId: id };
}

describe("kernel simulation", () => {
  test("10 000 random input sequences keep the invariants", () => {
    const flow = devFlow();
    const rand = mulberry32(0x5eed);

    for (let sequence = 0; sequence < 10_000; sequence += 1) {
      const runner = new Runner(flow);
      const length = 1 + Math.floor(rand() * 12);
      let now = 0;
      for (let step = 0; step < length; step += 1) {
        now += Math.floor(rand() * 1_000);
        const input = chooseInput(flow, runner, rand, `s${sequence}-${step}`);
        runner.apply(input, now);
      }
    }
  }, 120_000);

  test("replay always equals the live state after a random walk", () => {
    const flow = devFlow();
    const rand = mulberry32(0xbeef);
    const runner = new Runner(flow);
    let now = 0;
    for (let step = 0; step < 200; step += 1) {
      now += Math.floor(rand() * 1_000);
      runner.apply(chooseInput(flow, runner, rand, `walk-${step}`), now);
      expect(runner.state.step === null || typeof runner.state.step === "string").toBe(true);
    }
  });
});

type SymbolName = "start" | "result" | "answer" | "recover" | "cancel";

const ALPHABET: readonly SymbolName[] = ["start", "result", "answer", "recover", "cancel"];

function* orderings(maxLength: number, prefix: SymbolName[] = []): Generator<SymbolName[]> {
  if (prefix.length > 0) yield prefix;
  if (prefix.length === maxLength) return;
  for (const symbol of ALPHABET) {
    yield* orderings(maxLength, [...prefix, symbol]);
  }
}

function inputFor(
  flow: FlowDefinition,
  symbol: SymbolName,
  runner: Runner,
  id: string,
): Input {
  const state = runner.state;
  switch (symbol) {
    case "start":
      return { kind: "start", inputId: id };
    case "result": {
      const effect = state.effect;
      if (effect === null) return { kind: "step_result", effectId: "missing", result: "ok", inputId: id };
      const names = resultNames(flow, effect);
      return {
        kind: "step_result",
        effectId: effect.id,
        result: names[0] ?? "ok",
        inputId: id,
      };
    }
    case "answer": {
      const wait = state.wait;
      if (wait === null) {
        return {
          kind: "person_answer",
          waitId: "missing",
          choice: "stop",
          actor: { via: "sim", id: "bot" },
          inputId: id,
        };
      }
      return {
        kind: "person_answer",
        waitId: wait.id,
        choice: wait.choices[0] ?? "stop",
        actor: { via: "sim", id: "bot" },
        inputId: id,
      };
    }
    case "recover":
      return { kind: "recover", inputId: id };
    case "cancel":
      return { kind: "cancel", inputId: id };
  }
}

describe("kernel bounded enumeration", () => {
  test("every ordering of up to seven inputs keeps the invariants", () => {
    const flow = threeStepFlow();
    let runs = 0;
    for (const symbols of orderings(7)) {
      const runner = new Runner(flow);
      for (let index = 0; index < symbols.length; index += 1) {
        const symbol = symbols[index];
        if (symbol === undefined) continue;
        runner.apply(inputFor(flow, symbol, runner, `e-${runs}-${index}`));
      }
      runs += 1;
    }
    expect(runs).toBe(97_655);
  }, 180_000);
});
