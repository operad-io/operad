/**
 * The docs name every input of the plugin and the worker. A setting, a flag, a
 * stdin field, a stdout line, a tool of the access table or an environment
 * variable that the code has and the docs lack fails here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { INERT_TOOLS, TOOL_TABLE } from "../src/access.ts";
import { CLAUDE_FLOOR } from "../src/claude-install.ts";
import { PLUGIN_SETTINGS } from "../src/index.ts";
import { EFFORT_LEVELS, INPUT_FIELDS } from "../src/protocol.ts";
import { ISOLATION_ENV } from "../src/worker.ts";

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

const README = read("../README.md");
const DOGFOOD = read("../../../docs/dogfood.md");
const ACCEPTANCE = read("../acceptance.md");
const MANUAL = read("../../../docs/manual.md");

/** The dogfood section for claude, from its heading to the end. */
const SECTION = DOGFOOD.slice(DOGFOOD.indexOf("## Using claude as the worker"));

/** The table row of the README that starts with `| \`name\` |`, or undefined. */
function row(doc: string, name: string): string | undefined {
  return doc.split("\n").find((line) => line.startsWith(`| \`${name}\``));
}

describe("the settings", () => {
  const properties = PLUGIN_SETTINGS.properties as Record<string, Record<string, unknown>>;

  for (const [name, schema] of Object.entries(properties)) {
    test(`${name}: the README row and the dogfood table document it`, () => {
      const readme = row(README, name);
      expect(readme).toBeDefined();
      // An enum names its values in the type column; any other type names the type.
      if (Array.isArray(schema["enum"])) {
        for (const value of schema["enum"] as string[]) expect(readme).toContain(`\`${value}\``);
      } else {
        expect(readme).toContain(String(schema["type"]));
      }
      const plainDefault = typeof schema["default"] === "string" || typeof schema["default"] === "number";
      if (plainDefault) expect(readme).toContain(`\`${String(schema["default"])}\``);
      expect(SECTION).toContain(`\`${name}\``);
      const dogfood = SECTION.split("\n").find((line) => line.startsWith(`| \`${name}\``));
      expect(dogfood).toBeDefined();
      if (plainDefault) expect(dogfood).toContain(String(schema["default"]));
      if (schema["maximum"] !== undefined) expect(dogfood).toContain(String(schema["maximum"]));
      if (schema["minimum"] !== undefined) expect(dogfood).toContain(String(schema["minimum"]));
    });
  }

  test("every effort level is in the README and the dogfood section", () => {
    for (const level of EFFORT_LEVELS) {
      expect(README).toContain(`\`${level}\``);
      expect(SECTION).toContain(`\`${level}\``);
    }
  });
});

describe("the step arguments", () => {
  for (const flag of ["--model", "--effort"]) {
    test(`${flag} is in the README args table and the dogfood table`, () => {
      expect(README).toContain(`| \`${flag}\``);
      expect(SECTION).toContain(`\`${flag} `);
    });
  }

  test("the README says that any other entry fails with invalid_args", () => {
    expect(README).toContain("`invalid_args`");
    expect(SECTION).toContain("`invalid_args`");
  });
});

describe("the worker", () => {
  for (const field of INPUT_FIELDS) {
    test(`stdin field ${field} is in the README table`, () => {
      expect(row(README, field)).toBeDefined();
    });
  }

  for (const type of ["session", "message_end", "tool_execution_start", "tool_execution_end", "blocked", "rate_limit", "grant_use", "result"]) {
    test(`stdout line ${type} is in the README table`, () => {
      expect(row(README, type)).toBeDefined();
    });
  }

  test("every isolation variable is named in the README", () => {
    for (const [name, value] of Object.entries(ISOLATION_ENV)) {
      expect(README).toContain(name);
      expect(value).toBe("1");
    }
  });

  test("every tool of the access table and every inert tool is in the README", () => {
    for (const rowOfTable of TOOL_TABLE) {
      const line = README.split("\n").find((text) => text.startsWith(`| \`${rowOfTable.claude}\` |`));
      expect(line).toBeDefined();
      expect(line).toContain(`\`${rowOfTable.tool}\``);
      expect(line).toContain(`\`${rowOfTable.from}\``);
      expect(line).toContain(rowOfTable.required ? "yes" : "no");
    }
    for (const name of INERT_TOOLS) expect(README).toContain(`\`${name}\``);
  });
});

describe("the environment and the login", () => {
  test("CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY are documented with what they do", () => {
    expect(SECTION).toContain("| `CLAUDE_CODE_OAUTH_TOKEN` (environment) | string | unset |");
    expect(SECTION).toContain("| `ANTHROPIC_API_KEY` (environment) | string | unset |");
    expect(SECTION).toContain("claude setup-token");
    expect(SECTION).toContain("bill that key");
    expect(README).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("the dogfood section says how to tell which credential a run used", () => {
    expect(SECTION).toContain("`apiKeySource`");
    expect(SECTION).toContain("`session` line");
    expect(README).toContain("`apiKeySource`");
  });

  test("the policy sentence, the session files and resuming by hand are there", () => {
    expect(SECTION).toContain("would not offer claude.ai login");
    expect(SECTION).toContain("~/.claude/projects/");
    expect(SECTION).toContain("claude --resume <id>");
  });

  test("the floor in the docs is the floor in the code", () => {
    expect(SECTION).toContain(`\`${CLAUDE_FLOOR}\``);
    expect(README).toContain(`\`${CLAUDE_FLOOR}\``);
  });

  test("the harness is called claude, not by the product's other name", () => {
    expect(SECTION).not.toContain("Claude Code");
    expect(README).not.toContain("Claude Code");
    expect(ACCEPTANCE).not.toContain("Claude Code");
  });
});

describe("the acceptance script", () => {
  test("it lists every point of the backlog's acceptance", () => {
    for (const heading of [
      "## 1. No platform binary after a frozen install",
      "## 2. `operad plugin check` reports both versions and the login",
      "## 4. One real step: usage, an estimated cost and a session id",
      "## 5. A second step resumes the same session",
      "## 6. A denied `Bash` call",
      "## 8. `askCommands` is refused when a run starts",
      "## 9. A dogfood task to `review` with claude as the worker",
      "## 10. `kill -9` on the worker",
    ]) {
      expect(ACCEPTANCE).toContain(heading);
    }
  });

  test("it does not touch this repository's dev.json", () => {
    expect(ACCEPTANCE).toContain("Nothing here changes this\nrepository's `.operad/dev.json`");
  });
});

describe("the manual", () => {
  test("lists harness-claude where it lists the other harnesses", () => {
    expect(MANUAL).toContain("`harness-claude` | `harness-claude:<model>`");
  });
});
