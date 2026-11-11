import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createViews,
  MemoryPluginStore,
  PluginRegistry,
  ViewError,
  type Views,
} from "../../src/index.ts";
import { normalizeActionArgs, validateSchemaValue } from "../../src/plugin/action-schema.ts";
import { cleanupTempRoots, def, tempRoot } from "../plugin/support.ts";

afterAll(cleanupTempRoots);

const CHECK = {
  oneOf: [
    { type: "string", minLength: 1 },
    {
      type: "object",
      properties: { run: { type: "string", minLength: 1 }, failed: { type: "object" } },
      required: ["run"],
      additionalProperties: false,
    },
  ],
};

const FILE = {
  gate: {
    commands: [{ run: "bun test", failed: { match: "x", rerun: "y" } }, "tsc"],
    commandTimeoutSecs: 60,
  },
  concurrency: 1,
  flows: { a: [{ stage: "check", commands: [{ run: "z" }] }] },
};

async function setup(file: unknown): Promise<{ views: Views; text: () => string }> {
  const root = await tempRoot();
  const home = join(root, "home");
  const repo = join(root, "alpha");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, ".operad"), { recursive: true });
  writeFileSync(join(home, "config.json"), "{}\n");
  const path = join(repo, ".operad", "dev.json");
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  const store = new MemoryPluginStore({ root });
  const registry = new PluginRegistry(
    [
      def({
        name: "demo",
        projectSettings: {
          repositories: () => [{ name: "alpha", path: repo }],
          files: [
            {
              name: "dev",
              path: "dev.json",
              schema: {
                type: "object",
                $defs: { check: CHECK },
                properties: {
                  concurrency: { type: "integer", minimum: 1, editable: true },
                  gate: {
                    type: "object",
                    properties: {
                      commands: {
                        type: "array",
                        items: { $ref: "#/$defs/check" },
                        editable: true,
                      },
                      commandTimeoutSecs: { type: "number", editable: true },
                    },
                  },
                },
              },
            },
          ],
        },
      }),
    ],
    { home, store, settings: {} },
  );
  return { views: createViews({ registry, store }), text: () => readFileSync(path, "utf8") };
}

describe("settings with a choice of forms", () => {
  test("a set keeps the object form of a check command and every other value", async () => {
    const { views, text } = await setup(FILE);
    await views.set("demo.dev.concurrency", 3, { scope: "alpha" });
    expect(JSON.parse(text())).toEqual({ ...FILE, concurrency: 3 });
    await views.set("demo.dev.gate.commandTimeoutSecs", 90, { scope: "alpha" });
    expect(JSON.parse(text()).gate.commands).toEqual(FILE.gate.commands);
  });

  test("a value that fits neither form is refused in words a person reads", async () => {
    const { views, text } = await setup(FILE);
    const before = text();
    const error = await views
      .set("demo.dev.gate.commands", ["ok", 5], { scope: "alpha" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ViewError);
    const message = (error as ViewError).message;
    expect(message).toContain("gate.commands");
    expect(message).toContain("non-empty text or an object");
    expect(message).not.toMatch(/oneOf|\$ref/);
    const inner = await views
      .set("demo.dev.gate.commands", [{ run: 1 }], { scope: "alpha" })
      .catch((e: unknown) => e);
    expect((inner as ViewError).message).toContain("run: must be a string");
    expect(text()).toBe(before);
  });
});

describe("schema features the shipped schemas use", () => {
  const check = (schema: unknown, value: unknown): void => {
    const normalized = normalizeActionArgs(schema, "s");
    if (normalized === undefined) throw new Error("no schema");
    validateSchemaValue(normalized, value, "x", "v");
  };

  test("a $ref is followed, and a bad one is refused at load", () => {
    const schema = {
      type: "object",
      $defs: { name: { type: "string", minLength: 2 } },
      properties: { a: { $ref: "#/$defs/name", description: "A name." } },
    };
    expect(() => check(schema, { a: "ok" })).not.toThrow();
    expect(() => check(schema, { a: "o" })).toThrow("at least 2 characters");
    expect(() => normalizeActionArgs({ type: "object", properties: { a: { $ref: "#/$defs/none" } } }, "s")).toThrow("$defs");
    expect(() =>
      normalizeActionArgs({ type: "object", $defs: { r: { $ref: "#/$defs/r" } }, properties: { a: { $ref: "#/$defs/r" } } }, "s"),
    ).toThrow("refers to itself");
  });

  test("oneOf, const, pattern, exclusiveMinimum, minItems and minProperties", () => {
    const schema = {
      type: "object",
      properties: {
        color: { oneOf: [{ type: "string", pattern: "^#[0-9a-f]{6}$" }, { type: "integer", minimum: 0, maximum: 15 }] },
        stage: { const: "work" },
        n: { type: "integer", exclusiveMinimum: 0 },
        share: { type: "number", exclusiveMaximum: 1, deprecated: true, readOnly: true },
        list: { type: "array", minItems: 1 },
        map: { type: "object", minProperties: 1 },
      },
    };
    expect(() => check(schema, { color: "#00ff00", stage: "work", n: 1, list: [1], map: { a: 1 } })).not.toThrow();
    expect(() => check(schema, { color: 7 })).not.toThrow();
    expect(() => check(schema, { color: "red" })).toThrow("v.color: must be written as");
    expect(() => check(schema, { color: true })).toThrow("must be text written as");
    expect(() => check(schema, { stage: "x" })).toThrow('must be "work"');
    expect(() => check(schema, { share: 0.5 })).not.toThrow();
    expect(() => check(schema, { share: 1 })).toThrow("must be less than 1");
    expect(() => check(schema, { n: 0 })).toThrow("must be more than 0");
    expect(() => check(schema, { list: [] })).toThrow("at least 1 items");
    expect(() => check(schema, { map: {} })).toThrow("at least 1 fields");
  });
});
