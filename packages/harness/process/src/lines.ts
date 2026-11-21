/**
 * The lines the child programs of the claude and pi harnesses, and radian's
 * journal once `radianLogLine` has turned it into the same shapes, write to a
 * step's log. A harness keeps in its own protocol only the lines that are its
 * own (a session, a message's usage, a result).
 */

/** The longest tool output one `tool_output` line carries, in bytes of UTF-8. */
export const TOOL_OUTPUT_CAP_BYTES = 64 * 1024;

export type SharedLine =
  /**
   * Written once when the harness session is ready, before the prompt goes to
   * the model. Every harness writes this line type, so a reader can time the
   * wait for the worker apart from the wait for the model.
   */
  | {
      readonly type: "session";
      readonly sessionId?: string | null;
      readonly model?: string | null;
    }
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
   * The harness is waiting before it asks the model again. `delayMs` is how
   * long it waits, and `reason` is the provider's message that caused it.
   */
  | {
      readonly type: "retry_start";
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly reason: string;
    }
  /** The retry is over: it succeeded, or it ran out and the failure follows. */
  | { readonly type: "retry_end"; readonly success: boolean }
  /** A line for the step log that neither the model nor the fold reads. */
  | { readonly type: "log"; readonly text: string }
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
  /**
   * The program asks the person the questions its agent asked, as one form,
   * and holds the call until the host answers with an `AskFormAck` line.
   * `session` is what a late answer continues.
   */
  | {
      readonly type: "ask_form";
      readonly id: number;
      readonly questions: readonly unknown[];
      readonly session: string | null;
    }
  /** New assistant text only, not the text so far. */
  | { readonly type: "text_delta"; readonly text: string }
  /** New thinking only, not the thinking so far. */
  | { readonly type: "thinking_delta"; readonly text: string }
  /** The full text of a finished assistant message. */
  | { readonly type: "text_end"; readonly text: string }
  /** The full text of a finished thinking block. */
  | { readonly type: "thinking_end"; readonly text: string }
  /**
   * What a tool call printed. A line carries at most `TOOL_OUTPUT_CAP_BYTES`;
   * a longer output is written as consecutive lines with the same call id.
   * `truncated` is only for a line a caller had to cut.
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
  // Back off to the start of a character: a continuation byte is 10xxxxxx.
  let end = TOOL_OUTPUT_CAP_BYTES;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  const cut = new TextDecoder().decode(bytes.subarray(0, end));
  return { text: cut, truncated: true };
}

/**
 * The `tool_output` payloads for what a tool printed: the text masked once,
 * then cut into pieces no longer than the shared cap. Joining the pieces gives
 * the whole output back; a short output is one piece.
 */
export function toolOutputLines(
  text: string,
  secrets: readonly string[],
): readonly { readonly text: string }[] {
  const masked = maskSecrets(text, secrets);
  const bytes = new TextEncoder().encode(masked);
  if (bytes.length <= TOOL_OUTPUT_CAP_BYTES) return [{ text: masked }];
  const lines: { text: string }[] = [];
  const decoder = new TextDecoder();
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + TOOL_OUTPUT_CAP_BYTES, bytes.length);
    // Back off to the start of a character: a continuation byte is 10xxxxxx.
    while (end > start && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    lines.push({ text: decoder.decode(bytes.subarray(start, end)) });
    start = end;
  }
  return lines;
}

/** Replaces every secret value in a log line, also as it is written inside JSON text, with `***`. */
export function maskSecrets(line: string, secrets: readonly string[]): string {
  let masked = line;
  for (const secret of [...secrets].sort((x, y) => y.length - x.length)) {
    if (secret.length === 0) continue;
    masked = masked.split(secret).join("***");
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) masked = masked.split(escaped).join("***");
  }
  return masked;
}

/** The shortest time between two increment lines of one stream, in milliseconds. */
export const STREAM_GROUP_MS = 100;

/** The spellings `maskSecrets` masks for one value: the value and, if it differs, its JSON text. */
function spellingsOf(secret: string): readonly string[] {
  if (secret.length === 0) return [];
  const escaped = JSON.stringify(secret).slice(1, -1);
  return escaped === secret ? [secret] : [secret, escaped];
}

/**
 * Splits an increment so that no line ends inside a secret: the longest suffix
 * of `text` that is a proper prefix of a secret value is held back and joined
 * to the next increment, where the completed secret is masked. A secret that
 * is wholly in the emitted part is masked there. Both the value as written and
 * its JSON-escaped spelling count, as `maskSecrets` masks both.
 */
export function splitSecretPrefix(
  text: string,
  secrets: readonly string[],
): { readonly emit: string; readonly held: string } {
  let held = 0;
  for (const secret of secrets.flatMap(spellingsOf)) {
    const longest = Math.min(secret.length - 1, text.length);
    for (let length = longest; length > held; length -= 1) {
      if (text.endsWith(secret.slice(0, length))) {
        held = length;
        break;
      }
    }
  }
  if (held === 0) return { emit: text, held: "" };
  return { emit: text.slice(0, text.length - held), held: text.slice(text.length - held) };
}

export type IncrementKind = "text" | "thinking";

/** A line an increment writes: new text or thinking, or the full text that ends it. */
export interface IncrementLine {
  readonly type: "text_delta" | "thinking_delta" | "text_end" | "thinking_end";
  readonly text: string;
}

/** Where increments are written. */
export interface IncrementSink {
  line(line: IncrementLine): void;
}

