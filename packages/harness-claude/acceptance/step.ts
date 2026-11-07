/**
 * Runs one `harness-claude/agent` step by hand, for `acceptance.md`. It loads
 * the real plugin with the settings the flags give, runs the step in a
 * scratch home and prints what the step recorded. It makes a real model
 * request through your own claude login, so it is not part of verify and no
 * test runs it.
 *
 *   bun packages/harness-claude/acceptance/step.ts --prompt "..." --cwd DIR
 *     [--resume SESSION] [--model NAME] [--effort LEVEL]
 *     [--deny-command RULE]... [--deny-path PATH]... [--ask-command RULE]
 *     [--grant-command "exact command"]
 *
 * `--ask-command` only checks that a profile with `askCommands` is refused when
 * a run starts; it makes no model request. It prints no token and no account
 * detail: the result, the reason, the session id, the usage, the final message
 * and the `session`, `blocked` and tool lines of the step's log.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryPluginStore, PluginRegistry, type JsonValue } from "@operad-io/engine";
import plugin from "../src/index.ts";

function flags(argv: readonly string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === undefined || !name.startsWith("--") || value === undefined) {
      throw new Error(`expected --flag value pairs, got "${name ?? ""}"`);
    }
    found.set(name, [...(found.get(name) ?? []), value]);
  }
  return found;
}

const given = flags(process.argv.slice(2));
const one = (name: string): string | undefined => given.get(name)?.[0];
const many = (name: string): string[] => given.get(name) ?? [];

const home = mkdtempSync(join(tmpdir(), "operad-claude-acceptance-"));
const registry = new PluginRegistry([plugin], {
  home,
  cwd: home,
  store: new MemoryPluginStore({ root: join(home, "store") }),
});

const askCommand = one("--ask-command");
if (askCommand !== undefined) {
  try {
    registry.checkAccess("harness-claude:prompt", { askCommands: [askCommand] });
    process.stdout.write("NOT REFUSED: the profile with askCommands was accepted\n");
    process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`refused as expected: ${error instanceof Error ? error.message : String(error)}\n`);
  }
} else {
  const prompt = one("--prompt");
  const cwd = one("--cwd");
  if (prompt === undefined || cwd === undefined) throw new Error("--prompt and --cwd are required");
  const grant = one("--grant-command");
  const access: Record<string, JsonValue> = {
    ...(many("--deny-command").length > 0 ? { denyCommands: many("--deny-command") } : {}),
    ...(many("--deny-path").length > 0 ? { denyPaths: many("--deny-path") } : {}),
    ...(grant === undefined ? {} : { grants: [{ waitId: "acceptance-grant", kind: "command", value: grant }] }),
  };
  const args = [
    ...(one("--model") === undefined ? [] : ["--model", String(one("--model"))]),
    ...(one("--effort") === undefined ? [] : ["--effort", String(one("--effort"))]),
  ];
  const result = await registry.runStep(
    "harness-claude/agent",
    {
      prompt,
      cwd,
      args,
      ...(one("--resume") === undefined ? {} : { resumeSession: one("--resume") }),
    },
    {
      runId: "acceptance-1",
      ...(Object.keys(access).length > 0 ? { access } : {}),
      asker: {
        ask: () => Promise.reject(new Error("the acceptance run answers no question")),
        useGrant: (waitId) => {
          process.stdout.write(`grant used: ${waitId}\n`);
          return Promise.resolve(true);
        },
      },
    },
  );
  const data = (result.data ?? {}) as Record<string, unknown>;
  const lines = readFileSync(String(data["log"]), "utf8")
    .split("\n")
    .filter((text) => text.length > 0)
    .map((text) => JSON.parse(text) as Record<string, unknown>)
    .filter((line) => ["session", "blocked", "tool_execution_start", "tool_execution_end", "rate_limit"].includes(String(line["type"])));
  process.stdout.write(
    `${JSON.stringify(
      {
        result: result.result,
        reason: data["reason"] ?? null,
        message: data["message"] ?? null,
        sessionId: data["sessionId"],
        usage: data["usage"],
        finalMessage: data["finalMessage"],
        log: data["log"],
        logLines: lines,
      },
      null,
      2,
    )}\n`,
  );
}
