/**
 * The access profile applied to claude's tool calls
 * (docs/backlog/operad-harness-claude.md decision 6).
 *
 * `@operad-io/access-match` judges calls by lower-case tool names and the
 * input fields `command` and `path`; claude names its tools in Title case and
 * keeps the path in `file_path` (or `notebook_path`). `TOOL_TABLE` is the one
 * place that maps the two.
 */

import { findGrant, match, type AccessProfile } from "@operad-io/access-match";
import type { CallAnswer, CallQuestion } from "@operad-io/harness-process";

export type { CallAnswer, CallQuestion };

/** One tool of claude and what `access-match` calls it. */
export interface ToolRow {
  /** The tool name claude uses. */
  readonly claude: string;
  /** The name `access-match` knows. */
  readonly tool: "bash" | "read" | "write" | "edit" | "grep" | "find" | "ls";
  /** The input field of claude's call that holds the command or the path. */
  readonly from: "command" | "file_path" | "notebook_path" | "path";
  /** The field `access-match` reads it from. */
  readonly to: "command" | "path";
  /**
   * Whether the call must carry that field. When it must and does not, the
   * call is refused while a rule is set: a call without its target cannot be
   * judged. `Glob` and `Grep` search the working directory without one.
   */
  readonly required: boolean;
}

export const TOOL_TABLE: readonly ToolRow[] = [
  { claude: "Bash", tool: "bash", from: "command", to: "command", required: true },
  { claude: "Read", tool: "read", from: "file_path", to: "path", required: true },
  { claude: "Write", tool: "write", from: "file_path", to: "path", required: true },
  { claude: "Edit", tool: "edit", from: "file_path", to: "path", required: true },
  { claude: "MultiEdit", tool: "edit", from: "file_path", to: "path", required: true },
  { claude: "NotebookEdit", tool: "edit", from: "notebook_path", to: "path", required: true },
  { claude: "Grep", tool: "grep", from: "path", to: "path", required: false },
  { claude: "Glob", tool: "find", from: "path", to: "path", required: false },
];

/**
 * Tools that neither run a command nor name a file, so no deny rule can
 * apply to them. A subagent (`Task`, `Agent`) is here because every tool call
 * of the subagent comes to `canUseTool` too and is judged on its own.
 *
 * A tool in neither list is unmapped: it is allowed only when the profile
 * has no `denyPaths` and no `denyCommands`, since a rule that could match it
 * cannot be checked. That covers MCP tools and any tool a later claude adds.
 */
export const INERT_TOOLS: readonly string[] = [
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "ExitPlanMode",
  "BashOutput",
  "KillShell",
  "Task",
  "Agent",
];

/** Whether the profile has a rule that an unchecked call could break. */
export function hasRules(profile: AccessProfile): boolean {
  return (profile.denyPaths ?? []).length > 0 || (profile.denyCommands ?? []).length > 0;
}

export type Translated =
  | { readonly kind: "mapped"; readonly tool: ToolRow["tool"]; readonly input: Record<string, unknown> }
  | { readonly kind: "missing"; readonly field: string }
  | { readonly kind: "inert" }
  | { readonly kind: "unmapped" };

/** Claude's call in the words `access-match` takes. */
export function translate(name: string, input: Readonly<Record<string, unknown>>): Translated {
  const row = TOOL_TABLE.find((candidate) => candidate.claude === name);
  if (row === undefined) {
    return INERT_TOOLS.includes(name) ? { kind: "inert" } : { kind: "unmapped" };
  }
  const value = input[row.from];
  if (typeof value === "string" && value.length > 0) {
    return { kind: "mapped", tool: row.tool, input: { [row.to]: value } };
  }
  return row.required ? { kind: "missing", field: row.from } : { kind: "mapped", tool: row.tool, input: {} };
}

export type AccessDecision =
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly reason: string;
      /** The wait for a person ended; the program is about to be ended and holds the call. */
      readonly stop?: true;
    };

/**
 * Whether one call of claude may run. `useGrant` asks the host to use up a
 * one-time permission; without it no grant applies. `ask` asks a person about a
 * call the profile says must ask (`askCommands`, `askPaths`); without it such a call is
 * refused. A deny wins over an ask, so `ask` only ever sees a call no deny
 * rule matched.
 */
export async function decideAccess(
  profile: AccessProfile,
  name: string,
  input: Readonly<Record<string, unknown>>,
  cwd: string,
  useGrant?: (waitId: string) => Promise<boolean>,
  ask?: (question: CallQuestion) => Promise<CallAnswer>,
): Promise<AccessDecision> {
  const translated = translate(name, input);
  if (translated.kind === "inert") return { allow: true };
  if (translated.kind === "unmapped") {
    if (!hasRules(profile)) return { allow: true };
    return {
      allow: false,
      reason: `tool "${name}" is not one the access profile can check; it is refused while denyPaths or denyCommands is set`,
    };
  }
  if (translated.kind === "missing") {
    if (!hasRules(profile)) return { allow: true };
    return {
      allow: false,
      reason: `tool "${name}" has no ${translated.field}; it is refused while denyPaths or denyCommands is set`,
    };
  }

  const call = { tool: translated.tool, input: translated.input, cwd };
  const verdict = match(profile, call);
  if (verdict.allow) return { allow: true };
  // A one-time permission covers one exact call that would be refused. The
  // host writes the fact before it answers, so a crash after it cannot give
  // the permission twice.
  const grant = findGrant(profile, call);
  if (grant !== undefined && useGrant !== undefined) {
    let used = false;
    try {
      used = await useGrant(grant.waitId);
    } catch {
      used = false;
    }
    if (used) return { allow: true };
  }
  if (verdict.ask === true && ask !== undefined) {
    let answer: CallAnswer;
    try {
      answer = await ask({ kind: verdict.kind, value: verdict.value, ...(verdict.tool === undefined ? {} : { tool: verdict.tool }) });
    } catch {
      answer = { decision: "deny", reason: "the question could not be asked" };
    }
    if (answer.decision === "allow") return { allow: true };
    if (answer.decision === "stop") return { allow: false, reason: "waiting for an answer", stop: true };
    return { allow: false, reason: `${verdict.reason}; ${answer.reason ?? "a person refused it"}` };
  }
  return { allow: false, reason: verdict.reason };
}
