#!/usr/bin/env bun
/**
 * A real `claude` process for the kept-worker tests. It speaks the SDK's
 * stream-json protocol, answers one result per user message, and stays alive
 * between turns. `FAKE_CLAUDE_PID` gets its pid; `FAKE_CLAUDE_RECORD` gets each
 * user message as one JSON line.
 */

import { appendFileSync, writeFileSync } from "node:fs";

const SESSION = "11111111-2222-4333-8444-555555555555";

const pidFile = process.env["FAKE_CLAUDE_PID"];
if (pidFile !== undefined) writeFileSync(pidFile, String(process.pid));

function record(value: unknown): void {
  const path = process.env["FAKE_CLAUDE_RECORD"];
  if (path !== undefined) appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function init(): unknown {
  return {
    type: "system",
    subtype: "init",
    session_id: SESSION,
    uuid: "00000000-0000-4000-8000-000000000001",
    claude_code_version: "2.1.319",
    cwd: process.cwd(),
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

function assistant(id: string, text: string): unknown {
  return {
    type: "assistant",
    session_id: SESSION,
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
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  };
}

function result(text: string): unknown {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    result: text,
    stop_reason: "end_turn",
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    },
    modelUsage: { "claude-fake-1": {} },
    permission_denials: [],
    uuid: "00000000-0000-4000-8000-0000000000bb",
    session_id: SESSION,
  };
}

let started = false;
let turns = 0;
let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim().length === 0) continue;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = message["type"];
    if (type === "control_request") {
      const request = message["request"];
      const requestId = String(message["request_id"]);
      const subtype =
        typeof request === "object" && request !== null ? Reflect.get(request, "subtype") : undefined;
      write({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response:
            subtype === "initialize"
              ? {
                  commands: [],
                  agents: [],
                  output_style: "default",
                  available_output_styles: [],
                  models: [],
                  account: {},
                  claude_code_version: "2.1.319",
                }
              : {},
        },
      });
      continue;
    }
    if (type !== "user") continue;
    record({ user: message["message"], priority: message["priority"] ?? null });
    if (!started) {
      started = true;
      write(init());
    }
    turns += 1;
    const text = turns === 1 ? "first answer" : `answer ${turns}`;
    write(assistant(`m${turns}`, text));
    write(result(text));
  }
});
process.stdin.on("end", () => process.exit(0));
