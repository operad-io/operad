import { describe, expect, test } from "bun:test";
import { modelErrorOf, parseResult, parseStepFlags } from "../src/index.ts";

// Moved from packages/harness/claude/test/plugin.test.ts.
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

describe("parseResult", () => {
  test("reads a result line and nothing else", () => {
    expect(parseResult('{"type":"result","result":"done"}')?.result).toBe("done");
    expect(parseResult('{"type":"result","result":"weird"}')).toBeUndefined();
    expect(parseResult('{"type":"message_end"}')).toBeUndefined();
    expect(parseResult("not json")).toBeUndefined();
  });
});
