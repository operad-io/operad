/**
 * Turns the `session/update` stream of codex-acp into the lines every harness
 * writes to a step's log (`SharedLine` of `@operad-io/harness-process`), so a
 * rework can read what the agent said and which tool calls it made, and counts
 * the image generations of the run.
 */

import { firstErrorLine, messageSummary, REFUSED_IN_LOG, summarizeCall, type AccessProfile } from "@operad-io/access-match";
import { isRecord } from "@operad-io/engine";
import {
  capToolOutput,
  maskSecrets,
  type AcpUsage,
  type ToolEvent,
} from "@operad-io/harness-process";
import { commandOf } from "./access.ts";

const IMAGE_GEN = /\bimage[ _-]?gen(?:eration)?\b/i;

/** The statuses after which an ACP tool call does not change again. */
function terminal(status: unknown): boolean {
  return status === "completed" || status === "failed";
}

/** Whether a tool call is one of Codex's image generations. */
export function isImageGen(call: Readonly<Record<string, unknown>>): boolean {
  const title = call["title"];
  return typeof title === "string" && IMAGE_GEN.test(title);
}

/** The name a tool call goes by in the log and in the access profile's words. */
export function toolNameOf(call: Readonly<Record<string, unknown>>): string {
  if (isImageGen(call)) return "image_gen";
  switch (call["kind"]) {
    case "execute":
      return "bash";
    case "read":
      return "read";
    case "edit":
    case "delete":
    case "move":
      return "edit";
    case "search":
      return "grep";
    case "fetch":
      return "fetch";
    case "think":
      return "think";
    default: {
      const title = call["title"];
      return typeof title === "string" && title.trim().length > 0 ? title.trim().slice(0, 60) : "tool";
    }
  }
}

function pathsOf(call: Readonly<Record<string, unknown>>): string[] {
  const list = call["locations"];
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => (isRecord(item) && typeof item["path"] === "string" ? [item["path"]] : []));
}

/** The input of a call in the words `summarizeCall` takes. */
function inputOf(name: string, call: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (name === "bash") {
    const command = commandOf(call["rawInput"]);
    return command === undefined ? {} : { command };
  }
  const raw = call["rawInput"];
  const path = pathsOf(call)[0];
  if (path !== undefined) return { path };
  if (isRecord(raw)) {
    for (const key of ["url", "query", "pattern", "path"]) {
      const value = raw[key];
      if (typeof value === "string" && value.length > 0) return { [key]: value };
    }
  }
  const title = call["title"];
  return typeof title === "string" && title.length > 0 ? { description: title } : {};
}

/** The text a tool call's content and raw output carry; images are not text and are left out. */
function outputText(update: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  const content = update["content"];
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!isRecord(item)) continue;
      const inner = item["content"];
      if (item["type"] === "content" && isRecord(inner)) {
        if (inner["type"] === "text" && typeof inner["text"] === "string") parts.push(inner["text"]);
        else if (inner["type"] === "resource_link" && typeof inner["uri"] === "string") parts.push(inner["uri"]);
      } else if (item["type"] === "diff" && typeof item["path"] === "string") {
        parts.push(`changed ${item["path"]}`);
      }
    }
  }
  const raw = update["rawOutput"];
  if (isRecord(raw)) {
    const saved = raw["savedPath"];
    if (typeof saved === "string" && saved.length > 0) parts.push(`saved ${saved}`);
    for (const key of ["aggregated_output", "stdout", "output"]) {
      const value = raw[key];
      if (typeof value === "string" && value.length > 0 && !parts.includes(value)) parts.push(value);
    }
  }
  return parts.join("\n");
}

interface OpenCall {
  readonly name: string;
  readonly at: number;
  denied: boolean;
  output: string;
}

export interface CodexLogOptions {
  /** Writes one log line. */
  readonly write: (line: string) => void;
  /** Milliseconds now, for start times and durations. */
  readonly now: () => number;
  readonly cwd: string;
  readonly profile: AccessProfile;
  readonly secrets: readonly string[];
  /** True while the prompt is in flight: updates before it are a replayed history. */
  readonly active: () => boolean;
}

export class CodexLog {
  private readonly options: CodexLogOptions;
  private readonly open = new Map<string, OpenCall>();
  /** Ids of calls the stall timer is paused for. */
  private readonly watching = new Set<string>();
  private readonly seenImages = new Set<string>();
  private text = "";

  constructor(options: CodexLogOptions) {
    this.options = options;
  }

  /** How many image generations the prompt started. */
  get imageGenerations(): number {
    return this.seenImages.size;
  }

  /** What the agent said after its last tool call: the closing message. */
  get finalText(): string {
    return this.text;
  }

  private line(value: Record<string, unknown>): void {
    this.options.write(maskSecrets(JSON.stringify(value), this.options.secrets));
  }

