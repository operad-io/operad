/**
 * The access profile applied to the calls Codex asks operad about (ADR 0022
 * D4). `codex app-server` sends `item/commandExecution/requestApproval` for a
 * command that leaves its sandbox and `item/fileChange/requestApproval` for a
 * file change it may not make; the older `execCommandApproval` and
 * `applyPatchApproval` names carry the same facts. `@operad-io/access-match`
 * judges calls by lower-case tool names and the input fields `command` and
 * `path`; `translateApproval` is the one place that maps the two.
 */

import { findGrant, match, type AccessProfile } from "@operad-io/access-match";
import type { CallAnswer, CallQuestion } from "@operad-io/harness-process";
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

/** The command of a request: a string, or the words of an argv. */
export function commandOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (Array.isArray(value) && value.length > 0 && value.every((word) => typeof word === "string")) {
    return value.join(" ");
  }
  return undefined;
}

/** The paths of a file change item or of the legacy `fileChanges` map. */
function pathsOf(params: Readonly<Record<string, unknown>>, item: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  const paths: string[] = [];
  if (Array.isArray(item?.["changes"])) {
    for (const change of item["changes"]) {
      if (isRecord(change) && typeof change["path"] === "string" && change["path"].length > 0) paths.push(change["path"]);
    }
  }
  if (isRecord(params["fileChanges"])) {
    for (const path of Object.keys(params["fileChanges"])) {
      if (path.length > 0 && !paths.includes(path)) paths.push(path);
    }
  }
  const root = params["grantRoot"];
  if (typeof root === "string" && root.length > 0 && !paths.includes(root)) paths.push(root);
  return paths;
}

/**
 * The calls the profile must judge for one approval request:
 *
 * - a command approval is a `bash` call, even when it needs the network; a
 *   request with a network context and no command is inert (the task needs the
 *   network and Codex asks before it leaves its sandbox);
 * - a file-change approval judges each path it touches as an `edit`;
 * - a terminal-input approval (`writeStdin`) is not a command this profile can
 *   see, so it is unmapped.
 *
 * Anything else is unmapped: it is allowed only when the profile has no
 * `denyPaths` and no `denyCommands`, since a rule that could match it cannot
 * be checked.
 */
export function translateApproval(
  method: string,
  params: Readonly<Record<string, unknown>>,
  item: Readonly<Record<string, unknown>> | undefined,
): Translated {
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    if (params["kind"] === "writeStdin") return { kind: "unmapped" };
    const command = commandOf(params["command"]);
    if (command !== undefined) return { kind: "calls", calls: [{ tool: "bash", input: { command } }] };
    if (isRecord(params["networkApprovalContext"])) return { kind: "inert" };
    return { kind: "missing", field: "command" };
  }
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    const paths = pathsOf(params, item);
    return paths.length === 0
      ? { kind: "missing", field: "path" }
      : { kind: "calls", calls: paths.map((path) => ({ tool: "edit" as const, input: { path } })) };
  }
  return { kind: "unmapped" };
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
  method: string,
  params: Readonly<Record<string, unknown>>,
  item: Readonly<Record<string, unknown>> | undefined,
  cwd: string,
  deciders: Deciders,
): Promise<AccessDecision> {
  const translated = translateApproval(method, params, item);
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
          ...(verdict.outward === undefined ? {} : { outward: verdict.outward }),
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
