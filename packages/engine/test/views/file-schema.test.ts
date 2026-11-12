import { expect, test } from "bun:test";
import { fileProperties, normalizeActionArgs } from "../../src/plugin/action-schema.ts";

test("an action declares a file argument as a string, or a list of strings, with format file", () => {
  const schema = normalizeActionArgs(
    {
      type: "object",
      properties: {
        photo: { type: "string", format: "file" },
        more: { type: "array", items: { type: "string", format: "file" } },
        note: { type: "string" },
      },
    },
    "action",
  );
  expect(fileProperties(schema)).toEqual([
    { name: "photo", many: false },
    { name: "more", many: true },
  ]);
});

test("a file argument that is not text, or a format the kernel does not know, is refused at load", () => {
  expect(() =>
    normalizeActionArgs({ type: "object", properties: { a: { type: "integer", format: "file" } } }, "action"),
  ).toThrow('a file property must have type "string"');
  expect(() =>
    normalizeActionArgs({ type: "object", properties: { a: { type: "string", format: "date" } } }, "action"),
  ).toThrow('format: must be "file"');
});
