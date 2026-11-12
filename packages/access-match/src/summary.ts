/**
 * What a log line says about a tool call: a short summary of what ran, and the
 * first line of an error. Never file contents, tool output or environment
 * values.
 */

import { match, type AccessProfile } from "./index.ts";
import { isRecord, oneLine } from "@operad-io/engine";

/** A command is cut at this many characters. */
export const COMMAND_SUMMARY_CHARS = 500;
/** Any other summary, and an error line, is cut at this many. */
export const SUMMARY_CHARS = 300;

/** What a summary says of a command the reader could not read. */
export const COMMAND_NOT_SHOWN = "<command not shown: could not read it safely>";

/** What a log says of a refused call: the real reason names paths and commands the profile may mark secret. */
export const REFUSED_IN_LOG = "refused by the access profile";

/** What stands where a secret value was. */
const MASK = "***";

/** An environment variable whose name matches this holds a secret. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASS|PASSWORD|AUTH|CREDENTIAL)/i;
const SECRET_MIN_CHARS = 6;

/** What the summary of a call may know besides the call. */
export interface SummaryOptions {
  /** Secret values of the operad secret store; each is masked wherever it appears. */
  readonly secrets?: readonly string[] | undefined;
  /** The environment whose secret-named values are masked; defaults to this process's. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** A command keeps its line breaks (still cut at 500 characters), for a log that shows its first line. */
  readonly keepLines?: boolean | undefined;
}

/** Keys that hold the main argument of a tool, in the order they are tried. */
const MAIN_KEYS = ["file_path", "path", "notebook_path", "pattern", "query", "url", "command", "description"] as const;

/** Starts of the shell constructs the reader does not understand. */
const NOT_UNDERSTOOD = ["$(", "`", "<(", ">(", "<<", "$[", "$(("];

/**
 * The one shell-word reader: the words of a command with their spans. It
 * handles single quotes, double quotes and backslashes; undefined when a quote
 * or a trailing backslash is left open.
 */
function readWords(command: string): { start: number; end: number }[] | undefined {
  const words: { start: number; end: number }[] = [];
  let i = 0;
  while (i < command.length) {
    if (/\s/.test(command.charAt(i))) {
      i++;
      continue;
    }
    const start = i;
    while (i < command.length && !/\s/.test(command.charAt(i))) {
      const c = command.charAt(i);
      if (c === "\\") {
        if (i + 1 >= command.length) return undefined;
        i += 2;
      } else if (c === "'") {
        const close = command.indexOf("'", i + 1);
        if (close < 0) return undefined;
        i = close + 1;
      } else if (c === '"') {
        i++;
        while (i < command.length && command.charAt(i) !== '"') i += command.charAt(i) === "\\" ? 2 : 1;
        if (i >= command.length) return undefined;
        i++;
      } else {
        i++;
      }
    }
    words.push({ start, end: i });
  }
  return words;
}

/**
 * A command with the values of its leading assignments (`NAME=value` before the
 * command word) shown as `***`; the placeholder text when it cannot be read.
 */
function withoutAssignmentValues(command: string): string {
  const words = readWords(command);
  if (words === undefined) return COMMAND_NOT_SHOWN;
  let out = "";
  let at = 0;
  for (const word of words) {
    const text = command.slice(word.start, word.end);
    const name = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(text);
    if (name === null) break;
    if (NOT_UNDERSTOOD.some((mark) => text.includes(mark))) return COMMAND_NOT_SHOWN;
    out += command.slice(at, word.start) + name[0] + MASK;
    at = word.end;
  }
  return out + command.slice(at);
}

/** The values in a secret store, so a log can mask them. A store that cannot be read has none. */
export async function secretValuesOf(store: {
  names(): Promise<readonly string[]>;
  get(name: string): Promise<{ reveal(): string } | undefined>;
}): Promise<string[]> {
  try {
    const values: string[] = [];
    for (const name of await store.names()) {
      const secret = await store.get(name);
      if (secret !== undefined) values.push(secret.reveal());
    }
    return values;
  } catch {
    return [];
  }
}

/** Replaces every known secret value in the text. */
function withoutSecretValues(text: string, options: SummaryOptions): string {
  const env = options.env ?? process.env;
  const values = new Set<string>();
  for (const value of options.secrets ?? []) if (value.length > 0) values.add(value);
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value.length >= SECRET_MIN_CHARS && SECRET_NAME.test(name)) values.add(value);
  }
  let out = text;
  for (const value of [...values].sort((x, y) => y.length - x.length)) out = out.split(value).join(MASK);
  return out;
}

/** The lines of a command, each with its spaces collapsed, blank lines kept so a count of them is true, cut at the limit. */
function linesOf(text: string, limit: number): string {
  const flat = text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n");
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/**
 * The summary of one tool call, or undefined when the tool has no main
 * argument. `bash` shows its command (500 characters, one line), the file tools
 * their path, others the first of pattern, query, url or description. A call the
 * access profile denies shows only that it was denied: never its arguments.
 */
export function summarizeCall(
  profile: AccessProfile,
  toolName: string,
  input: unknown,
  cwd: string,
  options: SummaryOptions = {},
): string | undefined {
  if (!isRecord(input)) return undefined;
  const tool = toolName.toLowerCase();
  const verdict = match(profile, { tool, input, cwd });
  // A call that asks a person is shown as itself: the person sees what runs.
  if (!verdict.allow && verdict.ask !== true) {
    return `${toolName} denied by the access profile${verdict.rule === undefined ? "" : ` (rule: ${oneLine(verdict.rule, SUMMARY_CHARS)})`}`;
  }
  let text: string | undefined;
  let limit = SUMMARY_CHARS;
  if (tool === "bash") {
    const command = input["command"];
    if (typeof command === "string") {
      text = withoutAssignmentValues(command);
      limit = COMMAND_SUMMARY_CHARS;
    }
  } else {
    for (const key of MAIN_KEYS) {
      const value = input[key];
      if (typeof value === "string" && value.trim().length > 0) {
        text = value;
        break;
      }
    }
  }
  if (text === undefined || text.trim().length === 0) return undefined;
  const masked = withoutSecretValues(text, options);
  return options.keepLines === true && tool === "bash" ? linesOf(masked, limit) : oneLine(masked, limit);
}

/** The first non-empty line of an error text, cut; undefined when there is none. */
export function firstErrorLine(error: unknown, options: SummaryOptions = {}): string | undefined {
  if (typeof error !== "string") return undefined;
  const masked = withoutSecretValues(error, options);
  for (const line of masked.split("\n")) {
    if (line.trim().length > 0) return oneLine(line, SUMMARY_CHARS);
  }
  return undefined;
}

/** An assistant message as one paragraph of at most 300 characters; undefined when empty. */
export function messageSummary(text: string): string | undefined {
  const flat = oneLine(text, SUMMARY_CHARS);
  return flat.length === 0 ? undefined : flat;
}
