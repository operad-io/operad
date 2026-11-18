/**
 * Outward writes: what leaves operad (a message, mail or post, a push, or a
 * call to an outside service), the target a person is shown, and the guard a
 * background run uses before the write. The lists and target shapes are in
 * `REFERENCE.md` and ADR 0025.
 */

import type { Actor, AskAnswer, AskRequest, FlowDefinition, OutwardTargets, OutwardWrite, OutwardWrites } from "@operad-io/engine";
import { baseName, levels, scan, findDenied, parseRule, type Part } from "./command.ts";
import { appendTargetGrant, targetGrantFor, type TargetGrant } from "./target-grants.ts";

/** The choice that lets one outward write through. */
export const OUTWARD_SEND_ONCE = "send_once";

/** The choice that refuses one outward write. */
export const OUTWARD_REJECT_ONCE = "reject_once";

/** The choice that allows this target for this flow definition from now on. */
export const OUTWARD_ALLOW_TARGET = "allow_target";

/** What a background run asks before an outward write. */
export interface OutwardQuestionOptions {
  /** How long the step waits for an answer; the kernel's own default when absent. */
  readonly graceSecs?: number | undefined;
  /** What happens when the grace passes; a step that cannot wait asks with `reject_once`. */
  readonly onTimeout?: "waiting" | "reject_once" | undefined;
  /** Offer the choice that records a grant for this flow and target. */
  readonly allowTarget?: boolean | undefined;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The words that name what is about to leave. */
const ACTION: Readonly<Record<OutwardWrite["kind"], string>> = {
  channel: "Send this message to",
  mail: "Send this mail to",
  post: "Send this post to",
  repository: "Push to",
  service: "Call",
  command: "Run this outward command on",
};

/**
 * The question about one outward write. It names the target and carries the
 * whole content, so the pending item is also the draft (ADR 0025 D10).
 */
export function outwardQuestion(write: OutwardWrite, options: OutwardQuestionOptions = {}): AskRequest {
  const target = oneLine(write.target);
  const head = `${ACTION[write.kind]} ${target}?`;
  const content = write.content?.trim();
  const prompt = content === undefined || content.length === 0 ? head : `${head}\n\n${content}`;
  const choices = options.allowTarget === true
    ? [OUTWARD_SEND_ONCE, OUTWARD_ALLOW_TARGET, OUTWARD_REJECT_ONCE]
    : [OUTWARD_SEND_ONCE, OUTWARD_REJECT_ONCE];
  return {
    prompt,
    choices,
    choiceInfo: {
      [OUTWARD_SEND_ONCE]: { label: "Send once", hint: "Make this write once.", role: "primary" },
      ...(options.allowTarget === true
        ? { [OUTWARD_ALLOW_TARGET]: { label: "Always for this flow and target", hint: "Do not ask again for this target unless the flow changes." } }
        : {}),
      [OUTWARD_REJECT_ONCE]: { label: "Reject", hint: "Do not make this write." },
    },
    ...(options.graceSecs === undefined ? {} : { graceSecs: options.graceSecs }),
    ...(options.onTimeout === undefined ? {} : { onTimeout: options.onTimeout }),
  };
}

/** Whether a target is on the profile's outward allowlist, or is an owner channel. */
export function outwardAllowed(profile: unknown, write: OutwardWrite): boolean {
  if (write.owner === true) return true;
  const record = typeof profile === "object" && profile !== null && !Array.isArray(profile) ? profile : {};
  const allow = Reflect.get(record, "outwardAllow");
  if (!Array.isArray(allow)) return false;
  const target = write.target.trim();
  return allow.some((entry) => typeof entry === "string" && entry.trim() === target);
}

/** What `guardOutward` needs of the step that makes the write. */
export interface OutwardGuardContext {
  readonly access: unknown;
  /** `ctx.ask` of the step. */
  readonly ask: (request: AskRequest) => Promise<AskAnswer>;
  /** Whether a person's message in this chat started the run. */
  readonly personStarted: boolean;
  /** What happens when the grace passes; absent keeps the kernel's `waiting`. */
  readonly onTimeout?: "waiting" | "reject_once" | undefined;
  /** The operad home where target grants are kept. */
  readonly home?: string | undefined;
  /** The flow whose definition a target grant is bound to. */
  readonly flow?: FlowDefinition | undefined;
  /** The clock of the answer's time; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
  /** Reports a grant that could not be written; the write still goes once. */
  readonly onLog?: ((message: string) => void) | undefined;
}

/**
 * Whether one outward write may go ahead: a person-started run, a target
 * on the allowlist, and a target grant for this flow definition do not ask;
 * every other background write asks, and only `send_once` or
 * `allow_target` lets it through. The chat's exact-call `allow_always` is not
 * consulted (ADR 0025 D3, D10 and D12).
 */
export async function guardOutward(
  ctx: OutwardGuardContext,
  write: OutwardWrite,
): Promise<boolean> {
  if (ctx.personStarted || outwardAllowed(ctx.access, write)) return true;
  let grant: TargetGrant | undefined;
  if (ctx.home !== undefined && ctx.flow !== undefined) {
    try {
      grant = await targetGrantFor(ctx.home, ctx.flow, write.target);
    } catch (error) {
      ctx.onLog?.(
        `the target grants could not be read: ${error instanceof Error ? error.message : String(error)}; this write asks`,
      );
    }
  }
  if (grant !== undefined) return true;
  const allowTarget = ctx.home !== undefined && ctx.flow !== undefined;
  const answer = await ctx.ask(
    outwardQuestion(write, {
      ...(ctx.onTimeout === undefined ? {} : { onTimeout: ctx.onTimeout }),
      ...(allowTarget ? { allowTarget: true } : {}),
    }),
  );
  if (answer.rejected === true) return false;
  if (answer.choice === OUTWARD_ALLOW_TARGET && ctx.home !== undefined && ctx.flow !== undefined) {
    const by: Actor = answer.actor ?? { via: "unknown", id: "unknown" };
    try {
      await appendTargetGrant(ctx.home, ctx.flow, write, by, (ctx.now ?? Date.now)());
    } catch (error) {
      ctx.onLog?.(
        `the target grant could not be written: ${error instanceof Error ? error.message : String(error)}; this write runs once`,
      );
    }
    return true;
  }
  return answer.choice === OUTWARD_SEND_ONCE;
}


/** The chat clients whose message is a person's message in that chat. */
const PERSON_MESSAGE_SOURCES = new Set(["ios", "telegram", "cli", "tui", "other"]);

/**
 * Whether a run was started by a person writing in its chat. A missing
 * trigger is a run a person started by hand; a message from one of the chat's
 * own clients is a person's message; every other event is a background run.
 */
export function personStarted(trigger: unknown): boolean {
  if (trigger === undefined || trigger === null) return true;
  if (typeof trigger !== "object" || Array.isArray(trigger)) return false;
  const record = trigger as Record<string, unknown>;
  return (
    record["type"] === "message" &&
    typeof record["source"] === "string" &&
    PERSON_MESSAGE_SOURCES.has(record["source"])
  );
}

function writesOf(value: OutwardWrites): readonly OutwardWrite[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value as OutwardWrite];
}

