import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  END_RESULTS,
  PluginError,
  PluginRegistry,
  isEndResult,
  readUsage,
  validateUsage,
} from "../../src/index.ts";
import { def } from "./support.ts";

const standard = {
  harness: "harness-pi",
  model: "p/m",
  tokens: { input: 11, output: 7, cacheread: 3, cachewrite: 2 },
  costMicros: 1234,
};

describe("validateUsage", () => {
  test("accepts the standard shape, with a null model and a null cost", () => {
    expect(validateUsage(standard)).toEqual({ ok: true, usage: standard });
    const unknown = { ...standard, model: null, costMicros: null };
    expect(validateUsage(unknown).ok).toBe(true);
    expect(validateUsage({ ...standard, costMicros: 0 }).ok).toBe(true);
  });

  test("refuses each wrong field and names it", () => {
    const wrong: [unknown, string][] = [
      ["x", ""],
      [{ ...standard, harness: "" }, "harness"],
      [{ ...standard, harness: 3 }, "harness"],
      [{ ...standard, model: 3 }, "model"],
      [{ ...standard, model: undefined }, "model"],
      [{ ...standard, tokens: null }, "tokens"],
      [{ ...standard, tokens: { ...standard.tokens, input: -1 } }, "tokens.input"],
      [{ ...standard, tokens: { ...standard.tokens, output: 1.5 } }, "tokens.output"],
      [{ ...standard, tokens: { ...standard.tokens, cacheread: "3" } }, "tokens.cacheread"],
      [{ ...standard, tokens: { input: 1, output: 1, cacheread: 1 } }, "tokens.cachewrite"],
      [{ ...standard, costMicros: -5 }, "costMicros"],
      [{ ...standard, costMicros: 1.5 }, "costMicros"],
      [{ ...standard, costMicros: undefined }, "costMicros"],
    ];
    for (const [value, field] of wrong) {
      const checked = validateUsage(value);
      expect(checked.ok).toBe(false);
      if (!checked.ok) {
        expect(checked.field).toBe(field);
        expect(checked.message).toContain(field === "" ? "usage" : `usage.${field}`);
      }
    }
  });
});

describe("readUsage", () => {
  test("reads the standard field", () => {
    expect(readUsage({ usage: standard })).toEqual(standard);
  });

  test("reads a fact stored before the standard field existed", () => {
    // Stored as harness-radian and harness-pi wrote it.
    const stored = JSON.parse(
      '{"exitCode":0,"usage":{"input":11,"output":7,"cache_read":3},"cost":{"micros":1234,"incomplete":false,"estimated":false},"log":"x"}',
    );
    expect(readUsage(stored)).toEqual({
      harness: "unknown",
      model: null,
      tokens: { input: 11, output: 7, cacheread: 3, cachewrite: 0 },
      costMicros: 1234,
    });
    expect(readUsage({ usage: {}, cost: null })?.costMicros).toBeNull();
  });

  test("data without usage, or with a wrong standard field, gives none", () => {
    expect(readUsage({ log: "x" })).toBeUndefined();
    expect(readUsage(null)).toBeUndefined();
    expect(readUsage({ usage: { ...standard, costMicros: -1 } })).toBeUndefined();
  });
});

describe("end results", () => {
  test("the manual's table lists exactly the exported results", () => {
    const manual = readFileSync(new URL("../../../../docs/manual.md", import.meta.url), "utf8");
    const section = manual.slice(manual.indexOf("A step ends with one of these results:"));
    const table = section.split("\n").slice(2);
    const end = table.findIndex((line) => !line.startsWith("|"));
    const rows = table
      .slice(0, end)
      .filter((line) => line.startsWith("| `"))
      .map((line) => /^\| `([a-z_]+)`/.exec(line)?.[1]);
    expect(rows).toEqual([...END_RESULTS]);
    expect(isEndResult("nothing")).toBe(true);
    expect(isEndResult("cancelled")).toBe(false);
  });

  test("the plugin check refuses a harness step that declares another name", () => {
    const harness = (results: string[]) =>
      new PluginRegistry([
        def({
          name: "h",
          kind: "harness",
          steps: [{ name: "agent", results, run: () => ({ result: "done" }) } as never],
        }),
      ]);
    expect(harness(["done", "failed", "interrupted", "needs_decision"]).names()).toEqual(["h"]);
    let error: unknown;
    try {
      harness(["done", "cancelled"]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PluginError);
    expect((error as Error).message).toContain('plugin "h"');
    expect((error as Error).message).toContain('step "agent"');
    expect((error as Error).message).toContain('"cancelled"');
  });

  test("a plugin of another kind may name its results freely", () => {
    const registry = new PluginRegistry([
      def({
        name: "d",
        steps: [{ name: "s", results: ["ok", "cancelled"], run: () => ({ result: "ok" }) } as never],
      }),
    ]);
    expect(registry.names()).toEqual(["d"]);
  });
});
