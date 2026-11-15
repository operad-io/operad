/**
 * Reads `model/list` from a `codex app-server` and prints the choices as JSON:
 * `[{ id, isDefault }]`. Run by `codexModels` in a short-lived child because a
 * harness's `models` answer is read synchronously. Not imported by the plugin.
 */

import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const program = argv[0];
if (program === undefined) {
  process.stdout.write("[]\n");
  process.exit(2);
}

const child = spawn(program, argv.slice(1), { stdio: ["pipe", "pipe", "ignore"] });
let buffered = "";
let finished = false;

function finish(value: unknown): void {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  process.stdout.write(`${JSON.stringify(value)}\n`, () => {
    child.kill("SIGKILL");
    process.exit(0);
  });
}

const timer = setTimeout(() => finish([]), 8_000);

function send(message: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function handle(message: Record<string, unknown>): void {
  if (message["id"] === 1) {
    send({ method: "initialized" });
    send({ id: 2, method: "model/list", params: {} });
    return;
  }
  if (message["id"] !== 2) return;
  const result = message["result"];
  if (typeof result !== "object" || result === null) {
    finish([]);
    return;
  }
  const data = Reflect.get(result, "data");
  if (!Array.isArray(data)) {
    finish([]);
    return;
  }
  const choices: Array<{ id: string; isDefault: boolean }> = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = Reflect.get(entry, "id");
    if (typeof id === "string" && id.length > 0) {
      choices.push({ id, isDefault: Reflect.get(entry, "isDefault") === true });
    }
  }
  finish(choices);
}

child.stdout.on("data", (chunk: Buffer) => {
  buffered += chunk.toString("utf8");
  for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line.trim().length === 0) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === "object" && value !== null) handle(value as Record<string, unknown>);
    } catch {
      // The app-server may print a warning; only JSON lines matter.
    }
  }
});
child.on("error", () => finish([]));
child.on("exit", () => finish([]));

send({
  id: 1,
  method: "initialize",
  params: {
    clientInfo: { name: "operad-models", title: "operad", version: "0.0.0" },
    capabilities: { experimentalApi: false, requestAttestation: false },
  },
});
