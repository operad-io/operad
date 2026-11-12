import { describe, expect, test } from "bun:test";
import { createPiHarnessPlugin, PI_EFFORTS } from "../src/index.ts";
import { THINKING_LEVELS } from "../src/protocol.ts";

describe("the efforts pi declares", () => {
  test("its thinking levels under the same setting, a default, and the thinking flag", () => {
    const { efforts } = createPiHarnessPlugin();
    expect(efforts.list).toEqual([...THINKING_LEVELS]);
    expect(efforts.default).toBe("medium");
    expect(efforts.list).toContain(efforts.default);
    expect(efforts.flag).toBe("--thinking");
    expect(efforts).toEqual(PI_EFFORTS);
  });
});