/**
 * The outward writes a step or action declares for one call. A declaration
 * that says it reaches outside but names no target counts the whole call as
 * one outward write: nothing can be allowlisted, so it asks.
 */
export function declaredOutward(
  declaration: { readonly reachesOutside?: boolean | undefined; readonly outward?: OutwardTargets | undefined },
  input: unknown,
): readonly OutwardWrite[] {
  if (declaration.outward !== undefined) return writesOf(declaration.outward(input));
  if (declaration.reachesOutside !== true) return [];
  const content = typeof input === "string" ? input : JSON.stringify(input) ?? String(input);
  return [{ kind: "command", target: content, content }];
}

/** The outward writes of one shell command that matches the profile's `outwardCommands`. */
export function outwardCommandWrites(profile: unknown, command: string): readonly OutwardWrite[] {
  const record = typeof profile === "object" && profile !== null && !Array.isArray(profile) ? profile : {};
  const rules = Array.isArray(Reflect.get(record, "outwardCommands"))
    ? (Reflect.get(record, "outwardCommands") as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : [];
  if (rules.length === 0) return [];
  const parsed = rules.map((text) => parseRule(text)).filter((rule) => rule !== undefined);
  const { parts } = scan(command);
  const writes: OutwardWrite[] = [];
  for (const part of parts) {
    if (findDenied(parsed, [part]) === undefined) continue;
    const write = commandWrite(part);
    if (write === undefined) continue;
    if (writes.some((found) => found.target === write.target && found.content === write.content)) continue;
    writes.push(write);
  }
  return writes;
}

function wordsOf(part: Part): readonly string[] {
  return levels(part.words).at(-1) ?? part.words;
}

function nonOptions(args: readonly string[]): readonly string[] {
  const found: string[] = [];
  let options = true;
  for (const arg of args) {
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (options && arg.startsWith("-")) continue;
    found.push(arg);
  }
  return found;
}

function branchOf(ref: string): string {
  const colon = ref.indexOf(":");
  const name = colon === -1 ? ref : ref.slice(colon + 1);
  return name.replace(/^refs\/heads\//, "");
}

function remoteAndBranch(args: readonly string[]): { readonly remote: string | undefined; readonly branch: string | undefined } {
  const operands = nonOptions(args);
  return { remote: operands[0], branch: operands[1] === undefined ? undefined : branchOf(operands[1]) };
}

function curlIsWrite(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-F", "--form", "-T", "--upload-file"].includes(arg)) {
      return true;
    }
    if (/^-(?:d|F|T)\S/.test(arg) || /^--(?:data|form|upload-file)(?:=|$)/.test(arg)) return true;
    if (arg === "-X" || arg === "--request") {
      const method = (args[index + 1] ?? "").toUpperCase();
      if (method !== "" && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") return true;
      index += 1;
      continue;
    }
    const inline = /^--request=(.*)$/.exec(arg) ?? /^-X(.*)$/.exec(arg);
    if (inline !== null) {
      const method = (inline[1] ?? "").toUpperCase();
      if (method !== "" && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") return true;
    }
  }
  return false;
}

function urlOf(args: readonly string[]): string | undefined {
  return args.find((arg) => /^https?:\/\//i.test(arg));
}

function commandWrite(part: Part): OutwardWrite | undefined {
  const words = wordsOf(part);
  const program = baseName(words.at(0) ?? "");
  const args = words.slice(1);

  if (program === "git" && args[0] === "push") {
    const { remote, branch } = remoteAndBranch(args.slice(1));
    const target = remote === undefined ? part.text : branch === undefined ? remote : `${remote}/${branch}`;
    return { kind: "repository", target, content: part.text };
  }
  if (program === "gh") {
    const target = part.text;
    return { kind: "service", target, content: part.text };
  }
  if (program === "curl") {
    if (!curlIsWrite(args)) return undefined;
    const target = urlOf(args) ?? part.text;
    return { kind: "service", target, content: part.text };
  }
  if (program === "wget") {
    if (!args.some((arg) => /^--(?:post-data|post-file|method|body-data|body-file)/.test(arg))) return undefined;
    const target = urlOf(args) ?? part.text;
    return { kind: "service", target, content: part.text };
  }
  if (program === "mail" || program === "mailx" || program === "sendmail") {
    const recipients = nonOptions(args).filter((arg) => !arg.startsWith("<"));
    const target = recipients.length === 0 ? part.text : recipients.join(", ");
    return { kind: "mail", target, content: part.text };
  }
  return { kind: "command", target: part.text, content: part.text };
}

/** The outward writes of one call to a step or action, for a plugin that guards itself. */
export async function guardDeclaredOutward(
  ctx: OutwardGuardContext,
  declaration: { readonly reachesOutside?: boolean | undefined; readonly outward?: OutwardTargets | undefined },
  input: unknown,
): Promise<boolean> {
  for (const write of declaredOutward(declaration, input)) {
    if (!(await guardOutward(ctx, write))) return false;
  }
  return true;
}
