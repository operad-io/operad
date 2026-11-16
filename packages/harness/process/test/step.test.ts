import { describe, expect, test } from "bun:test";
import { modelErrorOf, parseResult, parseStepFlags, resultFor, type AgentWorkerResult } from "../src/index.ts";

// Moved from packages/harness/claude/test/heavy/plugin.test.ts.
describe("modelErrorOf", () => {
  test("a usage-limit text wins over a 429 in the same text", () => {
    expect(modelErrorOf("429 usage limit reached").kind).toBe("usage_limit");
    expect(modelErrorOf("provider is overloaded").kind).toBe("unavailable");
    expect(modelErrorOf("a 4290 tokens message").kind).toBe("protocol");
  });
});

describe("parseStepFlags", () => {
  const spec = { levelFlag: "--effort", levels: ["low", "high"], modelHint: "<name>" } as const;

  test("reads a model and a level", () => {
    expect(parseStepFlags(["--model", "opus", "--effort", "high"], spec)).toEqual({ model: "opus", level: "high" });
    expect(parseStepFlags([], spec)).toEqual({});
  });

  test("names the entry it refuses", () => {
    expect(parseStepFlags(["--bogus"], spec)).toContain('unknown entry "--bogus"');
    expect(parseStepFlags(["--model", "--effort", "high"], spec)).toBe('args: "--model" has no value');
    expect(parseStepFlags(["--model", "a", "--model", "b"], spec)).toBe('args: "--model" is given twice');
    expect(parseStepFlags(["--effort", "max"], spec)).toContain("must be one of low, high");
  });

  test("a harness may refuse a model value", () => {
    const strict = { ...spec, modelProblem: (value: string) => (value.includes("/") ? undefined : "nope") };
    expect(parseStepFlags(["--model", "a"], strict)).toBe("nope");
  });

  test("a harness may take a value that starts with a dash", () => {
    expect(parseStepFlags(["--model", "--effort", "high"], spec)).toBe('args: "--model" has no value');
    const dashed = { ...spec, dashValues: true, modelProblem: () => "named" };
    expect(parseStepFlags(["--model", "--effort"], dashed)).toBe("named");
    expect(parseStepFlags(["--model"], dashed)).toBe('args: "--model" has no value');
  });
});

describe("resultFor", () => {
  test("a done result keeps the reason the worker gave for answering with nothing", () => {
    const outcome = {
      exitCode: 0,
      signal: null,
      cancelled: false,
      wall: false,
      stall: false,
      lineTooLong: false,
      missing: false,
      spawnError: undefined,
      stderrTail: [],
    };
    const worker: AgentWorkerResult = {
      type: "result",
      result: "done",
      sessionId: "s",
      usage: {},
      cost: null,
      finalMessage: "",
      message: "the agent reported success; it ran the local command /clear",
    };
    const step = resultFor(
      { harness: "fake", model: null },
      outcome,
      worker,
      "/tmp/log",
      1,
      { wallTimeSecs: 1, stallSecs: 1 },
      "fake",
    );
    expect(step.result).toBe("done");
    expect(step.data).toMatchObject({ message: "the agent reported success; it ran the local command /clear" });
  });
});

describe("parseResult", () => {
  test("reads a result line and nothing else", () => {
    expect(parseResult('{"type":"result","result":"done"}')?.result).toBe("done");
    expect(parseResult('{"type":"result","result":"weird"}')).toBeUndefined();
    expect(parseResult('{"type":"message_end"}')).toBeUndefined();
    expect(parseResult("not json")).toBeUndefined();
  });
});