export interface IncrementsOptions {
  /**
   * Write the first part of a stream as soon as it arrives. A harness that
   * groups from the first part instead (claude) passes false: it writes when
   * the next part comes after `STREAM_GROUP_MS`, or when the block ends.
   */
  readonly firstImmediately?: boolean;
}

/**
 * Assistant text and thinking as they stream. A line carries the new text
 * only, and each stream writes at most one per `STREAM_GROUP_MS`: a message
 * that arrives faster is grouped. Secret values are masked in every line, and
 * a suffix that could start one is held back until the next part completes it
 * or the stream ends.
 */
export class Increments {
  #text = "";
  #thinking = "";
  #textAt: number | undefined;
  #thinkingAt: number | undefined;
  readonly #firstImmediately: boolean;

  constructor(
    private readonly io: IncrementSink,
    private readonly now: () => number,
    private readonly secrets: readonly string[],
    options: IncrementsOptions = {},
  ) {
    this.#firstImmediately = options.firstImmediately ?? true;
  }

  text(delta: string): void {
    if (delta.length === 0) return;
    const at = this.now();
    if (this.#firstImmediately) {
      this.#text += delta;
      if (this.#textAt === undefined || at - this.#textAt >= STREAM_GROUP_MS) this.#writeText(at, false);
      return;
    }
    if (this.#textAt !== undefined && at - this.#textAt >= STREAM_GROUP_MS) this.#writeText(at, false);
    if (this.#textAt === undefined) this.#textAt = at;
    this.#text += delta;
  }

  thinking(delta: string): void {
    if (delta.length === 0) return;
    const at = this.now();
    if (this.#firstImmediately) {
      this.#thinking += delta;
      if (this.#thinkingAt === undefined || at - this.#thinkingAt >= STREAM_GROUP_MS) {
        this.#writeThinking(at, false);
      }
      return;
    }
    if (this.#thinkingAt !== undefined && at - this.#thinkingAt >= STREAM_GROUP_MS) {
      this.#writeThinking(at, false);
    }
    if (this.#thinkingAt === undefined) this.#thinkingAt = at;
    this.#thinking += delta;
  }

  /**
   * Writes what a stream has buffered. A complete flush writes a held suffix
   * too, when the block ends and no later part can complete it; an incomplete
   * one keeps the suffix that could start a secret.
   */
  flush(kind: IncrementKind, complete: boolean): void {
    if (kind === "text") {
      if (this.#text.length === 0) {
        if (complete) this.#textAt = undefined;
        return;
      }
      this.#writeText(undefined, complete);
      return;
    }
    if (this.#thinking.length === 0) {
      if (complete) this.#thinkingAt = undefined;
      return;
    }
    this.#writeThinking(undefined, complete);
  }

  /** A thinking block finished: its full text follows the increments. */
  endThinking(text: string): void {
    this.#thinking = "";
    this.#thinkingAt = undefined;
    if (text.length > 0) this.io.line({ type: "thinking_end", text: maskSecrets(text, this.secrets) });
  }

  /** An assistant message finished: its full text follows the increments. */
  endMessage(text: string): void {
    if (text.length > 0) {
      this.#text = "";
      this.#textAt = undefined;
      this.io.line({ type: "text_end", text: maskSecrets(text, this.secrets) });
    } else if (this.#text.length > 0) {
      this.#writeText(this.now(), false);
    }
    // A thinking block that ended wrote its own full text; anything left is
    // a block the run stopped in, and the increments are all it has.
    if (this.#thinking.length > 0) this.#writeThinking(this.now(), false);
  }

  /**
   * The stream is ending and no later text can complete a held prefix: write
   * it now, masked when it holds a whole secret. Every end path calls this
   * before its Result, so a stopped reply keeps what it had reached.
   */
  release(): void {
    if (this.#text.length > 0) {
      this.io.line({ type: "text_delta", text: maskSecrets(this.#text, this.secrets) });
      this.#text = "";
      this.#textAt = undefined;
    }
    if (this.#thinking.length > 0) {
      this.io.line({ type: "thinking_delta", text: maskSecrets(this.#thinking, this.secrets) });
      this.#thinking = "";
      this.#thinkingAt = undefined;
    }
  }

  #writeText(at: number | undefined, complete: boolean): void {
    const { emit, held } = complete
      ? { emit: this.#text, held: "" }
      : splitSecretPrefix(this.#text, this.secrets);
    if (emit.length > 0) this.io.line({ type: "text_delta", text: maskSecrets(emit, this.secrets) });
    this.#text = held;
    this.#textAt = complete ? undefined : at ?? this.#textAt;
  }

  #writeThinking(at: number | undefined, complete: boolean): void {
    const { emit, held } = complete
      ? { emit: this.#thinking, held: "" }
      : splitSecretPrefix(this.#thinking, this.secrets);
    if (emit.length > 0) this.io.line({ type: "thinking_delta", text: maskSecrets(emit, this.secrets) });
    this.#thinking = held;
    this.#thinkingAt = complete ? undefined : at ?? this.#thinkingAt;
  }
}

/**
 * Hands a line that was written to the log to the caller's receiver, with the
 * secret values masked. A receiver that throws does not stop the step: the log
 * has the line.
 */
export function deliverLine(
  receiver: ((line: string) => void) | undefined,
  line: string,
  secrets: readonly string[],
): void {
  if (receiver === undefined) return;
  try {
    receiver(maskSecrets(line, secrets));
  } catch {
    // the log is the record; the caller's trouble stays the caller's
  }
}
