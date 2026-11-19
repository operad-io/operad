/**
 * One codex step in its own process, for a test that needs the harness to run
 * as a real child rather than in the test's process. It reads one JSON line
 * from stdin and writes one JSON line with the step's result and the questions
 * it asked. The fake app-server this process starts is a child of its own.
 */

import { join } from "node:path";
import { MemoryPluginStore, PluginRegistry, type JsonValue, type PluginStepResult } from "@operad-io/engine";
import { createCodexHarnessPlugin } from "../src/index.ts";

interface Input {
  readonly root: string;
  readonly codex: readonly string[];
  readonly params: Record<string, unknown>;
  readonly access?: JsonValue | undefined;
}

interface Output {
  readonly result: PluginStepResult;
  readonly asked: readonly string[];
}

const input = JSON.parse(await Bun.stdin.text()) as Input;
const asked: string[] = [];
const plugin = createCodexHarnessPlugin({ codex: input.codex });
const registry = new PluginRegistry([plugin], {
  home: input.root,
  cwd: input.root,
  store: new MemoryPluginStore({ root: join(input.root, "store") }),
  settings: { codex: { command: input.codex } },
});
const result = await registry.runStep("codex/agent", input.params, {
  runId: "run-1",
  ...(input.access === undefined ? {} : { access: input.access }),
  asker: {
    async ask(request) {
      asked.push(request.prompt);
      return { kind: "answered" as const, answer: { choice: "allow_once" } };
    },
    useGrant: () => Promise.resolve(false),
  },
});
const output: Output = { result, asked };
process.stdout.write(`${JSON.stringify(output)}\n`);
