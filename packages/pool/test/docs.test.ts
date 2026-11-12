/**
 * The manual names every setting and field the code has, with its type and
 * default, and every refusal the parser makes. The lists come from the code.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_POOL,
  POOL_FIELDS,
  POOL_SETTINGS,
  WAITING_EVENT,
  WORKER_FIELDS,
} from "../src/index.ts";

const MANUAL = readFileSync(fileURLToPath(new URL("../../../docs/user/dev.md", import.meta.url)), "utf8");
const START = MANUAL.indexOf("## Sharing agents between flows");
const SECTION = MANUAL.slice(START, MANUAL.indexOf("## Usage and end results"));

function row(name: string, from = SECTION): string {
  const line = from.split("\n").find((text) => text.startsWith(`| \`${name}\` |`));
  if (line === undefined) throw new Error(`no table row for ${name}`);
  return line;
}

function shown(value: unknown): string {
  return value === undefined ? "unset" : JSON.stringify(value);
}

describe("the manual's pool section", () => {
  test("exists", () => {
    expect(START).toBeGreaterThan(0);
  });

  for (const [name, schema] of Object.entries(POOL_SETTINGS.properties)) {
    test(`setting ${name}: type, default and limits`, () => {
      const line = row(name);
      expect(line).toContain(`\`${shown(schema.default)}\``);
      expect(line).toContain("object");
      expect(line).toContain(`integer of ${schema.additionalProperties.minimum} or more`);
      expect(line).toContain(`settings.${name}`);
    });
  }

  test("the next pool/agent step to start takes a change", () => {
    expect(SECTION).toContain("next `pool/agent` step that starts");
  });

  for (const field of [...WORKER_FIELDS, ...POOL_FIELDS]) {
    test(`field ${field.name}: type and default`, () => {
      const line = row(field.name);
      expect(line).toContain(field.type);
      if (field.required) {
        expect(line).toContain("required");
      } else if (field.defaultText !== undefined) {
        expect(line).toContain(field.defaultText);
      } else if (field.default === undefined) {
        expect(line).toContain("unset");
      } else {
        expect(line).toContain(`\`${shown(field.default)}\``);
      }
    });
  }

  test("the default pool and the waiting event are named", () => {
    expect(SECTION).toContain(`\`${DEFAULT_POOL}\``);
    expect(SECTION).toContain(`\`${WAITING_EVENT}\``);
  });

  test("the recorded data fields are named", () => {
    for (const name of ["worker", "harness", "fallbackFrom", "unknown_worker"]) {
      expect(SECTION).toContain(`\`${name}\``);
    }
  });
});
