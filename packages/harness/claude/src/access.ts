/**
 * The access profile applied to claude's tool calls
 * (ADR 0024 D6).
 *
 * `@operad-io/access-match` judges calls by lower-case tool names and the
 * input fields `command` and `path`; claude names its tools in Title case and
 * keeps the path in `file_path` (or `notebook_path`). `TOOL_TABLE` is the one
 * place that maps the two.
 */

import { findGrant, match, MCP_TOOL, type AccessProfile } from "@operad-io/access-match";
import { OPERAD_TOOL_PREFIX, type CallAnswer, type CallQuestion } from "@operad-io/harness-process";

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
  // The agent's own question asks a person through ctx.ask, not the profile.
  "AskUserQuestion",
  "ExitPlanMode",
  "BashOutput",
  "KillShell",
  "Task",
  "Agent",
];

/** Whether the profile has a rule that an unchecked call could break. */
export function hasRules(profile: AccessProfile): boolean {
  return (
    (profile.denyPaths ?? []).length > 0 ||
    (profile.denyCommands ?? []).length > 0 ||
    (profile.level !== undefined && profile.level !== "full")
  );
}

export type Translated =
  | { readonly kind: "mapped"; readonly tool: ToolRow["tool"] | typeof MCP_TOOL; readonly input: Record<string, unknown> }
  | { readonly kind: "missing"; readonly field: string }
  | { readonly kind: "inert" }
  | { readonly kind: "unmapped" };

/** Claude's call in the words `access-match` takes. */
export function translate(name: string, input: Readonly<Record<string, unknown>>, mcpUnderProfile = false): Translated {
  // Operad's own tools run under the owner's MCP allow lists, not the profile.
  if (name.startsWith(OPERAD_TOOL_PREFIX)) return { kind: "inert" };
  // With `allowMcp` in the profile, a tool of another MCP server (`mcp__<server>__<tool>`) is judged by server and tool.
  if (mcpUnderProfile && name.startsWith("mcp__")) {
    const rest = name.slice("mcp__".length);
    const at = rest.indexOf("__");
    if (at > 0 && at + 2 < rest.length) {
      return { kind: "mapped", tool: MCP_TOOL, input: { server: rest.slice(0, at), tool: rest.slice(at + 2) } };
    }
  }
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

/** What the profile says about one call, before any grant or person is asked. */
export type ProfileCheck =
  | { readonly kind: "allow" }
  | {
      readonly kind: "grant";
      readonly waitId: string;
      readonly reason: string;
      /** The same call also matches an ask rule; without a grant it would ask. */
      readonly question?: CallQuestion | undefined;
    }
  | {
      readonly kind: "ask";
      readonly reason: string;
      readonly question: CallQuestion;
    }
  | {
      readonly kind: "refuse";
      readonly reason: string;
      /** The profile rule that refused, as the profile wrote it. */
      readonly rule?: string | undefined;
    };

/**
 * The profile's own verdict for one call: the one matcher `canUseTool` uses
 * and the `PreToolUse` hook applies before a user setting's allow rule can.
 * A grant is not a pass yet (the host may not use it up) and an ask is not a
 * refusal; only `refuse` is final.
 */
export function checkProfile(
  profile: AccessProfile,
  name: string,
  input: Readonly<Record<string, unknown>>,
  cwd: string,
): ProfileCheck {
  const translated = translate(name, input, profile.allowMcp !== undefined);
  if (translated.kind === "inert") return { kind: "allow" };
  if (translated.kind === "unmapped") {
    if (!hasRules(profile)) return { kind: "allow" };
    return {
      kind: "refuse",
      reason: `tool "${name}" is not one the access profile can check; it is refused while denyPaths or denyCommands is set`,
    };
  }
  if (translated.kind === "missing") {
    if (!hasRules(profile)) return { kind: "allow" };
    return {
      kind: "refuse",
      reason: `tool "${name}" has no ${translated.field}; it is refused while denyPaths or denyCommands is set`,
    };
  }

  const call = { tool: translated.tool, input: translated.input, cwd };
  const verdict = match(profile, call);
  if (verdict.allow) return { kind: "allow" };
  const question: CallQuestion | undefined =
    verdict.ask === true
      ? {
          kind: verdict.kind,
          value: verdict.value,
          ...(verdict.tool === undefined ? {} : { tool: verdict.tool }),
          ...(verdict.outward === undefined ? {} : { outward: verdict.outward }),
        }
      : undefined;
  // A one-time permission covers one exact call that would be refused. The
  // host writes the fact before it answers, so a crash after it cannot give
  // the permission twice.
  const grant = findGrant(profile, call);
  if (grant !== undefined) {
    return {
      kind: "grant",
      waitId: grant.waitId,
      reason: verdict.reason,
      ...(question === undefined ? {} : { question }),
    };
  }
  if (question !== undefined) return { kind: "ask", reason: verdict.reason, question };
  return {
    kind: "refuse",
    reason: verdict.reason,
    ...(verdict.rule === undefined ? {} : { rule: verdict.rule }),
  };
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
  const check = checkProfile(profile, name, input, cwd);
  if (check.kind === "allow") return { allow: true };
  if (check.kind === "grant") {
    if (useGrant !== undefined) {
      let used = false;
      try {
        used = await useGrant(check.waitId);
      } catch {
        used = false;
      }
      if (used) return { allow: true };
    }
    if (check.question !== undefined && ask !== undefined) {
      return askFor(ask, check.question, check.reason);
    }
    return { allow: false, reason: check.reason };
  }
  if (check.kind === "ask") {
    if (ask === undefined) return { allow: false, reason: check.reason };
    return askFor(ask, check.question, check.reason);
  }
  return { allow: false, reason: check.reason };
}

async function askFor(
  ask: (question: CallQuestion) => Promise<CallAnswer>,
  question: CallQuestion,
  reason: string,
): Promise<AccessDecision> {
  let answer: CallAnswer;
  try {
    answer = await ask(question);
  } catch {
    answer = { decision: "deny", reason: "the question could not be asked" };
  }
  if (answer.decision === "allow") return { allow: true };
  if (answer.decision === "stop") return { allow: false, reason: "waiting for an answer", stop: true };
  return { allow: false, reason: `${reason}; ${answer.reason ?? "a person refused it"}` };
}
