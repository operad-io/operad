/**
 * The access profile applied to the calls codex asks permission for
 * (ADR 0022 D4).
 *
 * codex-acp sends `session/request_permission` for a command that leaves the
 * sandbox, a file change and a network request. The request describes the call
 * by an ACP tool `kind`, `rawInput` and `locations`; `@operad-io/access-match`
 * judges calls by lower-case tool names and the input fields `command` and
 * `path`. `translate` is the one place that maps the two.
 */

import { findGrant, match, type AccessProfile } from "@operad-io/access-match";
import { OPERAD_SERVER, type CallAnswer, type CallQuestion } from "@operad-io/harness-process";
import { isRecord } from "@operad-io/engine";

/** One call in the words `access-match` takes. */
export interface JudgedCall {
  readonly tool: "bash" | "read" | "edit" | "grep";
  readonly input: Record<string, unknown>;
}

export type Translated =
  | { readonly kind: "calls"; readonly calls: readonly JudgedCall[] }
  | { readonly kind: "missing"; readonly field: string }
  | { readonly kind: "inert" }
  | { readonly kind: "unmapped" };

function locations(toolCall: Readonly<Record<string, unknown>>): readonly string[] {
  const list = toolCall["locations"];
  if (!Array.isArray(list)) return [];
  const paths: string[] = [];
  for (const item of list) {
    if (isRecord(item) && typeof item["path"] === "string" && item["path"].length > 0) paths.push(item["path"]);
  }
  return paths;
}

/** The command of an execute call: a string, or the words of an argv. */
export function commandOf(rawInput: unknown): string | undefined {
  if (!isRecord(rawInput)) return undefined;
  const command = rawInput["command"];
  if (typeof command === "string" && command.trim().length > 0) return command;
  if (Array.isArray(command) && command.length > 0 && command.every((word) => typeof word === "string")) {
    return command.join(" ");
  }
  return undefined;
}

/**
 * The calls the profile must judge for one permission request:
 *
 * - `execute` with a command is a `bash` call, even when it needs the network;
 *   with a `url` and no command it is a network request, which no rule names,
 *   so it is inert (the task needs the network and Codex's own sandbox asks
 *   before it leaves it);
 * - `edit`, `delete` and `move` judge each path they touch as an `edit`;
 * - `read` and `search` judge the path they name, if any;
 * - `fetch` and `think`, and a request of operad's own MCP server, are inert.
 *
 * Anything else (an MCP tool of another server, a mode switch, extra sandbox
 * permissions) is unmapped: it is allowed only when the profile has no
 * `denyPaths` and no `denyCommands`, since a rule that could match it cannot
 * be checked.
 */
export function translate(toolCall: Readonly<Record<string, unknown>>): Translated {
  const kind = toolCall["kind"];
  const rawInput = toolCall["rawInput"];
  if (isRecord(rawInput) && rawInput["serverName"] === OPERAD_SERVER) return { kind: "inert" };
  switch (kind) {
    case "execute": {
      if (isRecord(rawInput) && rawInput["serverName"] !== undefined) return { kind: "unmapped" };
      const command = commandOf(rawInput);
      // A command that needs the network is judged as the command it is.
      if (command !== undefined) return { kind: "calls", calls: [{ tool: "bash", input: { command } }] };
      if (isRecord(rawInput) && typeof rawInput["url"] === "string") return { kind: "inert" };
      return { kind: "missing", field: "command" };
    }
    case "edit":
    case "delete":
    case "move": {
      const paths = locations(toolCall);
      return paths.length === 0
        ? { kind: "missing", field: "path" }
        : { kind: "calls", calls: paths.map((path) => ({ tool: "edit" as const, input: { path } })) };
    }
    case "read":
    case "search": {
      const paths = locations(toolCall);
      const tool = kind === "read" ? ("read" as const) : ("grep" as const);
      return paths.length === 0
        ? kind === "read"
          ? { kind: "missing", field: "path" }
          : { kind: "calls", calls: [{ tool, input: {} }] }
        : { kind: "calls", calls: paths.map((path) => ({ tool, input: { path } })) };
    }
    case "fetch":
    case "think":
      return { kind: "inert" };
    default:
      return { kind: "unmapped" };
  }
}

/** Whether the profile has a rule that an unchecked call could break. */
export function hasRules(profile: AccessProfile): boolean {
  return (profile.denyPaths ?? []).length > 0 || (profile.denyCommands ?? []).length > 0;
}

export type AccessDecision =
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly reason: string;
      /** The wait for a person ended; the run is about to be ended and holds the call. */
      readonly stop?: true;
    };

/** What the step gives the decision: the host's one-time permission use and a question to a person. */
export interface Deciders {
  /** Asks the host to use up a one-time permission; without it no grant applies. */
  readonly useGrant?: ((waitId: string) => Promise<boolean>) | undefined;
  /** Asks a person about a call the profile says must ask; without it such a call is refused. */
  readonly ask?: ((question: CallQuestion & { readonly shown: string }) => Promise<CallAnswer>) | undefined;
  /** What a person reads for one call. */
  readonly shown: (call: JudgedCall) => string;
}

/**
 * Whether the call a permission request describes may run, by the same rules
 * the other harnesses apply: a deny wins; a one-time permission covers one
 * exact refused call and is used up through the host before it lets the call
 * through; a call that must ask goes to a person.
 */
export async function decideAccess(
  profile: AccessProfile,
  toolCall: Readonly<Record<string, unknown>>,
  cwd: string,
  deciders: Deciders,
): Promise<AccessDecision> {
  const translated = translate(toolCall);
  if (translated.kind === "inert") return { allow: true };
  if (translated.kind === "unmapped") {
    if (!hasRules(profile)) return { allow: true };
    return {
      allow: false,
      reason: "this call is not one the access profile can check; it is refused while denyPaths or denyCommands is set",
    };
  }
  if (translated.kind === "missing") {
    if (!hasRules(profile)) return { allow: true };
    return {
      allow: false,
      reason: `this call has no ${translated.field}; it is refused while denyPaths or denyCommands is set`,
    };
  }
  for (const judged of translated.calls) {
    const call = { tool: judged.tool, input: judged.input, cwd };
    const verdict = match(profile, call);
    if (verdict.allow) continue;
    // A one-time permission covers one exact call that would be refused. The
    // host writes the fact before it answers, so a crash after it cannot give
    // the permission twice.
    const grant = findGrant(profile, call);
    if (grant !== undefined && deciders.useGrant !== undefined) {
      let used = false;
      try {
        used = await deciders.useGrant(grant.waitId);
      } catch {
        used = false;
      }
      if (used) continue;
    }
    if (verdict.ask === true && deciders.ask !== undefined) {
      let answer: CallAnswer;
      try {
        answer = await deciders.ask({
          kind: verdict.kind,
          value: verdict.value,
          ...(verdict.tool === undefined ? {} : { tool: verdict.tool }),
          shown: deciders.shown(judged),
        });
      } catch {
        answer = { decision: "deny", reason: "the question could not be asked" };
      }
      if (answer.decision === "allow") continue;
      if (answer.decision === "stop") return { allow: false, reason: "waiting for an answer", stop: true };
      return { allow: false, reason: `${verdict.reason}; ${answer.reason ?? "a person refused it"}` };
    }
    return { allow: false, reason: verdict.reason };
  }
  return { allow: true };
}
