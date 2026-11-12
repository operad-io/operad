/**
 * A fake `claude` process for the tests. The SDK starts a process and speaks
 * stream-json to it; this one answers from a script, so no real `claude` and
 * no model is involved.
 *
 * The SDK writes control requests and one user message to stdin. The fake
 * answers `initialize`, waits for the user message, then plays its steps:
 * `say` writes a message line, `hook` and `ask` send the SDK a control request
 * (a hook callback, a permission question) and wait for its answer, `hang`
 * waits until the SDK closes stdin or kills the process, `exit` ends the
 * process.
 */

import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { isRecord } from "@operad-io/engine";

export type HookName = "PreToolUse" | "PostToolUse" | "PostToolUseFailure";

export type FakeStep =
  | { readonly say: Record<string, unknown> }
  | {
      readonly hook: HookName;
      readonly toolName: string;
      readonly toolUseId: string;
      readonly input?: Record<string, unknown>;
      /** The tool's output (PostToolUse) or error text (PostToolUseFailure). */
      readonly output?: string;
    }
  | {
      readonly ask: { readonly toolName: string; readonly toolUseId: string; readonly input: Record<string, unknown> };
    }
  | { readonly hang: true }
  | { readonly exit: number };

export interface FakeScript {
  readonly account?: Record<string, unknown>;
  readonly steps: readonly FakeStep[];
}

type Json = Record<string, unknown>;

/** What the fake saw, appended to `recordFile` as JSON lines. */
function record(recordFile: string | undefined, entry: Json): void {
  if (recordFile !== undefined) appendFileSync(recordFile, `${JSON.stringify(entry)}\n`);
}

class FakeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly #callbacks = new Map<string, string[]>();
  readonly #pending = new Map<string, (response: Json) => void>();
  #buffer = "";
  #started = false;
  #nextRequest = 1;

  constructor(
    private readonly script: FakeScript,
    private readonly recordFile: string | undefined,
    private readonly log: (text: string) => void,
  ) {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.#read(chunk.toString("utf8")));
    this.stdin.on("end", () => this.#end(0, null));
    this.stdin.on("error", () => undefined);
    this.stdout.on("error", () => undefined);
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killed = true;
    this.#end(null, signal);
    return true;
  }

  #end(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    if (code !== null) this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    queueMicrotask(() => this.emit("exit", code, signal));
  }

  #write(value: Json): void {
    if (this.exitCode === null && this.signalCode === null) this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  #read(text: string): void {
    this.#buffer += text;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (isRecord(message)) this.#handle(message);
    }
  }

  #handle(message: Json): void {
    const type = message["type"];
    if (type === "control_request" && isRecord(message["request"])) {
      const request = message["request"];
      const id = String(message["request_id"]);
      if (request["subtype"] === "initialize") {
        const hooks = request["hooks"];
        if (isRecord(hooks)) {
          for (const [event, matchers] of Object.entries(hooks)) {
            const ids = Array.isArray(matchers)
              ? matchers.flatMap((matcher) =>
                  isRecord(matcher) && Array.isArray(matcher["hookCallbackIds"])
                    ? matcher["hookCallbackIds"].map(String)
                    : [],
                )
              : [];
            this.#callbacks.set(event, ids);
          }
        }
        record(this.recordFile, { initialize: { hooks: [...this.#callbacks.keys()] } });
        this.#write({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: id,
            response: {
              commands: [],
              agents: [],
              output_style: "default",
              available_output_styles: [],
              models: [],
              account: this.script.account ?? {},
              claude_code_version: "2.1.319",
            },
          },
        });
      } else {
        this.#write({ type: "control_response", response: { subtype: "success", request_id: id, response: {} } });
      }
      return;
    }
    if (type === "control_response" && isRecord(message["response"])) {
      const answer = message["response"];
      const resolve = this.#pending.get(String(answer["request_id"]));
      if (resolve !== undefined) {
        this.#pending.delete(String(answer["request_id"]));
        resolve(answer);
      }
      return;
    }
    if (type === "user" && !this.#started) {
      this.#started = true;
      record(this.recordFile, { user: message["message"] });
      void this.#play();
    } else if (type === "user") {
      // A message the host sent while the turn runs.
      record(this.recordFile, { userLater: message["message"] });
      this.log("fake-claude-user-later\n");
    }
  }

  #request(request: Json): Promise<Json> {
    const id = `fake-${this.#nextRequest}`;
    this.#nextRequest += 1;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#write({ type: "control_request", request_id: id, request });
    });
  }

  async #play(): Promise<void> {
    for (const step of this.script.steps) {
      if ("say" in step) {
        this.#write(step.say);
      } else if ("hook" in step) {
        const callbackId = this.#callbacks.get(step.hook)?.[0];
        if (callbackId === undefined) {
          record(this.recordFile, { missingHook: step.hook });
          continue;
        }
        const reply = await this.#request({
          subtype: "hook_callback",
          callback_id: callbackId,
          tool_use_id: step.toolUseId,
          input: {
            hook_event_name: step.hook,
            session_id: "fake",
            transcript_path: "/dev/null",
            cwd: "/",
            tool_name: step.toolName,
            tool_input: step.input ?? {},
            tool_use_id: step.toolUseId,
            ...(step.hook === "PostToolUse" ? { tool_response: step.output === undefined ? {} : { stdout: step.output } } : {}),
            ...(step.hook === "PostToolUseFailure" ? { error: step.output ?? "failed" } : {}),
          },
        });
        record(this.recordFile, { hookReply: step.hook, subtype: reply["subtype"] });
      } else if ("ask" in step) {
        const reply = await this.#request({
          subtype: "can_use_tool",
          tool_name: step.ask.toolName,
          tool_use_id: step.ask.toolUseId,
          input: step.ask.input,
        });
        record(this.recordFile, { askReply: step.ask.toolName, answer: reply["response"] ?? reply["error"] ?? null });
      } else if ("hang" in step) {
        record(this.recordFile, { hanging: true });
        this.log("fake-claude-hanging\n");
        await new Promise<void>(() => undefined);
      } else {
        this.#end(step.exit, null);
        return;
      }
    }
  }
}

