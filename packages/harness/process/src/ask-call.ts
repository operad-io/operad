/**
 * The host's side of a question about one call. A harness program whose access
 * profile says a call must ask a person (`askCommands`, `askPaths`) writes one `ask_call`
 * line and waits for one `ask_ack` line on its stdin. The host turns the line
 * into `ctx.ask`, serially (the kernel takes one open question per step), and
 * answers:
 *
 * - `allow`: a person said `allow_once` or `allow_always` within the grace
 *   period; the program lets this one call through, and no other. `allow_always`
 *   also appends the entry to the access profile's user layer. On an outward
 *   question `allow_target` records a target grant for the flow definition.
 * - `deny`: a person said `reject_once`, or the question could not be asked.
 * - `stop`: the grace period passed, or the question failed. The program holds
 *   the call and the host ends the program; the step then throws what `ask`
 *   threw, which the kernel turns into the result `waiting`. The answer comes
 *   later through the flow with the session and a one-time grant for this call.
 *
 * `pi` and `claude` share this. `radian` has no such
 * line: no hook sees its calls, so it offers no grant (`degradedAskRequest`).
 */

import { messageOf } from "@operad-io/engine";
import type { AskAnswer, AskQuestion, AskQuestionAnswer, AskRequest, FlowDefinition, OutwardWrite } from "@operad-io/engine";
import { isRecord } from "@operad-io/engine";
import { OUTWARD_ALLOW_TARGET, OUTWARD_SEND_ONCE, appendTargetGrant, outwardCommandWrites, outwardQuestion, targetGrantFor } from "@operad-io/access-match";
import { alwaysAllowEntry, appendAlwaysAllow, type AlwaysAllowEntry } from "./always-allow.ts";

/** The choice that lets the one call through. */
export const ALLOW_ONCE = "allow_once";

/** The choice that lets the one call through and remembers it for later calls. */
export const ALLOW_ALWAYS = "allow_always";

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
  /** The outward write this question is about, in a background run. */
  readonly outward?: OutwardWrite | undefined;
}

/** The `ctx.ask` request for a form a program asked, with the way back. */
export function askFormRequest(form: AskForm): AskRequest {
  return {
    prompt: form.questions.map((question) => question.text).join("\n\n"),
    questions: form.questions,
    ...(form.session === null
      ? { onTimeout: "reject_once" as const }
      : { resume: { session: form.session } }),
  };
}

/** The program's answer from what `ctx.ask` returned. */
export function formAnswer(answer: AskAnswer): FormAnswer {
  if (answer.rejected === true) return { decision: "rejected" };
  return {
    decision: "answered",
    answers: answer.answers ?? [],
    ...(answer.note === undefined ? {} : { note: answer.note }),
  };
}

/** Puts one form through an asker and resolves with the program's answer. */
export function askedForm(
  asker: CallAsker,
  id: number,
  form: { readonly questions: readonly AskQuestion[]; readonly session: string | null },
): Promise<FormAnswer> {
  return new Promise<FormAnswer>((resolve) => {
    void asker.handle(
      JSON.stringify({ type: "ask_form", id, questions: form.questions, session: form.session }),
      (reply) => {
        try {
          const ack: unknown = JSON.parse(reply);
          if (isRecord(ack) && ack.type === "ask_form_ack") {
            const decision = ack.decision;
            resolve({
              decision: decision === "answered" || decision === "stop" ? decision : "rejected",
              ...(Array.isArray(ack.answers)
                ? { answers: ack.answers as readonly AskQuestionAnswer[] }
                : {}),
              ...(typeof ack.note === "string" ? { note: ack.note } : {}),
            });
            return;
          }
        } catch {
          // Fall through to a refusal.
        }
        resolve({ decision: "rejected" });
      },
    );
  });
}

function outwardOf(value: unknown): OutwardWrite | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value["kind"];
  const target = value["target"];
  const content = value["content"];
  const owner = value["owner"];
  if (kind !== "channel" && kind !== "mail" && kind !== "post" && kind !== "repository" && kind !== "service" && kind !== "command") {
    return undefined;
  }
  if (typeof target !== "string" || target.length === 0) return undefined;
  if (content !== undefined && typeof content !== "string") return undefined;
  if (owner !== undefined && typeof owner !== "boolean") return undefined;
  return {
    kind,
    target,
    ...(content === undefined ? {} : { content }),
    ...(owner === undefined ? {} : { owner }),
  };
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
  const outward = outwardOf(parsed.outward);
  return { id, kind, value, ...(tool === undefined ? {} : { tool }), shown, session, ...(outward === undefined ? {} : { outward }) };
}

