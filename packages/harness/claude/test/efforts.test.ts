import { describe, expect, test } from "bun:test";
import type { HarnessEfforts } from "@operad-io/engine";
import { createClaudeHarnessPlugin } from "../src/index.ts";
import { EFFORT_LEVELS } from "../src/protocol.ts";

function effortsOf(settings: Record<string, unknown> = {}): HarnessEfforts {
  const plugin = createClaudeHarnessPlugin();
  if (plugin.efforts === undefined) throw new Error("claude declares no efforts");
  return typeof plugin.efforts === "function" ? plugin.efforts(settings) : plugin.efforts;
}

describe("the efforts claude declares", () => {
  test("its effort levels, the configured default, and its own flag", () => {
    const efforts = effortsOf();
    expect(efforts.list).toEqual([...EFFORT_LEVELS]);
    expect(efforts.default).toBeNull();
    expect(efforts.flag).toBe("--effort");
  });

  test("the configured effort is the default", () => {
    expect(effortsOf({ effort: "high" }).default).toBe("high");
  });

  test("an effort claude does not list leaves no default", () => {
    expect(effortsOf({ effort: "extreme" }).default).toBeNull();
  });
});
