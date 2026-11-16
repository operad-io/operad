/**
 * A stand-in for the pi worker that can be kept. It reads one input, writes a
 * Result, and when the input asks for it stays on a socket for later replies.
 * `FAKE_KEEP_RECORD` gets each input as one JSON line; `FAKE_KEEP_FAIL` makes
 * every reply fail; `FAKE_KEEP_SESSION` names the session in each Result.
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { removeKeptWorker, writeKeptWorker } from "@operad-io/engine/platform";

type Input = Record<string, unknown> & {
  prompt: string;
  keep?: {
    socket: string;
    meta: string;
    token: string;
    scope: string;
    key: string;
    timeoutMs: number;
  };
};

class Lines {
  private buffer = "";
  private readonly reader: AsyncIterator<Uint8Array>;
  private readonly decoder = new TextDecoder();
  constructor(stream: AsyncIterable<Uint8Array>) {
    this.reader = stream[Symbol.asyncIterator]();
  }
  async next(): Promise<string | undefined> {
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        return line;
      }
      const chunk = await this.reader.next();
      if (chunk.done) {
        const rest = this.buffer;
        this.buffer = "";
        return rest.length === 0 ? undefined : rest;
      }
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }
}

process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));

const stdin = new Lines(Bun.stdin.stream());
const first = await stdin.next();
if (first === undefined) process.exit(2);
const input = JSON.parse(first) as Input;

function record(value: Input): void {
  const path = process.env["FAKE_KEEP_RECORD"];
  if (path !== undefined) appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function result(): Record<string, unknown> {
  const session = process.env["FAKE_KEEP_SESSION"] ?? "fake-session";
  const failed = process.env["FAKE_KEEP_FAIL"] === "1";
  return {
    type: "result",
    result: failed ? "failed" : "done",
    sessionId: session,
    usage: { input: 11, output: 7 },
    cost: { micros: 1234 },
    finalMessage: failed ? null : "fake final message",
    ...(failed ? { reason: "model_error", message: "fake failure" } : {}),
  };
}

function write(stream: { write(text: string): unknown }, line: unknown): void {
  stream.write(`${JSON.stringify(line)}\n`);
}

function run(stream: { write(text: string): unknown }, value: Input): Record<string, unknown> {
  record(value);
  write(stream, { type: "session", sessionId: process.env["FAKE_KEEP_SESSION"] ?? "fake-session" });
  if (process.env["FAKE_KEEP_HANG"] === "1") return {};
  const line = result();
  write(stream, line);
  return line;
}

const firstResult = run({ write: (text) => process.stdout.write(text) }, input);
if (process.env["FAKE_KEEP_HANG"] === "1") await new Promise<void>(() => undefined);
if (input.keep === undefined || firstResult["result"] !== "done") process.exit(firstResult["result"] === "done" ? 0 : 1);
const keep = input.keep;
mkdirSync(dirname(keep.socket), { recursive: true });
rmSync(keep.socket, { force: true });
rmSync(keep.meta, { force: true });

let session = String(firstResult["sessionId"] ?? "") || null;
let lastUsedAt = Date.now();
let busy = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let stopping = false;
const save = (): void => {
  writeKeptWorker({
    pid: process.pid,
    token: keep.token,
    scope: keep.scope,
    key: keep.key,
    socket: keep.socket,
    meta: keep.meta,
    session,
    startedAt: lastUsedAt,
    lastUsedAt,
    ...(busy ? { busy: true } : {}),
  });
};
const shutdown = (code: number): void => {
  if (stopping) return;
  stopping = true;
  if (timer !== undefined) clearTimeout(timer);
  server.close();
  removeKeptWorker({ meta: keep.meta, socket: keep.socket });
  process.exit(code);
};
const idle = (): void => {
  if (stopping) return;
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => shutdown(0), keep.timeoutMs);
};

const server = createServer((socket) => {
  void (async () => {
    if (timer !== undefined) clearTimeout(timer);
    const lines = new Lines(socket);
    const line = await lines.next();
    if (line === undefined) return;
    const value = JSON.parse(line) as Input & { type?: string };
    if (value.type === "stop") {
      socket.end();
      shutdown(0);
      return;
    }
    const hang = process.env["FAKE_KEEP_HANG_ONCE"];
    if (hang !== undefined) {
      try {
        readFileSync(hang);
        rmSync(hang, { force: true });
        busy = true;
        save();
        await new Promise<void>(() => undefined);
      } catch {
        // No hang file: answer normally.
      }
    }
    busy = true;
    save();
    const answer = run(socket, value);
    socket.end();
    busy = false;
    lastUsedAt = Date.now();
    if (answer["result"] === "done") {
      session = String(answer["sessionId"] ?? "") || null;
      save();
      idle();
    } else {
      shutdown(1);
    }
  })();
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(keep.socket, () => resolve());
});
chmodSync(keep.socket, 0o600);
writeFileSync(keep.meta, "", { mode: 0o600 });
save();
idle();
process.on("SIGTERM", () => {
  if (!busy) shutdown(143);
});
await new Promise<void>(() => undefined);
