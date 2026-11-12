/**
 * The lines the child programs of the claude and pi harnesses, and radian's
 * journal once `radianLogLine` has turned it into the same shapes, write to a
 * step's log. A harness keeps in its own protocol only the lines that are its
 * own (a session, a message's usage, a result).
 */

/** The longest tool output one `tool_output` line carries, in bytes of UTF-8. */
export const TOOL_OUTPUT_CAP_BYTES = 64 * 1024;

export type SharedLine =
  | {
      readonly type: "tool_execution_start";
      readonly toolCallId: string;
      readonly toolName: string;
      /** When the call started, in epoch milliseconds. */
      readonly at: number;
      /** What ran: the command (500 characters), the path, or the main argument; absent when there is none. */
      readonly input?: string;
    }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly isError: boolean;
      /** How long the call took. */
      readonly durationMs: number;
      /** The first line of the error, when the call failed. */
      readonly error?: string;
    }
  | { readonly type: "blocked"; readonly toolName: string; readonly reason: string }
  /**
   * The program asks to use up a one-time permission before it lets a call
   * through. The host writes the fact and answers on stdin with a
   * `GrantAck` line; only `used: true` lets the call run.
   */
  | { readonly type: "grant_use"; readonly id: number; readonly waitId: string }
  /**
   * The program asks a person whether one call may run (the access profile's
   * `askCommands`) and holds the call until the host answers with an `AskAck`
   * line. `session` is what a late answer continues. `ask_resolved` follows
   * the answer, so the host knows the question is closed.
   */
  | {
      readonly type: "ask_call";
      readonly id: number;
      readonly kind: "command" | "path";
      readonly value: string;
      readonly tool?: string;
      readonly shown: string;
      readonly session: string | null;
    }
  | { readonly type: "ask_resolved"; readonly id: number }
  /** New assistant text only, not the text so far. No harness writes it yet. */
  | { readonly type: "text_delta"; readonly text: string }
  /** New thinking only, not the thinking so far. No harness writes it yet. */
  | { readonly type: "thinking_delta"; readonly text: string }
  /** The full text of a finished assistant message. No harness writes it yet. */
  | { readonly type: "text_end"; readonly text: string }
  /** The full text of a finished thinking block. No harness writes it yet. */
  | { readonly type: "thinking_end"; readonly text: string }
  /**
   * What a tool call printed, as text cut to `TOOL_OUTPUT_CAP_BYTES`;
   * `truncated` is true when it was cut. No harness writes it yet.
   */
  | {
      readonly type: "tool_output";
      readonly toolCallId: string;
      readonly text: string;
      readonly truncated?: true;
    };

/** Cuts `text` to the output cap without splitting a character; says whether it cut. */
export function capToolOutput(text: string): { readonly text: string; readonly truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= TOOL_OUTPUT_CAP_BYTES) return { text, truncated: false };
  let cut = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, TOOL_OUTPUT_CAP_BYTES));
  // A character split by the cut decodes to U+FFFD at the end.
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return { text: cut, truncated: true };
}

/**
 * Hands a line that was written to the log to the caller's receiver. A
 * receiver that throws does not stop the step: the log has the line.
 */
export function deliverLine(receiver: ((line: string) => void) | undefined, line: string): void {
  if (receiver === undefined) return;
  try {
    receiver(line);
  } catch {
    // the log is the record; the caller's trouble stays the caller's
  }
}