  /**
   * Classifies one raw line of the agent for the stall timer. A tool call that
   * is open, and a permission request nobody has answered, are silence the
   * agent is allowed: an image generation may print nothing for minutes. Only
   * the wall limit watches them.
   */
  toolEvent(line: string): ToolEvent | undefined {
    if (!this.options.active() || !line.includes("tool")) return undefined;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (!isRecord(message) || !isRecord(message["params"])) return undefined;
    const params = message["params"];
    if (message["method"] === "session/request_permission") {
      const id = isRecord(params["toolCall"]) ? params["toolCall"]["toolCallId"] : undefined;
      if (typeof id !== "string" || this.watching.has(id)) return undefined;
      this.watching.add(id);
      return "tool-start";
    }
    if (message["method"] !== "session/update" || !isRecord(params["update"])) return undefined;
    const update = params["update"];
    const id = update["toolCallId"];
    if (typeof id !== "string") return undefined;
    if (update["sessionUpdate"] === "tool_call") {
      if (terminal(update["status"]) || this.watching.has(id)) return undefined;
      this.watching.add(id);
      return "tool-start";
    }
    if (update["sessionUpdate"] === "tool_call_update" && terminal(update["status"]) && this.watching.delete(id)) {
      return "tool-end";
    }
    return undefined;
  }

  /** Takes one `session/update` of the running prompt. */
  handle(update: Readonly<Record<string, unknown>>): void {
    const kind = update["sessionUpdate"];
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const content = update["content"];
      if (!isRecord(content) || content["type"] !== "text" || typeof content["text"] !== "string") return;
      if (content["text"].length === 0) return;
      if (kind === "agent_message_chunk") {
        this.text += content["text"];
        this.line({ type: "text_delta", text: content["text"] });
      } else {
        this.line({ type: "thinking_delta", text: content["text"] });
      }
      return;
    }
    if (kind === "tool_call") this.start(update);
    else if (kind === "tool_call_update") this.update(update);
  }

  /** Records that the access profile refused the call a permission request is about. */
  blocked(toolCall: Readonly<Record<string, unknown>>): void {
    const id = toolCall["toolCallId"];
    const open = typeof id === "string" ? this.open.get(id) : undefined;
    if (open !== undefined) open.denied = true;
    this.line({ type: "blocked", toolName: open?.name ?? toolNameOf(toolCall), reason: REFUSED_IN_LOG });
  }

  private start(call: Readonly<Record<string, unknown>>): void {
    const id = call["toolCallId"];
    if (typeof id !== "string" || this.open.has(id)) return;
    // What was said before a tool call is not the closing message.
    this.text = "";
    const name = toolNameOf(call);
    if (name === "image_gen") this.seenImages.add(id);
    const at = this.options.now();
    const summary = summarizeCall(this.options.profile, name, inputOf(name, call), this.options.cwd, {
      secrets: this.options.secrets,
      keepLines: true,
    });
    const denied = summary?.includes(" denied by the access profile") === true;
    this.open.set(id, { name, at, denied, output: "" });
    this.line({
      type: "tool_execution_start",
      toolCallId: id,
      toolName: name,
      at,
      ...(summary === undefined ? {} : { input: summary }),
    });
    // A call that arrives already settled is also over.
    if (terminal(call["status"])) this.end(id, call);
  }

  private update(update: Readonly<Record<string, unknown>>): void {
    const id = update["toolCallId"];
    if (typeof id !== "string") return;
    const call = this.open.get(id);
    if (call === undefined) return;
    const text = outputText(update);
    if (text.length > 0) call.output = text;
    if (terminal(update["status"])) this.end(id, update);
  }

  private end(id: string, update: Readonly<Record<string, unknown>>): void {
    const call = this.open.get(id);
    if (call === undefined) return;
    this.open.delete(id);
    const text = outputText(update).length > 0 ? outputText(update) : call.output;
    const failed = update["status"] === "failed";
    if (text.length > 0) {
      const head = capToolOutput(maskSecrets(text, this.options.secrets));
      this.line({
        type: "tool_output",
        toolCallId: id,
        text: head.text,
        ...(head.truncated ? { truncated: true } : {}),
      });
    }
    const error =
      failed && !call.denied
        ? firstErrorLine(text.length > 0 ? text : "the call failed", { secrets: this.options.secrets })
        : undefined;
    this.line({
      type: "tool_execution_end",
      toolCallId: id,
      toolName: call.name,
      isError: failed,
      durationMs: Math.max(0, this.options.now() - call.at),
      ...(error === undefined ? {} : { error }),
    });
  }

  /** Writes the closing `message_end` line of the prompt. */
  finish(stopReason: string, usage: AcpUsage | null): void {
    const said = messageSummary(this.text);
    this.line({
      type: "message_end",
      role: "assistant",
      ...(said === undefined ? {} : { text: said }),
      stopReason,
      usage: {
        input: usage?.inputTokens ?? 0,
        output: usage?.outputTokens ?? 0,
        cache_read: usage?.cachedReadTokens ?? 0,
        cache_write: usage?.cachedWriteTokens ?? 0,
      },
      cost: null,
    });
  }
}
