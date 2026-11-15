/**
 * Turns the item stream of `codex app-server` into the lines every harness
 * writes to a step's log (`SharedLine` of `@operad-io/harness-process`), so a
 * rework can read what the agent said, what it thought and which tool calls it
 * made, and counts the image generations of the run.
 */

import { firstErrorLine, messageSummary, REFUSED_IN_LOG, summarizeCall, type AccessProfile } from "@operad-io/access-match";
import { isRecord } from "@operad-io/engine";
import { capToolOutput, maskSecrets, type ToolEvent } from "@operad-io/harness-process";
import type { AppServerUsage } from "./app-server.ts";

const TOOL_ITEMS = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "imageGeneration",
  "webSearch",
  "imageView",
]);

/** Whether an item is a tool call the log shows. */
export function isToolItem(item: Readonly<Record<string, unknown>>): boolean {
  return typeof item["type"] === "string" && TOOL_ITEMS.has(item["type"]);
}

/** Whether an item is one of Codex's image generations. */
export function isImageGen(item: Readonly<Record<string, unknown>>): boolean {
  return item["type"] === "imageGeneration";
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The name a tool item goes by in the log. */
export function toolNameOf(item: Readonly<Record<string, unknown>>): string {
  switch (item["type"]) {
    case "commandExecution":
      return "bash";
    case "fileChange":
      return "edit";
    case "mcpToolCall": {
      const server = textOf(item["server"]);
      const tool = textOf(item["tool"]) ?? "tool";
      return server === undefined ? tool : `mcp__${server}__${tool}`;
    }
    case "dynamicToolCall":
      return textOf(item["tool"]) ?? "tool";
    case "imageGeneration":
      return "image_gen";
    case "webSearch":
      return "web_search";
    case "imageView":
      return "image_view";
    case "collabAgentToolCall":
      return "collab_agent";
    default: {
      const type = textOf(item["type"]) ?? "tool";
      return type.slice(0, 60);
    }
  }
}

function changesOf(item: Readonly<Record<string, unknown>>): readonly Readonly<Record<string, unknown>>[] {
  const changes = item["changes"];
  return Array.isArray(changes) ? changes.filter((change): change is Readonly<Record<string, unknown>> => isRecord(change)) : [];
}

/** The input of a tool item in the words `summarizeCall` takes. */
function inputOf(item: Readonly<Record<string, unknown>>): Record<string, unknown> {
  switch (item["type"]) {
    case "commandExecution": {
      const command = textOf(item["command"]);
      return command === undefined ? {} : { command };
    }
    case "fileChange": {
      const path = textOf(changesOf(item)[0]?.["path"]);
      return path === undefined ? {} : { path };
    }
    case "mcpToolCall":
      return { description: `${textOf(item["server"]) ?? "mcp"} ${textOf(item["tool"]) ?? "tool"}` };
    case "dynamicToolCall":
      return { description: textOf(item["tool"]) ?? "tool" };
    case "imageGeneration":
      return { description: "Image generation" };
    case "webSearch": {
      const query = textOf(item["query"]);
      return query === undefined ? {} : { query };
    }
    case "imageView": {
      const path = textOf(item["path"]);
      return path === undefined ? {} : { path };
    }
    default:
      return {};
  }
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const text = textOf(entry["text"]);
    if (text !== undefined) parts.push(text);
  }
  return parts.join("\n");
}

