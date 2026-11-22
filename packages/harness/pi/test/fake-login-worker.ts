/**
 * A fake login child for the tests. It speaks the line protocol of
 * `src/login-protocol.ts`: the providers, a prompt or notice, and the result.
 * It lists `openai-codex` with an OAuth login only, as pi does: the hub must
 * not offer it. The only login it runs is an API key.
 */

import { createInterface } from "node:readline";

const providers = [
  {
    id: "openai-codex",
    name: "OpenAI Codex",
    oauth: { name: "OpenAI (ChatGPT Plus/Pro)" },
  },
  {
    id: "openai",
    name: "OpenAI",
    oauth: { name: "OpenAI (ChatGPT subscription)" },
    apiKey: { name: "OpenAI API key" },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    oauth: { name: "Anthropic (Claude Pro/Max)" },
    apiKey: { name: "Anthropic API key" },
  },
];

function write(line: unknown): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

const commands: Record<string, unknown>[] = [];
let wake: (() => void) | undefined;
const terminal = createInterface({ input: process.stdin });
terminal.on("line", (line) => {
  try {
    commands.push(JSON.parse(line) as Record<string, unknown>);
  } catch {
    return;
  }
  wake?.();
});

async function next(): Promise<Record<string, unknown>> {
  while (commands.length === 0) {
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
  wake = undefined;
  const found = commands.shift();
  if (found === undefined) throw new Error("no command");
  return found;
}

async function readAnswer(id: number): Promise<string> {
  for (;;) {
    const command = await next();
    if (command["type"] === "answer" && command["id"] === id) return String(command["value"] ?? "");
    if (command["type"] === "cancel") return "";
  }
}

process.argv[2];
write({ type: "providers", providers });
const first = await next();
if (first["type"] !== "login") {
  write({ type: "failed", message: "expected a login" });
  process.exit(1);
}
const provider = String(first["provider"] ?? "");
const auth = String(first["auth"] ?? "");

if (auth === "api_key") {
  write({
    type: "prompt",
    id: 2,
    prompt: { type: "secret", message: `Enter ${provider} API key` },
  });
  const value = await readAnswer(2);
  if (value.length === 0) {
    write({ type: "failed", message: "the login was cancelled" });
    process.exit(1);
  }
  write({ type: "done", provider, auth });
  process.exit(0);
}

write({ type: "failed", message: `no fake login for ${provider}/${auth}` });
process.exit(1);
