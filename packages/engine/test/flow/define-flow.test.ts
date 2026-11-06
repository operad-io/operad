import { describe, expect, test } from "bun:test";
import { defineFlow } from "../../src/index.ts";

const source = {
  name: "greet",
  entry: "ask",
  steps: [
    {
      id: "ask",
      kind: "wait_person" as const,
      params: { prompt: "Continue?", choices: ["yes", "no"] },
      replay: "safe" as const,
      next: { yes: "end", no: "end", interrupted: "end" },
    },
  ],
};

describe("defineFlow", () => {
  test("returns the definition it was given", () => {
    const flow = defineFlow(source);
    expect(flow).toEqual(source);
    expect(flow.steps[0]?.params).toEqual({ prompt: "Continue?", choices: ["yes", "no"] });
  });

  test("accepts a plugin step with any result name the registry may declare", () => {
    const flow = defineFlow({
      name: "deploy",
      entry: "run",
      steps: [
        {
          id: "run",
          kind: "plugin",
          params: { use: "dev/command", params: { command: "true" } },
          replay: "unsafe",
          next: { ok: "end", failed: "end" },
        },
      ],
    });
    expect(flow.steps[0]?.kind).toBe("plugin");
  });
});

// This function is never called: it only has to typecheck, so the expect-error
// lines below prove that a wrong kernel result name is rejected by `tsc -b`.
// The runtime tests for these cases live in validate.test.ts.
function typeLevel(): void {
  defineFlow({
    name: "wrong wait_person result",
    entry: "ask",
    steps: [
      // @ts-expect-error "maybe" is not a choice or "interrupted"
      {
        id: "ask",
        kind: "wait_person",
        params: { prompt: "Continue?", choices: ["yes", "no"] },
        replay: "safe",
        next: { yes: "end", no: "end", interrupted: "end", maybe: "end" },
      },
    ],
  });

  defineFlow({
    name: "wrong wait result",
    entry: "ready",
    steps: [
      // @ts-expect-error a wait produces "ready" and "interrupted" only
      {
        id: "ready",
        kind: "wait",
        params: { afterSecs: 5 },
        replay: "safe",
        next: { ready: "end", interrupted: "end", later: "end" },
      },
    ],
  });

  defineFlow({
    name: "wrong end result",
    entry: "done",
    steps: [
      // @ts-expect-error an end step produces no results
      {
        id: "done",
        kind: "end",
        params: { status: "done" },
        replay: "safe",
        next: { done: "end" },
      },
    ],
  });
}

void typeLevel;