/**
 * The question an agent asked in its own words: one form (ADR 0026 D6). The
 * program writes one `ask_form` line and waits for one `ask_form_ack` line, so
 * a person fills the form in as one question.
 */
export interface AskForm {
  readonly id: number;
  readonly questions: readonly AskQuestion[];
  /** The session a late answer continues; null when the program has none. */
  readonly session: string | null;
}

/** How a form's question ended, as the program reads it. */
export interface FormAnswer {
  readonly decision: "answered" | "rejected" | "stop";
  readonly answers?: readonly AskQuestionAnswer[] | undefined;
  /** The person's note for the whole form, when they wrote one. */
  readonly note?: string | undefined;
}

/** The `ask_form` line, if this is one. */
export function askFormLine(line: string): AskForm | undefined {
  if (!line.includes('"ask_form"')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.type !== "ask_form") return undefined;
  const { id, questions, session } = parsed;
  if (typeof id !== "number" || !Array.isArray(questions)) return undefined;
  if (session !== null && typeof session !== "string") return undefined;
  const form: AskQuestion[] = [];
  for (const raw of questions) {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.text !== "string") return undefined;
    form.push(raw as unknown as AskQuestion);
  }
  if (form.length === 0) return undefined;
  return { id, questions: form, session };
}

/**
 * Classifies the question lines for the stall timer: while a question is open
 * nothing is written, and that is not a stall.
 */
export function askToolEvent(line: string): "tool-start" | "tool-end" | undefined {
  if (line.includes('"ask_call"') && askCall(line) !== undefined) return "tool-start";
  if (line.includes('"ask_form"') && askFormLine(line) !== undefined) return "tool-start";
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
  const full = access.level === "full";
  // A read-only working directory and a write under readPaths ask at every level.
  if (access.readOnly === true) return true;
  if (Array.isArray(access.readPaths) && access.readPaths.length > 0) return true;
  // At full the profile's asks and the outward question do not apply.
  if (full) return false;
  // A background run asks about an outward write even when no rule names it.
  if (access.background === true) return true;
  // The levels below full ask about a write or a command not known to only read.
  if (typeof access.level === "string") return true;
  // MCP tools not on the allowed list ask, so a profile that lists them (even none) can ask.
  if (Array.isArray(access.allowMcp)) return true;
  return [access.askCommands, access.askPaths].some((rules) => Array.isArray(rules) && rules.length > 0);
}

/**
 * The question for one call. The grace and `onTimeout` are the kernel's
 * defaults. `allowAlways` is false in a background run, which neither consults
 * the user layer nor offers to remember an exact call; `allowTarget` offers the
 * target grant of ADR 0025 D12 instead.
 */
export function askRequest(call: AskCall, allowAlways = false, allowTarget = false): AskRequest {
  const prompt =
    call.kind === "command" ? `Run this command? ${call.shown}` : `Let ${call.tool ?? "the tool"} use this path? ${call.shown}`;
  const choices = allowAlways ? [ALLOW_ONCE, ALLOW_ALWAYS, REJECT_ONCE] : [ALLOW_ONCE, REJECT_ONCE];
  // Without a session there is nothing to continue after a late answer, so
  // the question gets one answer within the grace and a refusal after it.
  if (call.outward !== undefined) {
    const question = outwardQuestion(call.outward, allowTarget ? { allowTarget: true } : {});
    if (call.session === null) return { ...question, onTimeout: "reject_once" };
    return {
      ...question,
      resume: {
        session: call.session,
        grant: {
          kind: call.kind,
          value: call.value,
          choice: OUTWARD_SEND_ONCE,
          ...(allowTarget ? { choices: [OUTWARD_SEND_ONCE, OUTWARD_ALLOW_TARGET] } : {}),
          ...(call.tool === undefined ? {} : { tool: call.tool }),
        },
      },
    };
  }
  if (call.session === null) return { prompt, choices, onTimeout: "reject_once" };
  return {
    prompt,
    choices,
    resume: {
      session: call.session,
      grant: {
        kind: call.kind,
        value: call.value,
        // One late answer is the one-time permission; allow_always also writes
        // the user layer first. The kernel accepts either approving choice.
        choice: ALLOW_ONCE,
        ...(allowAlways ? { choices: [ALLOW_ONCE, ALLOW_ALWAYS] } : {}),
        ...(call.tool === undefined ? {} : { tool: call.tool }),
      },
    },
  };
}