/** The text a tool item carries; images are not text and are left out. */
function outputOf(item: Readonly<Record<string, unknown>>, accumulated: string, patches: unknown): string {
  const parts: string[] = [];
  switch (item["type"]) {
    case "commandExecution": {
      const aggregated = textOf(item["aggregatedOutput"]);
      if (aggregated !== undefined) parts.push(aggregated);
      break;
    }
    case "fileChange": {
      const changes = Array.isArray(patches) ? patches : item["changes"];
      if (Array.isArray(changes)) {
        for (const change of changes) {
          if (isRecord(change) && typeof change["path"] === "string") parts.push(`changed ${change["path"]}`);
        }
      }
      break;
    }
    case "mcpToolCall": {
      const error = isRecord(item["error"]) ? textOf(item["error"]["message"]) : undefined;
      if (error !== undefined) parts.push(error);
      const result = isRecord(item["result"]) ? item["result"] : undefined;
      if (result !== undefined) {
        const content = contentText(result["content"]);
        if (content.length > 0) parts.push(content);
      }
      break;
    }
    case "dynamicToolCall": {
      const content = contentText(item["contentItems"]);
      if (content.length > 0) parts.push(content);
      break;
    }
    case "imageGeneration": {
      const saved = textOf(item["savedPath"]);
      if (saved !== undefined) parts.push(`saved ${saved}`);
      break;
    }
    case "imageView": {
      const path = textOf(item["path"]);
      if (path !== undefined) parts.push(`read ${path}`);
      break;
    }
    default:
      break;
  }
  if (accumulated.length > 0 && !parts.includes(accumulated)) parts.push(accumulated);
  return parts.join("\n");
}

/** Whether a terminal tool item reports a failure. */
function failedOf(item: Readonly<Record<string, unknown>>): boolean {
  switch (item["type"]) {
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "dynamicToolCall":
      return item["status"] === "failed" || item["status"] === "declined";
    case "imageGeneration":
      return isRecord(item["failure"]);
    default:
      return false;
  }
}

function terminal(item: Readonly<Record<string, unknown>>): boolean {
  return item["status"] === "completed" || item["status"] === "failed" || item["status"] === "declined";
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
  /** True while the turn is in flight: what a resumed thread replays is not this run. */
  readonly active: () => boolean;
}

export class CodexLog {
  private readonly options: CodexLogOptions;
  private readonly open = new Map<string, OpenCall>();
  /** Ids of tool calls the stall timer is paused for. */
  private readonly watching = new Set<string>();
  private readonly seenImages = new Set<string>();
  /** The text each agent message item has streamed. */
  private readonly messages = new Map<string, string>();
  /** Output deltas of command items, kept for a completion that carries none. */
  private readonly outputs = new Map<string, string>();
  /** The latest patch of a file-change item. */
  private readonly patches = new Map<string, unknown>();
  private text = "";

  constructor(options: CodexLogOptions) {
    this.options = options;
  }

