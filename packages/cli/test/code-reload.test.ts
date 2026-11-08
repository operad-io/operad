import { describe, expect, test } from "bun:test";
import { loadsAsWellAs, problemKey } from "../src/code-reload.ts";

describe("what counts as loading", () => {
  test("a problem is the same one only when it says the same thing", () => {
    expect(problemKey('plugin "dev": import failed: x.ts?operad-plugin-load=3')).toBe(
      problemKey('plugin "dev": import failed: x.ts?operad-plugin-load=9'),
    );
    expect(problemKey('plugin "dev": onTick failed: boom')).not.toBe(
      problemKey('plugin "dev": import failed: boom'),
    );
  });

  test("no problems loads; a new problem does not; a known one does", () => {
    expect(loadsAsWellAs([], [])).toBe(true);
    expect(loadsAsWellAs(['plugin "a": import failed'], [])).toBe(false);
    expect(loadsAsWellAs(['plugin "a": import failed'], ['plugin "a": import failed'])).toBe(true);
    expect(loadsAsWellAs(['plugin "a": import failed: new'], ['plugin "a": import failed'])).toBe(false);
    expect(loadsAsWellAs(['plugin "b": import failed'], ['plugin "a": import failed'])).toBe(false);
  });
});
