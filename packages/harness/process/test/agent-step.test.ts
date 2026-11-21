import { afterAll, describe, expect, test } from "bun:test";
import type { StepContext } from "@operad-io/engine";
import { readAgentStep, type AgentStepSpec } from "../src/index.ts";
import { cleanupTempRoots, tempRoot } from "./support.ts";

/** The context fields readAgentStep reads: no profile, no secret, a logger. */
function context(home: string): StepContext {
  const messages: string[] = [];
  const fake = {
    home,
    settings: {},
    access: undefined,
    params: {},
    trigger: undefined,
    flow: undefined,
    signal: new AbortController().signal,
    secrets: {
      names: async () => [],
      get: async () => undefined,
    },
    logger: {
      path: "/tmp/step.log",
      write: async (text: string) => {
        messages.push(text);
        return "/tmp/step.log";
      },
    },
  };
  return fake as unknown as StepContext;
}

const SPEC: AgentStepSpec<"low" | "high"> = {
  at: "codex/agent",
  harness: "codex",
  flags: { levelFlag: "--effort", levels: ["low", "high"], modelHint: "<name>" },
  defaultWallTimeSecs: 3_600,
  defaultStallSecs: 600,
  maxWallTimeSecs: 8 * 3_600 - 300,
  levelSetting: "effort",
  now: () => 1_000,
  refusalExtra: { imageGenCalls: 0 },
};

afterAll(cleanupTempRoots);

describe("the early refusal", () => {
  test("names the reason and the field, with the data every harness writes", async () => {
    const home = await tempRoot();
    const step = await readAgentStep(context(home), { prompt: "hi", cwd: home, args: ["--sandbox", "none"] }, SPEC);
    expect("refused" in step).toBe(true);
    if (!("refused" in step)) return;
    expect(step.refused.result).toBe("failed");
    const data = step.refused.data as Record<string, unknown>;
    expect(data["reason"]).toBe("invalid_args");
    expect(data["message"]).toBe('codex/agent: args: unknown entry "--sandbox"; expected --model <name> or --effort <level>');
    expect(data["exitCode"]).toBeNull();
    expect(data["signal"]).toBeNull();
    expect(data["sessionId"]).toBeNull();
    expect(data["finalMessage"]).toBeNull();
    expect(data["log"]).toBe("/tmp/step.log");
    expect(data["stderr"]).toEqual([data["message"]]);
    expect(data["usage"]).toMatchObject({ harness: "codex", model: null });
    expect(data["timings"]).toMatchObject({ totalMs: 0 });
    expect(data["imageGenCalls"]).toBe(0);
  });

  test("a directory that is not there refuses with reason cwd and the harness's extra", async () => {
    const home = await tempRoot();
    const step = await readAgentStep(context(home), { prompt: "hi", cwd: `${home}/missing` }, SPEC);
    expect("refused" in step).toBe(true);
    if (!("refused" in step)) return;
    const data = step.refused.data as Record<string, unknown>;
    expect(data["reason"]).toBe("cwd");
    expect(String(data["message"]).length).toBeGreaterThan(0);
    expect(data["imageGenCalls"]).toBe(0);
  });
});
