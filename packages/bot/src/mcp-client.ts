/**
 * A small MCP client over a child's stdio, for two jobs: reading the tool list
 * of a server once (to register it), and the guard in front of a server a bot
 * mounts. It speaks newline-delimited JSON-RPC and nothing else of MCP.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { isRecord, messageOf } from "@operad-io/engine";
import { killProcessGroup } from "@operad-io/engine/platform";

/** The protocol version this client offers. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** One tool a server offers, as a person reads it. */
export interface McpTool {
  readonly name: string;
  readonly description: string;
}

/** A JSON-RPC message. */
export type RpcMessage = Record<string, unknown>;

/** What a request got back. */
export type RpcReply = { readonly result: unknown } | { readonly error: unknown };

export interface StdioOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The whole environment of the server: nothing is inherited. */
  readonly env: Readonly<Record<string, string>>;
  /** How long one request may take. */
  readonly timeoutMs?: number | undefined;
}

/** The environment a server gets before secrets: a path to find programs and a home. */
export function baseEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** A started server and the requests made of it. */
export class StdioServer {
  readonly #child: ChildProcess;
  readonly #pending = new Map<string, (reply: RpcReply) => void>();
  readonly #stderr: string[] = [];
  readonly #timeoutMs: number;
  #next = 0;
  #ended = false;
  #onMessage: (message: RpcMessage) => void = () => undefined;
  readonly exited: Promise<void>;

  constructor(options: StdioOptions) {
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    // A new process group, so the server and what it starts can be stopped together.
    this.#child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.exited = new Promise<void>((resolve) => {
      const done = (): void => {
        this.#ended = true;
        for (const settle of this.#pending.values()) settle({ error: { message: `the server ended: ${this.stderrTail()}` } });
        this.#pending.clear();
        resolve();
      };
      this.#child.once("close", done);
      this.#child.once("error", (error) => {
        this.#stderr.push(messageOf(error));
        done();
      });
    });
    this.#child.stdin?.on("error", () => undefined);
    this.#child.stderr?.on("data", (chunk: Buffer) => {
      this.#stderr.push(chunk.toString("utf8"));
      if (this.#stderr.length > 20) this.#stderr.splice(0, this.#stderr.length - 20);
    });
    if (this.#child.stdout !== null) {
      createInterface({ input: this.#child.stdout }).on("line", (line) => this.#line(line));
    }
  }

  #line(line: string): void {
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const id = parsed.id;
    if (typeof id === "string" && parsed.method === undefined) {
      const settle = this.#pending.get(id);
      if (settle !== undefined) {
        this.#pending.delete(id);
        settle("error" in parsed ? { error: parsed.error } : { result: parsed.result });
        return;
      }
    }
    this.#onMessage(parsed);
  }

  /** Receives what the server sent that was not the answer to one of this client's requests. */
  onMessage(handler: (message: RpcMessage) => void): void {
    this.#onMessage = handler;
  }

  /** The last lines the server wrote to its error output. */
  stderrTail(): string {
    return this.#stderr.join("").trim().split("\n").slice(-5).join("\n");
  }

  /** Writes one message. */
  send(message: RpcMessage): void {
    if (this.#ended) return;
    this.#child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  /** One request. The id is this client's own (`g<n>`), so it never meets one of the server's. */
  request(method: string, params?: unknown): Promise<RpcReply> {
    if (this.#ended) return Promise.resolve({ error: { message: `the server ended: ${this.stderrTail()}` } });
    this.#next += 1;
    const id = `g${this.#next}`;
    return new Promise<RpcReply>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({ error: { message: `the server did not answer "${method}" in ${Math.round(this.#timeoutMs / 1000)} s` } });
      }, this.#timeoutMs);
      this.#pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  /** The handshake: initialize and the `initialized` notice. Returns the server's answer. */
  async initialize(client: string): Promise<RpcReply> {
    const reply = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: client, version: "0.0.0" },
    });
    if ("result" in reply) this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return reply;
  }

  /** Every tool the server offers, following its pages. */
  async listTools(): Promise<readonly McpTool[]> {
    const found: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const reply = await this.request("tools/list", cursor === undefined ? {} : { cursor });
      if ("error" in reply) throw new Error(errorText(reply.error));
      const page = toolsOf(reply.result);
      found.push(...page.tools);
      cursor = page.next;
    } while (cursor !== undefined);
    return found;
  }

  /** Ends the server and what it started. */
  async close(): Promise<void> {
    if (!this.#ended) {
      this.#child.stdin?.end();
      const pid = this.#child.pid;
      if (pid !== undefined && !killProcessGroup(pid, "SIGTERM")) this.#child.kill("SIGTERM");
    }
    await this.exited;
  }
}

/** A tool list as a person reads it: name and description, sorted by name. */
export function toolsOf(result: unknown): { readonly tools: readonly McpTool[]; readonly next: string | undefined } {
  const list = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
  const tools: McpTool[] = [];
  for (const item of list) {
    if (!isRecord(item) || typeof item.name !== "string") continue;
    tools.push({ name: item.name, description: typeof item.description === "string" ? item.description : "" });
  }
  const next = isRecord(result) && typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
  return { tools, next };
}

/** The message of a JSON-RPC error. */
export function errorText(error: unknown): string {
  return isRecord(error) && typeof error.message === "string" ? error.message : "the server answered with an error";
}

/** Starts a server, reads its tool list once and ends it. */
export async function probeServer(options: StdioOptions): Promise<readonly McpTool[]> {
  const server = new StdioServer(options);
  try {
    const hello = await server.initialize("operad-bot");
    if ("error" in hello) throw new Error(errorText(hello.error));
    return [...(await server.listTools())].sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await server.close();
  }
}
