/**
 * The command a question asks a person to run themselves (ADR 0008 D9). The
 * kernel checks that it is one bounded line and carries it; it never runs it.
 */

/** The longest command a question may carry. */
export const MAX_ASK_COMMAND = 2048;

/** What is wrong with a `command` value, if anything. */
export function askCommandProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) return "must be a non-empty string";
  if (value.length > MAX_ASK_COMMAND) return `must be at most ${MAX_ASK_COMMAND} characters`;
  // A line break, a terminal escape, a bidirectional override or a zero-width
  // character would make the line copied differ from the one read.
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) return "must be one line with no control or format character";
  return undefined;
}

/**
 * Reads a command a fact or a step's data carries. A value that cannot be read
 * is left out, so an old or corrupt log does not hide a question.
 */
export function storedAskCommand(value: unknown): string | undefined {
  return typeof value === "string" && askCommandProblem(value) === undefined ? value : undefined;
}
