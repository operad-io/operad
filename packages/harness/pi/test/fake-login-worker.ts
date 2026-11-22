/**
 * A fake login child for the tests. It speaks the line protocol of
 * `src/login-protocol.ts`: the providers, a prompt or notice, and the result.
 * `FAKE_LOGIN_URL=evil` makes it send an address a client must refuse; the
 * provider it is told decides between the browser path and an API key.
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

function authUrl(): string {
  const evil = process.env.FAKE_LOGIN_URL === "evil";
  const base = evil ? "https://evil.example/oauth/authorize" : "https://auth.openai.com/oauth/authorize";
  const url = new URL(base);
  url.searchParams.set("redirect_uri", "http://localhost:1455/auth/callback");
  url.searchParams.set("state", "0123456789abcdef");
  return url.href;
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

if (provider === "openai-codex" && auth === "oauth") {
  write({
    type: "notice",
    event: {
      type: "auth_url",
      url: authUrl(),
      instructions: "A browser window should open.",
    },
  });
  write({
    type: "prompt",
    id: 1,
    prompt: {
      type: "manual_code",
      message: "Complete login in your browser, or paste the redirect URL here:",
      placeholder: "http://localhost:1455/auth/callback",
    },
  });
  const value = await readAnswer(1);
  if (value.length === 0) {
    write({ type: "failed", message: "the login was cancelled" });
    process.exit(1);
  }
  write({ type: "done", provider, auth });
  process.exit(0);
}

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
