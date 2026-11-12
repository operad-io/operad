/**
 * The host's side of a question about one call. A harness program whose access
 * profile says a call must ask a person (`askCommands`, `askPaths`) writes one `ask_call`
 * line and waits for one `ask_ack` line on its stdin. The host turns the line
 * into `ctx.ask`, serially (the kernel takes one open question per step), and
 * answers:
 *
 * - `allow`: a person said `allow_once` within the grace period; the program
 *   lets this one call through, and no other.
 * - `deny`: a person said `reject_once`, or the question could not be asked.
 * - `stop`: the grace period passed, or the question failed. The program holds
 *   the call and the host ends the program; the step then throws what `ask`
 *   threw, which the kernel turns into the result `waiting`. The answer comes
 *   later through the flow with the session and a one-time grant for this call.
 *
 * `pi` and `claude` share this. `radian` has no such
 * line: no hook sees its calls, so it offers no grant (`degradedAskRequest`).
 */

import type { AskAnswer, AskRequest } from "@operad-io/engine";
import { isRecord } from "@operad-io/engine";

/** The choice that lets the one call through. */
export const ALLOW_ONCE = "allow_once";

/** The choice that refuses the one call. */
export const REJECT_ONCE = "reject_once";

/** The question about one call, as the program wrote it. */
export interface AskCall {
  readonly id: number;
  readonly kind: "command" | "path";
  /** The exact command, or the path: what the one-time permission covers. */
  readonly value: string;
  /** The tool a path permission is for. */
  readonly tool?: string;
  /** What a person reads: the call as the program shows it in its own log. */
  readonly shown: string;
  /** The session to continue after a late answer; null when the program has none. */
  readonly session: string | null;
}

/** The `ask_call` line, if this is one. */
export function askCall(line: string): AskCall | undefined {
  if (!line.includes('"ask_call"')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.type !== "ask_call") return undefined;
  const { id, kind, value, tool, shown, session } = parsed;
  if (typeof id !== "number" || (kind !== "command" && kind !== "path")) return undefined;
  if (typeof value !== "string" || value.length === 0 || typeof shown !== "string") return undefined;
  if (tool !== undefined && typeof tool !== "string") return undefined;
  if (session !== null && typeof session !== "string") return undefined;
  return { id, kind, value, ...(tool === undefined ? {} : { tool }), shown, session };
}

/**
 * Classifies the question lines for the stall timer: while a question is open
 * nothing is written, and that is not a stall.
 */
export function askToolEvent(line: string): "tool-start" | "tool-end" | undefined {
  if (line.includes('"ask_call"') && askCall(line) !== undefined) return "tool-start";
  if (line.includes('"ask_resolved"')) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && parsed.type === "ask_resolved") return "tool-end";
    } catch {
      // Not JSON: an ordinary line.
    }
  }
  return undefined;
}

/** Whether the run's access profile has a rule that may make a call ask. */
export function canAsk(access: unknown): boolean {
  if (!isRecord(access)) return false;
  if (access.readOnly === true) return true;
  return [access.askCommands, access.askPaths].some((rules) => Array.isArray(rules) && rules.length > 0);
}

/** The question for one call. The grace and `onTimeout` are the kernel's defaults. */
export function askRequest(call: AskCall): AskRequest {
  const prompt =
    call.kind === "command" ? `Run this command? ${call.shown}` : `Let ${call.tool ?? "the tool"} use this path? ${call.shown}`;
  const choices = [ALLOW_ONCE, REJECT_ONCE];
  // Without a session there is nothing to continue after a late answer, so
  // the question gets one answer within the grace and a refusal after it.
  if (call.session === null) return { prompt, choices, onTimeout: "reject_once" };
  return {
    prompt,
    choices,
    resume: {
      session: call.session,
      grant: {
        kind: call.kind,
        value: call.value,
        choice: ALLOW_ONCE,
        ...(call.tool === undefined ? {} : { tool: call.tool }),
      },
    },
  };
}

/**
 * The question of a harness that cannot enforce a one-time permission
 * (`radian`; `operad-contract.md` decision 6): no grant, and a refusal
 * once the grace passes, because a late `allow_once` could not be carried out.
 */
export function degradedAskRequest(prompt: string): AskRequest {
  return { prompt, choices: [ALLOW_ONCE, REJECT_ONCE], onTimeout: "reject_once" };
}

export type AskDecision = "allow" | "deny" | "stop";

/** What a program's access check asks the program's own host side about: one call. */
export interface CallQuestion {
  readonly kind: "command" | "path";
  readonly value: string;
  readonly tool?: string;
}

/** The host's answer to an `ask_call` line, as the program reads it. */
export interface CallAnswer {
  readonly decision: AskDecision;
  readonly reason?: string;
}

/** What the host holds while it answers a program's questions. */
export interface CallAsker {
  /** Answers an `ask_call` line; any other line is left alone. Questions are asked one at a time. */
  handle(line: string, reply: (text: string) => void): Promise<void>;
  /** What ended the wait (the kernel's timeout, or a failure), for the step to throw after the program ends. */
  stopped(): { readonly error: unknown } | undefined;
}

export interface CallAskerOptions {
  /** `ctx.ask`. */
  readonly ask: (request: AskRequest) => Promise<AskAnswer>;
  /** Called once when the wait ends: the program must be ended. */
  readonly onStop: () => void;
  /** Secret values of the store: a call that holds one is refused and never asked, so no fact holds a secret. */
  readonly secrets?: readonly string[] | undefined;
}

function holdsSecret(call: AskCall, secrets: readonly string[]): boolean {
  return secrets.some((secret) => secret.length > 0 && (call.value.includes(secret) || call.shown.includes(secret)));
}

export function createCallAsker(options: CallAskerOptions): CallAsker {
  let chain: Promise<void> = Promise.resolve();
  let stop: { readonly error: unknown } | undefined;

  const answer = (reply: (text: string) => void, id: number, decision: AskDecision, reason?: string): void => {
    reply(JSON.stringify({ type: "ask_ack", id, decision, ...(reason === undefined ? {} : { reason }) }));
  };

  const one = async (call: AskCall, reply: (text: string) => void): Promise<void> => {
    if (stop !== undefined) {
      answer(reply, call.id, "stop");
      return;
    }
    if (holdsSecret(call, options.secrets ?? [])) {
      answer(reply, call.id, "deny", "the call holds a secret value, so nobody is asked about it");
      return;
    }
    try {
      const got = await options.ask(askRequest(call));
      if (got.rejected === true) answer(reply, call.id, "deny", "nobody answered in time");
      else if (got.choice === ALLOW_ONCE) answer(reply, call.id, "allow");
      else answer(reply, call.id, "deny", "a person refused it");
    } catch (error) {
      stop = { error };
      answer(reply, call.id, "stop");
      options.onStop();
    }
  };

  return {
    handle(line, reply) {
      const call = askCall(line);
      if (call === undefined) return Promise.resolve();
      chain = chain.then(() => one(call, reply));
      return chain;
    },
    stopped: () => stop,
  };
}