/**
 * A late `allow_target` carries the answer but not the write it was about.
 * The resumed step's one-time grant carries the exact call; this turns it back
 * into the outward target and records the grant with the person who answered.
 * A call with more than one outward target is not guessed at.
 */
export async function recordTargetGrantFromAnswer(
  home: string,
  flow: FlowDefinition,
  access: unknown,
  askAnswer: unknown,
  now: () => number = Date.now,
): Promise<void> {
  if (!isRecord(askAnswer) || askAnswer["choice"] !== OUTWARD_ALLOW_TARGET) return;
  const by = actorOf(askAnswer["actor"]);
  if (by === undefined) return;
  if (!isRecord(access) || !Array.isArray(access["grants"])) return;
  const grant = access["grants"].find(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && entry["kind"] === "command" && typeof entry["value"] === "string",
  );
  if (grant === undefined) return;
  const value = grant["value"];
  if (typeof value !== "string" || value.length === 0) return;
  const writes = value.startsWith("mcp ")
    ? [{ kind: "service" as const, target: value, content: `the MCP tool "${value.slice(4)}"` }]
    : outwardCommandWrites(access, value);
  const unique = new Map(writes.map((write) => [write.target, write]));
  if (unique.size !== 1) return;
  const [write] = unique.values();
  if (write === undefined) return;
  await appendTargetGrant(home, flow, write, by, now());
}

function actorOf(value: unknown): { readonly via: string; readonly id: string } | undefined {
  if (!isRecord(value)) return undefined;
  const via = value["via"];
  const id = value["id"];
  if (typeof via !== "string" || via.length === 0 || typeof id !== "string" || id.length === 0) return undefined;
  return { via, id };
}

/**
 * The question of a harness that cannot enforce a one-time permission
 * (`radian`; ADR 0008 D1 to D5): no grant, and a refusal
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
  /** The outward write the question is about, in a background run. */
  readonly outward?: OutwardWrite | undefined;
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
  /** `ctx.ask` for a form the agent asked; absent when the host cannot ask one. */
  readonly askForm?: ((form: AskForm) => Promise<FormAnswer>) | undefined;
  /** Called once when the wait ends: the program must be ended. */
  readonly onStop: () => void;
  /** Secret values of the store: a call that holds one is refused and never asked, so no fact holds a secret. */
  readonly secrets?: readonly string[] | undefined;
  /**
   * Where `allow_always` writes the user layer, and the working directory of
   * the call. Absent in a background run, which does not offer the choice.
   */
  readonly alwaysAllow?: { readonly home: string; readonly cwd: string } | undefined;
  /** The operad home and flow whose target grants this run may use. */
  readonly targetGrants?: { readonly home: string; readonly flow: FlowDefinition; readonly now?: (() => number) | undefined } | undefined;
  /** Reports a write that could not be made; the call still runs once, as allow_once does. */
  readonly onLog?: ((message: string) => void) | undefined;
}

function holdsSecret(call: AskCall, secrets: readonly string[]): boolean {
  return secrets.some((secret) => secret.length > 0 && (call.value.includes(secret) || call.shown.includes(secret)));
}

/** Whether an entry written in this step covers the call the program asks about again. */
function remembered(
  entries: readonly AlwaysAllowEntry[],
  call: AskCall,
  cwd: string,
): boolean {
  return entries.some(
    (entry) =>
      entry.cwd === cwd &&
      entry.kind === call.kind &&
      entry.value === call.value &&
      (call.kind === "command" || entry.tool === call.tool),
  );
}

