import { describe, expect, test } from "bun:test";
import { FlowError, validateFlow } from "../../src/index.ts";

function waitPerson(id: string, next: Record<string, string>, choices: string[] = ["yes", "no"]) {
  return { id, kind: "wait_person", params: { prompt: "Continue?", choices }, replay: "safe", next };
}

function endStep(id: string, status: "done" | "failed" | "cancelled" = "done") {
  return { id, kind: "end", params: { status }, replay: "safe" };
}

function errorOf(run: () => unknown): FlowError {
  try {
    run();
  } catch (error) {
    if (error instanceof FlowError) return error;
    throw error;
  }
  throw new Error("expected a FlowError");
}

describe("validateFlow", () => {
  test("accepts a flow and keeps maxVisits", () => {
    const flow = validateFlow({
      name: "greet",
      entry: "ask",
      maxVisits: 3,
      steps: [
        waitPerson("ask", { yes: "done", no: "done", interrupted: "done" }),
        endStep("done"),
      ],
    });
    expect(flow.name).toBe("greet");
    expect(flow.maxVisits).toBe(3);
    expect(flow.steps).toHaveLength(2);
  });

  test("accepts a flow whose entry is an end step", () => {
    const flow = validateFlow({ name: "nothing", entry: "done", steps: [endStep("done")] });
    expect(flow.entry).toBe("done");
  });

  test("accepts a cycle", () => {
    const flow = validateFlow({
      name: "loop",
      entry: "ask",
      steps: [
        waitPerson("ask", { yes: "ask", no: "done", interrupted: "done" }),
        endStep("done"),
      ],
    });
    expect(flow.steps).toHaveLength(2);
  });

  test("names an unknown entry", () => {
    const error = errorOf(() => validateFlow({ name: "greet", entry: "ghost", steps: [endStep("done")] }));
    expect(error.message).toContain('flow "greet"');
    expect(error.message).toContain("entry");
    expect(error.message).toContain('"ghost"');
  });

  test("names duplicate step ids", () => {
    const error = errorOf(() =>
      validateFlow({ name: "greet", entry: "a", steps: [endStep("a"), endStep("a")] }),
    );
    expect(error.message).toContain('step "a"');
    expect(error.message).toContain("id");
    expect(error.message).toContain("duplicate");
  });

  test("names an edge to an unknown step", () => {
    const error = errorOf(() =>
      validateFlow({
        name: "greet",
        entry: "ask",
        steps: [waitPerson("ask", { yes: "ghost", no: "end", interrupted: "end" })],
      }),
    );
    expect(error.message).toContain('step "ask"');
    expect(error.message).toContain("next.yes");
    expect(error.message).toContain('"ghost"');
  });

  test("names a result with no edge", () => {
    const error = errorOf(() =>
      validateFlow({
        name: "greet",
        entry: "ask",
        steps: [waitPerson("ask", { yes: "end", no: "end" })],
      }),
    );
    expect(error.message).toContain('step "ask"');
    expect(error.message).toContain("next");
    expect(error.message).toContain('"interrupted"');
  });

  test("names an edge for a result the step cannot produce", () => {
    const error = errorOf(() =>
      validateFlow({
        name: "greet",
        entry: "ask",
        steps: [
          waitPerson("ask", { yes: "end", no: "end", interrupted: "end", maybe: "end" }),
        ],
      }),
    );
    expect(error.message).toContain('step "ask"');
    expect(error.message).toContain("next.maybe");
    expect(error.message).toContain("not a result");
  });

  test("names an unknown plugin step type", () => {
    const error = errorOf(() =>
      validateFlow({
        name: "deploy",
        entry: "run",
        steps: [
          {
            id: "run",
            kind: "plugin",
            params: { use: "dev/nope", params: {} },
            replay: "safe",
            next: {},
          },
        ],
      }),
    );
    expect(error.message).toContain('step "run"');
    expect(error.message).toContain("params.use");
    expect(error.message).toContain('"dev/nope"');
  });

  test("matches a plugin step type by its full name only", () => {
    const pluginFlow = (use: string) => ({
      name: "deploy",
      entry: "run",
      steps: [
        {
          id: "run",
          kind: "plugin",
          params: { use, params: {} },
          replay: "safe",
          next: { ok: "end" },
        },
      ],
    });
    const waitFlow = (check: string) => ({
      name: "ci",
      entry: "watch",
      steps: [
        {
          id: "watch",
          kind: "wait",
          params: { check },
          replay: "safe",
          next: { ready: "end", interrupted: "end" },
        },
      ],
    });
    const other = [{ name: "other/command", results: ["ok"] }];

    expect(errorOf(() => validateFlow(pluginFlow("dev/command"), other)).message).toContain(
      'params.use: unknown plugin step type "dev/command"',
    );
    expect(errorOf(() => validateFlow(waitFlow("dev/command"), other)).message).toContain(
      'params.check: unknown plugin step type "dev/command"',
    );
    expect(
      errorOf(() => validateFlow(pluginFlow("dev/command"), [{ name: "command", results: ["ok"] }]))
        .message,
    ).toContain('unknown plugin step type "dev/command"');
  });

  test("takes plugin result names from the registry", () => {
    const flow = {
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
    };
    expect(validateFlow(flow, [{ name: "dev/command", results: ["ok", "failed"] }]).name).toBe("deploy");

    const error = errorOf(() =>
      validateFlow(
        {
          ...flow,
          steps: [{ ...flow.steps[0], next: { ok: "end" } }],
        },
        [{ name: "dev/command", results: ["ok", "failed"] }],
      ),
    );
    expect(error.message).toContain('no edge for result "failed"');
  });

  test("accepts a single step type declaration as the registry", () => {
    const flow = validateFlow(
      {
        name: "deploy",
        entry: "run",
        steps: [
          {
            id: "run",
            kind: "plugin",
            params: { use: "dev/command", params: {} },
            replay: "safe",
            next: { ok: "end" },
          },
        ],
      },
      { name: "dev/command", results: ["ok"] },
    );
    expect(flow.entry).toBe("run");
  });

  test("accepts a wait with a declared check", () => {
    const flow = validateFlow(
      {
        name: "ci",
        entry: "watch",
        steps: [
          {
            id: "watch",
            kind: "wait",
            params: { check: "dev/check" },
            replay: "safe",
            next: { ready: "done", interrupted: "done" },
          },
          endStep("done"),
        ],
      },
      [{ name: "dev/check", results: ["pass", "fail"] }],
    );
    expect(flow.entry).toBe("watch");
  });

  test("names an unknown wait check", () => {
    const error = errorOf(() =>
      validateFlow({
        name: "ci",
        entry: "watch",
        steps: [
          {
            id: "watch",
            kind: "wait",
            params: { check: "dev/nope" },
            replay: "safe",
            next: { ready: "end", interrupted: "end" },
          },
        ],
      }),
    );
    expect(error.message).toContain('step "watch"');
    expect(error.message).toContain("params.check");
  });

  test("requires exactly one wait parameter", () => {
    const base = {
      name: "ci",
      entry: "watch",
      steps: [
        {
          id: "watch",
          kind: "wait",
          params: {},
          replay: "safe",
          next: { ready: "end", interrupted: "end" },
        },
      ],
    };
    expect(errorOf(() => validateFlow(base)).message).toContain("exactly one");
    expect(
      errorOf(() =>
        validateFlow({
          ...base,
          steps: [{ ...base.steps[0], params: { afterSecs: 1, check: "dev/check" } }],
        }),
      ).message,
    ).toContain("exactly one");
  });

  test("names an unreachable step", () => {
    const error = errorOf(() =>
      validateFlow({
        name: "greet",
        entry: "done",
        steps: [endStep("done"), endStep("orphan")],
      }),
    );
    expect(error.message).toContain('step "orphan"');
    expect(error.message).toContain("unreachable");
    expect(error.message).toContain('"done"');
  });

  test("rejects next on an end step", () => {
    const error = errorOf(() =>
      validateFlow({
        name: "greet",
        entry: "done",
        steps: [{ ...endStep("done"), next: { done: "end" } }],
      }),
    );
    expect(error.message).toContain('step "done"');
    expect(error.message).toContain("next.done");
    expect(error.message).toContain("not a result");
  });

  test("reserves the end step id", () => {
    const error = errorOf(() =>
      validateFlow({ name: "greet", entry: "end", steps: [endStep("end")] }),
    );
    expect(error.message).toContain('step "end"');
    expect(error.message).toContain("reserved");
  });

  test("rejects an invalid maxVisits", () => {
    const error = errorOf(() =>
      validateFlow({ name: "greet", entry: "done", maxVisits: 0, steps: [endStep("done")] }),
    );
    expect(error.message).toContain("maxVisits");
  });
});
