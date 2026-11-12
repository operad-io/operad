/**
 * Folds the lines of a step's log into entries: what the agent said, what it
 * thought and each tool call. A pure function: the state it returns can be fed
 * back with the next lines, and the entries are the same whether the lines come
 * all at once or one at a time.
 */

import { isRecord } from "@operad-io/engine";

export type ToolResult = "done" | "failed" | "blocked" | "denied";

export type FoldEntry =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly callId: string;
      readonly toolName: string;
      readonly input: string | null;
      readonly result: ToolResult;
      /** Epoch milliseconds; null when the log has no start line for the call. */
      readonly at: number | null;
      readonly durationMs: number;
      readonly output: string | null;
      readonly outputTruncated: boolean;
      /** The first line of the error, when the call failed. */
      readonly error: string | null;
    };

/** A tool call that has started and not ended. */
export interface OpenCall {
  readonly callId: string;
  readonly toolName: string;
  readonly input: string | null;
  readonly at: number;
  readonly output: string | null;
  readonly outputTruncated: boolean;
  /** The reason of a `blocked` line seen for this call. */
  readonly blocked: string | null;
}

export interface FoldState {
  /** What has finished, in the order it finished. */
  readonly entries: readonly FoldEntry[];
  /** Text written so far and not finished. */
  readonly text: string;
  /** Thinking written so far and not finished. */
  readonly thinking: string;
  /** Tool calls with no end, in the order they started. */
  readonly calls: readonly OpenCall[];
  /** True when the current message has put text into the entries or `text` already. */
  readonly sawText: boolean;
  /** A `blocked` line that came before its call started, by tool name. */
  readonly earlyBlocks: Readonly<Record<string, string>>;
}

export const emptyFold: FoldState = {
  entries: [],
  text: "",
  thinking: "",
  calls: [],
  sawText: false,
  earlyBlocks: {},
};

const DENIED = " denied by the access profile";

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Puts unfinished text and thinking into the entries. */
function settle(state: FoldState): FoldState {
  const entries = [...state.entries];
  if (state.thinking.length > 0) entries.push({ kind: "thinking", text: state.thinking });
  if (state.text.length > 0) entries.push({ kind: "text", text: state.text });
  return { ...state, entries, text: "", thinking: "", sawText: state.sawText || state.text.length > 0 };
}

function apply(state: FoldState, line: unknown): FoldState {
  if (!isRecord(line)) return state;
  const type = str(line["type"]);
  switch (type) {
    case "text_delta": {
      const text = str(line["text"]);
      return text === undefined ? state : { ...state, text: state.text + text, sawText: true };
    }
    case "thinking_delta": {
      const text = str(line["text"]);
      return text === undefined ? state : { ...state, thinking: state.thinking + text };
    }
    case "text_end": {
      const text = str(line["text"]);
      if (text === undefined) return state;
      return {
        ...state,
        entries: [...state.entries, { kind: "text", text }],
        text: "",
        sawText: true,
      };
    }
    case "thinking_end": {
      const text = str(line["text"]);
      if (text === undefined) return state;
      return { ...state, entries: [...state.entries, { kind: "thinking", text }], thinking: "" };
    }
    case "message_end": {
      const settled = settle(state);
      const said = str(line["text"]);
      // Today's harnesses write only the head of a message's text here.
      const entries =
        !settled.sawText && said !== undefined && said.length > 0
          ? [...settled.entries, { kind: "text" as const, text: said }]
          : settled.entries;
      return { ...settled, entries, sawText: false };
    }
    case "tool_execution_start": {
      const callId = str(line["toolCallId"]);
      const toolName = str(line["toolName"]);
      const at = line["at"];
      if (callId === undefined || toolName === undefined || typeof at !== "number") return state;
      if (state.calls.some((call) => call.callId === callId)) return state;
      const settled = settle(state);
      const early = settled.earlyBlocks[toolName];
      const { [toolName]: _used, ...rest } = settled.earlyBlocks;
      const call: OpenCall = {
        callId,
        toolName,
        input: str(line["input"]) ?? null,
        at,
        output: null,
        outputTruncated: false,
        blocked: early ?? null,
      };
      return { ...settled, calls: [...settled.calls, call], earlyBlocks: early === undefined ? settled.earlyBlocks : rest };
    }
    case "blocked": {
      const toolName = str(line["toolName"]);
      if (toolName === undefined) return state;
      const reason = str(line["reason"]) ?? "";
      // The latest open call of that name that is not blocked yet.
      let index = -1;
      state.calls.forEach((call, at) => {
        if (call.toolName === toolName && call.blocked === null) index = at;
      });
      if (index < 0) return { ...state, earlyBlocks: { ...state.earlyBlocks, [toolName]: reason } };
      return {
        ...state,
        calls: state.calls.map((call, at) => (at === index ? { ...call, blocked: reason } : call)),
      };
    }
    case "tool_output": {
      const callId = str(line["toolCallId"]);
      const text = str(line["text"]);
      if (callId === undefined || text === undefined) return state;
      const truncated = line["truncated"] === true;
      if (state.calls.some((call) => call.callId === callId)) {
        return {
          ...state,
          calls: state.calls.map((call) =>
            call.callId === callId
              ? { ...call, output: (call.output ?? "") + text, outputTruncated: call.outputTruncated || truncated }
              : call,
          ),
        };
      }
      // Output after the end: it belongs to the entry that closed the call.
      let index = -1;
      state.entries.forEach((entry, at) => {
        if (entry.kind === "tool" && entry.callId === callId) index = at;
      });
      if (index < 0) return state;
      return {
        ...state,
        entries: state.entries.map((entry, at) =>
          at === index && entry.kind === "tool"
            ? { ...entry, output: (entry.output ?? "") + text, outputTruncated: entry.outputTruncated || truncated }
            : entry,
        ),
      };
    }
    case "tool_execution_end": {
      const callId = str(line["toolCallId"]);
      if (callId === undefined) return state;
      const settled = settle(state);
      const open = settled.calls.find((call) => call.callId === callId);
      const toolName = open?.toolName ?? str(line["toolName"]) ?? "tool";
      const isError = line["isError"] === true;
      const denied = open?.input?.includes(DENIED) === true;
      const result: ToolResult = !isError ? "done" : denied ? "denied" : typeof open?.blocked === "string" ? "blocked" : "failed";
      const ownError = str(line["error"]);
      const error =
        result === "done" || result === "denied"
          ? null
          : ownError !== undefined
            ? firstLine(ownError)
            : typeof open?.blocked === "string"
              ? firstLine(open.blocked)
              : null;
      const duration = line["durationMs"];
      const entry: FoldEntry = {
        kind: "tool",
        callId,
        toolName,
        input: open?.input ?? null,
        result,
        at: open?.at ?? null,
        durationMs: typeof duration === "number" ? duration : 0,
        output: open?.output ?? null,
        outputTruncated: open?.outputTruncated ?? false,
        error,
      };
      return {
        ...settled,
        entries: [...settled.entries, entry],
        calls: settled.calls.filter((call) => call.callId !== callId),
      };
    }
    default:
      return state;
  }
}

/**
 * Adds `lines` (parsed log lines; a line that is not one of the shapes is
 * skipped) to `from`. `foldLines(all)` and feeding the same lines one call at
 * a time give the same state. What is not finished stays in `text`,
 * `thinking` and `calls`.
 */
export function foldLines(lines: readonly unknown[], from: FoldState = emptyFold): FoldState {
  let state = from;
  for (const line of lines) state = apply(state, line);
  return state;
}