export function createCallAsker(options: CallAskerOptions): CallAsker {
  let chain: Promise<void> = Promise.resolve();
  let stop: { readonly error: unknown } | undefined;
  /** The entries this step itself wrote: an identical later call does not ask again. */
  const written: AlwaysAllowEntry[] = [];

  const answer = (reply: (text: string) => void, id: number, decision: AskDecision, reason?: string): void => {
    reply(JSON.stringify({ type: "ask_ack", id, decision, ...(reason === undefined ? {} : { reason }) }));
  };

  const answerForm = (reply: (text: string) => void, id: number, form: FormAnswer): void => {
    reply(
      JSON.stringify({
        type: "ask_form_ack",
        id,
        decision: form.decision,
        ...(form.answers === undefined ? {} : { answers: form.answers }),
        ...(form.note === undefined ? {} : { note: form.note }),
      }),
    );
  };

  /** One form the program asked: a person answers every question in one go. */
  const oneForm = async (form: AskForm, reply: (text: string) => void): Promise<void> => {
    if (stop !== undefined) {
      answerForm(reply, form.id, { decision: "stop" });
      return;
    }
    if (options.askForm === undefined) {
      answerForm(reply, form.id, { decision: "rejected" });
      return;
    }
    try {
      const got = await options.askForm(form);
      if (got.decision === "stop") {
        answerForm(reply, form.id, { decision: "stop" });
        return;
      }
      if (got.decision === "rejected") {
        answerForm(reply, form.id, { decision: "rejected" });
        return;
      }
      answerForm(reply, form.id, {
        decision: "answered",
        answers: got.answers ?? [],
        ...(got.note === undefined ? {} : { note: got.note }),
      });
    } catch (error) {
      stop = { error };
      answerForm(reply, form.id, { decision: "stop" });
      options.onStop();
    }
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
    if (options.alwaysAllow !== undefined && remembered(written, call, options.alwaysAllow.cwd)) {
      answer(reply, call.id, "allow");
      return;
    }
    if (call.outward !== undefined && options.targetGrants !== undefined) {
      try {
        const grant = await targetGrantFor(options.targetGrants.home, options.targetGrants.flow, call.outward.target);
        if (grant !== undefined) {
          answer(reply, call.id, "allow");
          return;
        }
      } catch (error) {
        options.onLog?.(
          `the target grants could not be read: ${messageOf(error)}; this call asks`,
        );
      }
    }
    try {
      const got = await options.ask(
        askRequest(call, options.alwaysAllow !== undefined, options.targetGrants !== undefined),
      );
      if (got.rejected === true) answer(reply, call.id, "deny", "nobody answered in time");
      else if (got.choice === ALLOW_ONCE || got.choice === ALLOW_ALWAYS) {
        if (got.choice === ALLOW_ALWAYS && options.alwaysAllow !== undefined) {
          const entry = alwaysAllowEntry(call, options.alwaysAllow.cwd);
          try {
            await appendAlwaysAllow(options.alwaysAllow.home, entry);
            written.push(entry);
          } catch (error) {
            options.onLog?.(
              `allow_always could not be written to the user access file: ${
                messageOf(error)
              }; this call runs once`,
            );
          }
        }
        answer(reply, call.id, "allow");
      } else if (got.choice === OUTWARD_ALLOW_TARGET && options.targetGrants !== undefined && call.outward !== undefined) {
        try {
          await appendTargetGrant(
            options.targetGrants.home,
            options.targetGrants.flow,
            call.outward,
            got.actor ?? { via: "unknown", id: "unknown" },
            (options.targetGrants.now ?? Date.now)(),
          );
        } catch (error) {
          options.onLog?.(
            `the target grant could not be written: ${messageOf(error)}; this call runs once`,
          );
        }
        answer(reply, call.id, "allow");
      } else {
        // A refusal may say why; a harness whose question had no note gets the generic reason.
        const note = typeof got.note === "string" && got.note.trim().length > 0 ? got.note.trim() : undefined;
        answer(reply, call.id, "deny", note ?? "a person refused it");
      }
    } catch (error) {
      stop = { error };
      answer(reply, call.id, "stop");
      options.onStop();
    }
  };

  return {
    handle(line, reply) {
      const call = askCall(line);
      if (call !== undefined) {
        chain = chain.then(() => one(call, reply));
        return chain;
      }
      const form = askFormLine(line);
      if (form === undefined) return Promise.resolve();
      chain = chain.then(() => oneForm(form, reply));
      return chain;
    },
    stopped: () => stop,
  };
}
