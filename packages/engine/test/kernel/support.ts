import { expect } from "bun:test";
import {
  decide,
  evolve,
  inputCause,
  replay,
  type Decision,
  type FlowDefinition,
  type Input,
  type KernelState,
} from "../../src/index.ts";
import type { NewFact } from "../../src/index.ts";

/**
 * Drives the pure kernel and checks the invariants that must hold after every
 * accepted input: the log replays to the state, every cause exists, and the
 * run is in one step at most.
 */
export class Runner {
  state: KernelState = replay([]);
  readonly facts: NewFact[] = [];
  readonly inputIds = new Set<string>();
  lastInput: Input | null = null;

  constructor(
    readonly flow: FlowDefinition,
    readonly baseTime = 0,
  ) {}

  apply(input: Input, now = this.baseTime): Decision {
    const cause = String(inputCause(input));
    this.inputIds.add(cause);
    const decision = decide(this.flow, this.state, input, now);
    let next = this.state;
    for (const fact of decision.facts) next = evolve(next, fact);
    this.facts.push(...decision.facts);
    this.lastInput = input;
    this.check(decision, next);
    this.state = next;
    return decision;
  }

  private check(decision: Decision, next: KernelState): void {
    expect(replay(this.facts)).toEqual(next);

    for (let index = 0; index < this.facts.length; index += 1) {
      const fact = this.facts[index];
      if (fact === undefined) continue;
      if (typeof fact.cause === "number") {
        expect(Number.isInteger(fact.cause)).toBe(true);
        expect(fact.cause).toBeGreaterThanOrEqual(1);
        // A fact at index i has seq i + 1, so its cause is an earlier fact.
        expect(fact.cause).toBeLessThanOrEqual(index);
      } else {
        expect(this.inputIds.has(fact.cause)).toBe(true);
      }
    }

    expect(next.step === null || typeof next.step === "string").toBe(true);
    expect(decision.facts.filter((fact) => fact.kind === "step_entered").length).toBeLessThanOrEqual(
      1,
    );
  }
}

export function payloadOf(fact: { readonly payload?: unknown } | undefined): Record<string, unknown> {
  return (fact?.payload ?? {}) as Record<string, unknown>;
}