  /** How many image generations the turn started. */
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
   * Classifies one raw line of the app-server for the stall timer. A tool item
   * that is open, and a permission request nobody has answered, are silence
   * the agent is allowed: an image generation may print nothing for minutes.
   * Only the wall limit watches them.
   */
  toolEvent(line: string): ToolEvent | undefined {
    if (!this.options.active() || !line.includes("item")) return undefined;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (!isRecord(message)) return undefined;
    const method = message["method"];
    const params = isRecord(message["params"]) ? message["params"] : undefined;
    if (typeof method !== "string" || params === undefined) return undefined;
    if (method === "item/started") {
      const item = params["item"];
      if (!isRecord(item) || !isToolItem(item)) return undefined;
      const id = item["id"];
      if (typeof id !== "string" || this.watching.has(id)) return undefined;
      this.watching.add(id);
      return "tool-start";
    }
    if (method === "item/completed") {
      const item = params["item"];
      const id = isRecord(item) ? item["id"] : undefined;
      if (typeof id === "string" && this.watching.delete(id)) return "tool-end";
      return undefined;
    }
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const id = params["itemId"];
      if (typeof id !== "string" || this.watching.has(id)) return undefined;
      this.watching.add(id);
      return "tool-start";
    }
    if (method === "execCommandApproval" || method === "applyPatchApproval") {
      const id = params["callId"];
      if (typeof id !== "string" || this.watching.has(id)) return undefined;
      this.watching.add(id);
      return "tool-start";
    }
    return undefined;
  }

  /** Takes one notification of the running turn. */
  handle(method: string, params: Readonly<Record<string, unknown>>): void {
    if (!this.options.active()) return;
    switch (method) {
      case "item/started": {
        const item = params["item"];
        if (!isRecord(item)) return;
        const id = item["id"];
        if (item["type"] === "agentMessage" && typeof id === "string" && !this.messages.has(id)) {
          this.messages.set(id, "");
        }
        if (isToolItem(item)) this.start(item);
        return;
      }
      case "item/completed": {
        const item = params["item"];
        if (!isRecord(item)) return;
        if (item["type"] === "agentMessage") {
          this.completeMessage(item);
          return;
        }
        if (isToolItem(item)) this.end(item);
        return;
      }
      case "item/agentMessage/delta": {
        const delta = params["delta"];
        if (typeof delta !== "string" || delta.length === 0) return;
        const id = params["itemId"];
        if (typeof id === "string") this.messages.set(id, (this.messages.get(id) ?? "") + delta);
        this.text += delta;
        this.line({ type: "text_delta", text: delta });
        return;
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const delta = params["delta"];
        if (typeof delta !== "string" || delta.length === 0) return;
        this.line({ type: "thinking_delta", text: delta });
        return;
      }
      case "item/commandExecution/outputDelta": {
        const delta = params["delta"];
        const id = params["itemId"];
        if (typeof delta !== "string" || typeof id !== "string") return;
        this.outputs.set(id, (this.outputs.get(id) ?? "") + delta);
        return;
      }
      case "item/fileChange/patchUpdated": {
        const id = params["itemId"];
        if (typeof id === "string" && Array.isArray(params["changes"])) this.patches.set(id, params["changes"]);
        return;
      }
      default:
        return;
    }
  }

  /** Records that the access profile refused the call an approval request is about. */
  blocked(toolCallId: string, toolName: string): void {
    const open = this.open.get(toolCallId);
    if (open !== undefined) open.denied = true;
    this.line({ type: "blocked", toolName: open?.name ?? toolName, reason: REFUSED_IN_LOG });
  }

  private completeMessage(item: Readonly<Record<string, unknown>>): void {
    const id = item["id"];
    if (typeof id !== "string") return;
    const seen = this.messages.get(id) ?? "";
    const full = textOf(item["text"]);
    // A server that did not stream the message gives it complete; do not repeat
    // one that did.
    if (seen.length === 0 && full !== undefined) {
      this.text += full;
      this.messages.set(id, full);
      this.line({ type: "text_delta", text: full });
    }
  }

  private start(item: Readonly<Record<string, unknown>>): void {
    const id = item["id"];
    if (typeof id !== "string" || this.open.has(id)) return;
    // What was said before a tool call is not the closing message.
    this.text = "";
    const name = toolNameOf(item);
    if (isImageGen(item)) this.seenImages.add(id);
    const at = this.options.now();
    const summary = summarizeCall(this.options.profile, name, inputOf(item), this.options.cwd, {
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
    if (terminal(item)) this.end(item);
  }

  private end(item: Readonly<Record<string, unknown>>): void {
    const id = item["id"];
    if (typeof id !== "string") return;
    const call = this.open.get(id);
    if (call === undefined) return;
    this.open.delete(id);
    const output = outputOf(item, this.outputs.get(id) ?? "", this.patches.get(id));
    this.outputs.delete(id);
    this.patches.delete(id);
    const failed = failedOf(item);
    if (output.length > 0) {
      const head = capToolOutput(maskSecrets(output, this.options.secrets));
      this.line({
        type: "tool_output",
        toolCallId: id,
        text: head.text,
        ...(head.truncated ? { truncated: true } : {}),
      });
    }
    const error =
      failed && !call.denied
        ? firstErrorLine(output.length > 0 ? output : "the call failed", { secrets: this.options.secrets })
        : undefined;
    const duration = item["durationMs"];
    this.line({
      type: "tool_execution_end",
      toolCallId: id,
      toolName: call.name,
      isError: failed,
      durationMs: typeof duration === "number" ? Math.max(0, duration) : Math.max(0, this.options.now() - call.at),
      ...(error === undefined ? {} : { error }),
    });
  }

  /** Writes the closing `message_end` line of the turn. */
  finish(stopReason: string, usage: AppServerUsage | null): void {
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
