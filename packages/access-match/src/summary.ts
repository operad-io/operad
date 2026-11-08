/**
 * What a log line says about a tool call: a short summary of what ran, and the
 * first line of an error. Never file contents, tool output or environment
 * values.
 */

import { match, type AccessProfile } from "./index.ts";

/** A command is cut at this many characters. */
export const COMMAND_SUMMARY_CHARS = 500;
/** Any other summary, and an error line, is cut at this many. */
export const SUMMARY_CHARS = 300;

/** What stands where the profile forbids showing the call. */
export const REDACTED = "[redacted]";

/** Keys that hold the main argument of a tool, in the order they are tried. */
const MAIN_KEYS = ["file_path", "path", "notebook_path", "pattern", "query", "url", "command", "description"] as const;

function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/**
 * Environment assignments written in front of a command (`TOKEN=abc make`)
 * keep their name and lose their value.
 */
function withoutEnvValues(command: string): string {
  return command.replace(/(^|[\s;&|(])([A-Z_][A-Z0-9_]*)=(?:"[^"]*"|'[^']*'|\S*)/g, "$1$2=…");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The summary of one tool call, or undefined when the tool has no main
 * argument. `bash` shows its command (500 characters, one line), the file tools
 * their path, others the first of pattern, query, url or description. A call the
 * access profile refuses shows `[redacted]`: the profile marks what is secret.
 */
export function summarizeCall(
  profile: AccessProfile,
  toolName: string,
  input: unknown,
  cwd: string,
): string | undefined {
  if (!isRecord(input)) return undefined;
  const tool = toolName.toLowerCase();
  let text: string | undefined;
  let limit = SUMMARY_CHARS;
  if (tool === "bash") {
    const command = input["command"];
    if (typeof command === "string") {
      text = withoutEnvValues(command);
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
  if (!match(profile, { tool, input, cwd }).allow) return REDACTED;
  return oneLine(text, limit);
}

/** The first non-empty line of an error text, cut; undefined when there is none. */
export function firstErrorLine(error: unknown): string | undefined {
  if (typeof error !== "string") return undefined;
  for (const line of error.split("\n")) {
    if (line.trim().length > 0) return oneLine(line, SUMMARY_CHARS);
  }
  return undefined;
}

/** An assistant message as one paragraph of at most 300 characters; undefined when empty. */
export function messageSummary(text: string): string | undefined {
  const flat = oneLine(text, SUMMARY_CHARS);
  return flat.length === 0 ? undefined : flat;
}
