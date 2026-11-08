import { describe, expect, test } from "bun:test";
import { loadsAsWellAs, problemKey } from "../src/code-reload.ts";

describe("what counts as loading", () => {
  test("a problem is keyed by its plugin, else by its text", () => {
    expect(problemKey('plugin "dev": import failed: boom')).toBe("dev");
    expect(problemKey('plugin "dev": requires x')).toBe("dev");
    expect(problemKey("triggers.json: bad")).toBe("triggers.json: bad");
  });

  test("no problems loads; a new problem does not; a known one does", () => {
    expect(loadsAsWellAs([], [])).toBe(true);
    expect(loadsAsWellAs(['plugin "a": import failed'], [])).toBe(false);
    expect(loadsAsWellAs(['plugin "a": import failed: other words'], ['plugin "a": import failed'])).toBe(true);
    expect(loadsAsWellAs(['plugin "b": import failed'], ['plugin "a": import failed'])).toBe(false);
  });
});
