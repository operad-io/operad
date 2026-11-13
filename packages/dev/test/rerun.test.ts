import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepContext } from "@operad-io/engine";
import { notCodeTestHooks, runCheckSteadily } from "../src/notcode.ts";
import { anchoredPattern, rerunCommand, runCheckCommands } from "../src/rerun.ts";

describe("rerun command", () => {
  test("the pattern is anchored and joins describe names with a space, as bun test -t does", () => {
    expect(anchoredPattern("a > b (c)")).toBe("^a b \\(c\\)$");
    expect(rerunCommand("bun test -t {pattern}", "it's")).toBe("bun test -t '^it'\\''s$'");
    expect(rerunCommand("run {name} {name}", "$x")).toBe("run '$x' '$x'");
  });
});

describe("a failed test that fails again when run alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "rerun-alone-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const logPath = join(dir, "check.log");
  const command = { run: "bun test", failed: { match: "^\\(fail\\) (.+?) \\[", rerun: "bun test -t {pattern}", max: 3 } };
  const slow = "(fail) a > slow [30001.00ms]\n";

  function runStep(lines: string[]): NonNullable<StepContext["runStep"]> {
    return async (_name, params) => {
      const line = (params as { lines: string[] }).lines[0] ?? "";
      lines.push(line);
      writeFileSync(logPath, slow);
      return {
        result: "fail",
        data: { reason: "exit", exitCode: 1, line, log: logPath, logStart: 0 },
      };
    };
  }

  test("the result says it was the test's own rerun, and a quiet machine makes it the code", async () => {
    notCodeTestHooks.load = () => ({ load1: 2, cores: 10 });
    try {
      const lines: string[] = [];
      const steady = await runCheckSteadily({
        run: () => runCheckCommands(runStep(lines), { cwd: dir }, [command], {} as never, 1),
        limit: undefined,
      });
      expect(lines).toEqual(["bun test", "bun test -t '^a slow$'"]);
      expect(steady.checked.aloneRerun).toBe(true);
      expect(steady.runs).toBe(1);
      expect(steady.notCode).toBeUndefined();
    } finally {
      notCodeTestHooks.load = undefined;
    }
  });

  test("a timeout in the full run that passes alone is a pass after one run, not a failure", async () => {
    notCodeTestHooks.load = () => ({ load1: 1, cores: 10 });
    try {
      const lines: string[] = [];
      const steady = await runCheckSteadily({
        run: () =>
          runCheckCommands(
            async (_name, params) => {
              const line = (params as { lines: string[] }).lines[0] ?? "";
              lines.push(line);
              if (line === "bun test") {
                writeFileSync(logPath, slow);
                return { result: "fail", data: { reason: "exit", exitCode: 1, line, log: logPath, logStart: 0 } };
              }
              return { result: "pass", data: { lines: 1, tail: [] } };
            },
            { cwd: dir },
            [command],
            {} as never,
            1,
          ),
        limit: undefined,
      });
      expect(lines).toEqual(["bun test", "bun test -t '^a slow$'"]);
      expect(steady.checked.outcome?.result).toBe("pass");
      expect(steady.checked.passedOnRerun).toEqual(["a > slow"]);
      expect(steady.runs).toBe(1);
      expect(steady.notCode).toBeUndefined();
    } finally {
      notCodeTestHooks.load = undefined;
    }
  });
});
