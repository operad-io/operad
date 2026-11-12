import { describe, expect, test } from "bun:test";
import {
  DEFAULT_POOL,
  WorkerDefinitionError,
  parseWorkers,
  readResolved,
  resolvePool,
} from "../src/index.ts";

function refused(workers: unknown, pools: unknown, prefix = ""): WorkerDefinitionError {
  try {
    parseWorkers(workers, pools, prefix);
  } catch (error) {
    if (error instanceof WorkerDefinitionError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const claude = { use: "claude/agent" };
const pi = { use: "pi/agent" };

describe("parseWorkers", () => {
  test("fills defaults and makes one default pool of every worker in written order", () => {
    const parsed = parseWorkers({ pi, claude }, undefined);
    expect(parsed.workers).toEqual([
      { name: "pi", use: "pi/agent", args: [], count: 1 },
      { name: "claude", use: "claude/agent", args: [], count: 1 },
    ]);
    expect(parsed.pools).toEqual({ [DEFAULT_POOL]: ["pi", "claude"] });
  });

  test("keeps every field and the pools as written", () => {
    const parsed = parseWorkers(
      {
        claude: { ...claude, args: ["--model", "sonnet"], count: 2, wallTimeSecs: 60, stallSecs: 5, fallback: "pi" },
        pi,
      },
      { design: ["pi"], default: ["claude", "pi"] },
    );
    expect(parsed.workers[0]).toEqual({
      name: "claude",
      use: "claude/agent",
      args: ["--model", "sonnet"],
      count: 2,
      wallTimeSecs: 60,
      stallSecs: 5,
      fallback: "pi",
    });
    expect(parsed.pools).toEqual({ design: ["pi"], default: ["claude", "pi"] });
  });

  const cases: [string, unknown, unknown, string, string][] = [
    ["workers not an object", [], undefined, "workers", "must be an object"],
    ["no workers", {}, undefined, "workers", "at least one worker"],
    ["worker not an object", { claude: "x" }, undefined, "workers.claude", "must be an object"],
    ["unknown field", { claude: { ...claude, model: "x" } }, undefined, "workers.claude.model", "not a worker field"],
    ["no use", { claude: {} }, undefined, "workers.claude.use", "step name"],
    ["use without a step", { claude: { use: "claude" } }, undefined, "workers.claude.use", "step name"],
    ["args not a list", { claude: { ...claude, args: "x" } }, undefined, "workers.claude.args", "array of strings"],
    ["args entry not a string", { claude: { ...claude, args: ["a", 1] } }, undefined, "workers.claude.args[1]", "must be a string"],
    ["count 0", { claude: { ...claude, count: 0 } }, undefined, "workers.claude.count", "integer of 1 or more"],
    ["count fraction", { claude: { ...claude, count: 1.5 } }, undefined, "workers.claude.count", "integer of 1 or more"],
    ["count string", { claude: { ...claude, count: "2" } }, undefined, "workers.claude.count", "integer of 1 or more"],
    ["wallTimeSecs 0", { claude: { ...claude, wallTimeSecs: 0 } }, undefined, "workers.claude.wallTimeSecs", "positive number"],
    ["stallSecs negative", { claude: { ...claude, stallSecs: -1 } }, undefined, "workers.claude.stallSecs", "positive number"],
    ["fallback not a string", { claude: { ...claude, fallback: 3 } }, undefined, "workers.claude.fallback", "worker name"],
    ["fallback unknown", { claude: { ...claude, fallback: "nope" } }, undefined, "workers.claude.fallback", '"nope" is not a worker'],
    ["fallback itself", { claude: { ...claude, fallback: "claude" } }, undefined, "workers.claude.fallback", "itself"],
    [
      "fallback chain",
      { a: { ...claude, fallback: "b" }, b: { ...pi, fallback: "c" }, c: pi },
      undefined,
      "workers.a.fallback",
      "one step",
    ],
    [
      "fallback cycle",
      { a: { ...claude, fallback: "b" }, b: { ...pi, fallback: "a" } },
      undefined,
      "workers.a.fallback",
      "each other",
    ],
    ["pools not an object", { claude }, [], "pools", "must be an object"],
    ["no pools", { claude }, {}, "pools", "at least one pool"],
    ["empty pool", { claude }, { default: [] }, "pools.default", "non-empty list"],
    ["pool not a list", { claude }, { default: "claude" }, "pools.default", "non-empty list"],
    ["pool entry not a string", { claude }, { default: [1] }, "pools.default[0]", "worker name"],
    ["unknown worker in a pool", { claude }, { default: ["claude", "gone"] }, "pools.default[1]", '"gone" is not a worker'],
  ];
  for (const [title, workers, pools, field, text] of cases) {
    test(`refuses: ${title}`, () => {
      const error = refused(workers, pools);
      expect(error.field).toBe(field);
      expect(error.message).toStartWith(`${field}: `);
      expect(error.message).toContain(text);
    });
  }

  test("a prefix goes in front of every path", () => {
    expect(refused({ claude: { ...claude, fallback: "x" } }, undefined, "settings").field).toBe(
      "settings.workers.claude.fallback",
    );
    expect(refused({ claude }, { default: ["x"] }, "settings").field).toBe("settings.pools.default[0]");
  });
});

describe("resolvePool", () => {
  test("gives the pool's workers in order and the fallbacks outside the pool", () => {
    const parsed = parseWorkers(
      { claude: { ...claude, fallback: "pi" }, pi, codex: { use: "harness-codex/agent" } },
      { default: ["claude"], design: ["codex", "claude"] },
    );
    const one = resolvePool(parsed, "default");
    expect(one.workers.map((item) => item.name)).toEqual(["claude"]);
    expect(one.fallbacks.map((item) => item.name)).toEqual(["pi"]);
    const two = resolvePool(parsed, "design");
    expect(two.workers.map((item) => item.name)).toEqual(["codex", "claude"]);
    expect(two.fallbacks.map((item) => item.name)).toEqual(["pi"]);
    expect(() => resolvePool(parsed, "nope")).toThrow("pools.nope");
  });
});

describe("readResolved", () => {
  test("reads named workers and refuses a repeat or a bad field", () => {
    expect(readResolved([{ name: "a", use: "h/agent" }], "workers")[0]?.count).toBe(1);
    expect(() => readResolved([{ name: "a", use: "h/agent" }, { name: "a", use: "h/agent" }], "workers")).toThrow(
      "workers[1].name",
    );
    expect(() => readResolved([{ name: "a", use: "h/agent", count: 0 }], "workers")).toThrow("workers[0].count");
    expect(() => readResolved("x", "workers")).toThrow("workers");
  });
});