/** A `spawnClaudeCodeProcess` that starts the fake. */
export function fakeSpawn(
  script: FakeScript,
  recordFile?: string,
  log: (text: string) => void = (text) => void process.stderr.write(text),
): (options: SpawnOptions) => SpawnedProcess {
  return (options) => {
    record(recordFile, {
      spawn: {
        args: options.args,
        env: Object.fromEntries(
          Object.entries(options.env).filter(([key]) => /^(CLAUDE_CODE_|DISABLE_|ANTHROPIC_|BASH_|HOME$)/.test(key)),
        ),
      },
    });
    return new FakeProcess(script, recordFile, log);
  };
}

// Message builders: the shapes the stream carries.

export const SESSION = "11111111-2222-4333-8444-555555555555";

export const MISSING_SESSION = "No conversation found with session ID: 00000000-0000-4000-8000-000000000000";

export function systemInit(session = SESSION): Json {
  return {
    type: "system",
    subtype: "init",
    session_id: session,
    uuid: "00000000-0000-4000-8000-000000000001",
    claude_code_version: "2.1.319",
    cwd: "/",
    tools: [],
    mcp_servers: [],
    model: "fake",
    permissionMode: "default",
    slash_commands: [],
    apiKeySource: "none",
    output_style: "default",
    skills: [],
    plugins: [],
  };
}

export function assistant(id: string, text: string, usage: Json = {}, session = SESSION): Json {
  return {
    type: "assistant",
    session_id: session,
    uuid: `00000000-0000-4000-8000-${id.padStart(12, "0")}`,
    parent_tool_use_id: null,
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "fake",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
    },
  };
}

export function rateLimit(info: Json, session = SESSION): Json {
  return {
    type: "rate_limit_event",
    session_id: session,
    uuid: "00000000-0000-4000-8000-0000000000aa",
    rate_limit_info: info,
  };
}

export function result(fields: Json = {}, session = SESSION): Json {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    result: "the answer",
    stop_reason: "end_turn",
    total_cost_usd: 0.0123456,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
    modelUsage: { "claude-fake-1": {} },
    permission_denials: [],
    uuid: "00000000-0000-4000-8000-0000000000bb",
    session_id: session,
    ...fields,
  };
}
