/**
 * Turns the chat record into proposed cases. A person's correction of a bot's
 * reply is a miss: the message before the reply is the question, the messages
 * before that are the context. The facts of the right answer are the person's
 * to write, so a proposal is a pending item the person approves with them; it
 * writes a case file only on approval, and nothing is extracted on its own.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ActionTypeDefinition,
  JsonValue,
  ObjectRow,
  ObjectStore,
  ObjectViews,
  SectionContent,
  StandingItem,
  StoredObject,
} from "@operad-io/engine";
import { chatMessages, type IndexedChatMessage } from "../search/sources.ts";
import { CaseError, parseCase, type CaseMessage, type MemoryCase } from "./format.ts";

/** The object type of a proposed case. A person sees its pending item. */
export const CASE_PROPOSAL_TYPE = "memory-case-proposal";

/** The directory of the cases in the operad home. */
export const CASES_DIRECTORY = "memory-cases";

/** The most earlier messages a proposed case keeps as context. */
export const PROPOSED_CONTEXT_MAX = 30;

/** The most text of one kept message. */
const MESSAGE_MAX = 2000;

/** What the person's message must open with to count as a correction. */
const CORRECTION =
  /^\s*(?:no[,.!\s]|nope\b|wrong\b|that'?s (?:not|wrong|incorrect)\b|that is (?:not|wrong|incorrect)\b|incorrect\b|actually[,\s]|i (?:told|said) you\b|not (?:quite|right)\b|不对|不是|错了|搞错|其实|我说过|我之前说过|我告诉过你)/iu;

/** One correction found in a chat, with the exchange around it. */
export interface FoundMiss {
  readonly chat: string;
  /** The id of the correcting message. */
  readonly message: string;
  readonly question: string;
  readonly wrong: string;
  readonly correction: string;
  readonly context: readonly CaseMessage[];
}

function clipped(text: string): string {
  return text.length <= MESSAGE_MAX ? text : `${text.slice(0, MESSAGE_MAX)}…`;
}

/** Whether a person's message opens as a correction of what was said before it. */
export function isCorrection(text: string): boolean {
  return CORRECTION.test(text);
}

/** The corrections in one chat: a correcting message after an assistant reply that followed a question. */
export function findMisses(chat: string, messages: readonly IndexedChatMessage[]): readonly FoundMiss[] {
  const found: FoundMiss[] = [];
  for (let at = 2; at < messages.length; at += 1) {
    const correcting = messages[at];
    const reply = messages[at - 1];
    if (correcting?.role !== "user" || reply?.role !== "assistant" || !isCorrection(correcting.text)) continue;
    let asked = at - 2;
    while (asked >= 0 && messages[asked]?.role !== "user") asked -= 1;
    const question = messages[asked];
    if (question === undefined) continue;
    const context = messages
      .slice(Math.max(0, asked - PROPOSED_CONTEXT_MAX), asked)
      .map((message): CaseMessage => ({ role: message.role, text: clipped(message.text) }));
    found.push({
      chat,
      message: correcting.id,
      question: clipped(question.text),
      wrong: clipped(reply.text),
      correction: clipped(correcting.text),
      context,
    });
  }
  return found;
}

/** The id of a case or proposal made from one correction; the same correction gives the same id. */
export function proposalId(chat: string, message: string): string {
  return `c-${createHash("sha256").update(`${chat}\u0000${message}`).digest("hex").slice(0, 10)}`;
}

/** What a proposal stores. */
export interface CaseProposalData {
  readonly [key: string]: unknown;
  readonly state: "pending" | "approved" | "rejected";
  readonly chat: string;
  readonly createdAt: number;
  readonly question: string;
  readonly wrong: string;
  readonly correction: string;
  readonly context: readonly CaseMessage[];
}

function dataOf(object: StoredObject): CaseProposalData | undefined {
  const data = object.data;
  if (
    (data["state"] !== "pending" && data["state"] !== "approved" && data["state"] !== "rejected") ||
    typeof data["chat"] !== "string" ||
    typeof data["createdAt"] !== "number" ||
    typeof data["question"] !== "string" ||
    typeof data["wrong"] !== "string" ||
    typeof data["correction"] !== "string" ||
    !Array.isArray(data["context"])
  ) {
    return undefined;
  }
  return data as CaseProposalData;
}

async function everyChat(store: ObjectStore): Promise<readonly StoredObject[]> {
  const found: StoredObject[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list("chat", { ...(cursor === undefined ? {} : { cursor }), limit: 200 });
    found.push(...page.objects);
    cursor = page.next;
  } while (cursor !== undefined);
  return found;
}

/** Options of one extraction. */
export interface ProposeOptions {
  readonly home: string;
  /** Only this chat, when given. */
  readonly chat?: string | undefined;
  readonly now: () => number;
}

/**
 * Stores a pending proposal for every correction not yet proposed and not
 * already a case. A rejected proposal stays, so it is not proposed again.
 */
export async function proposeCases(store: ObjectStore, options: ProposeOptions): Promise<readonly string[]> {
  const chats = (await everyChat(store)).filter((chat) => options.chat === undefined || chat.id === options.chat);
  const made: string[] = [];
  for (const chat of chats) {
    for (const miss of findMisses(chat.id, chatMessages(store, chat.id))) {
      const id = proposalId(chat.id, miss.message);
      if ((await store.get(CASE_PROPOSAL_TYPE, id)) !== undefined) continue;
      if (existsSync(join(options.home, CASES_DIRECTORY, `${id}.json`))) continue;
      const data: CaseProposalData = {
        state: "pending",
        chat: chat.id,
        createdAt: options.now(),
        question: miss.question,
        wrong: miss.wrong,
        correction: miss.correction,
        context: miss.context,
      };
      await store.put(CASE_PROPOSAL_TYPE, id, data as unknown as Record<string, JsonValue>, "command:memory/propose");
      made.push(id);
    }
  }
  return made;
}

/** The case an approval writes: the person's facts, and what the bot got wrong when they say so. */
export function caseOfProposal(id: string, data: CaseProposalData, facts: string, avoid: string): MemoryCase {
  const lines = (text: string): string[] =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  return parseCase(
    {
      id,
      kind: "correction",
      context: data.context,
      question: data.question,
      answer: { facts: lines(facts), avoid: lines(avoid) },
    },
    `${id}.json`,
  );
}

/** Approves a proposal: writes the case file with the facts the person gave. */
export async function approveCaseProposal(
  store: ObjectStore,
  home: string,
  id: string,
  facts: string,
  avoid: string,
): Promise<string> {
  const object = await store.get(CASE_PROPOSAL_TYPE, id);
  const data = object === undefined ? undefined : dataOf(object);
  if (data === undefined) throw new CaseError(`there is no proposed case "${id}"`);
  if (data.state !== "pending") return `proposed case ${id} is already ${data.state}; nothing to approve`;
  const made = caseOfProposal(id, data, facts, avoid);
  const directory = join(home, CASES_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${id}.json`), `${JSON.stringify(made, null, 2)}\n`);
  await store.put(
    CASE_PROPOSAL_TYPE,
    id,
    { ...data, state: "approved" } as unknown as Record<string, JsonValue>,
    "action:memory/approve",
  );
  return `added case ${id} to the memory regression set`;
}

/** Rejects a proposal; no case is written. */
export async function rejectCaseProposal(store: ObjectStore, id: string): Promise<string> {
  const object = await store.get(CASE_PROPOSAL_TYPE, id);
  const data = object === undefined ? undefined : dataOf(object);
  if (data === undefined) throw new CaseError(`there is no proposed case "${id}"`);
  if (data.state !== "pending") return `proposed case ${id} is already ${data.state}; nothing to reject`;
  await store.put(
    CASE_PROPOSAL_TYPE,
    id,
    { ...data, state: "rejected" } as unknown as Record<string, JsonValue>,
    "action:memory/reject",
  );
  return `rejected proposed case ${id}`;
}

/** The actions on a proposed case. */
export const caseProposalActions: readonly ActionTypeDefinition[] = [
  {
    name: "approve",
    on: CASE_PROPOSAL_TYPE,
    when: (state) => state.state === "pending",
    args: {
      type: "object",
      properties: {
        facts: {
          type: "string",
          role: "note",
          minLength: 1,
          description: "What a right answer states, one short phrase per line.",
        },
        avoid: {
          type: "string",
          role: "note",
          description: "Phrases of the wrong answer, one per line; an answer that states one fails. May be empty.",
        },
      },
      required: ["facts"],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const input = args as { readonly facts: string; readonly avoid?: string | undefined };
      return approveCaseProposal(ctx.store, ctx.home, ctx.object.id, input.facts, input.avoid ?? "");
    },
  },
  {
    name: "reject",
    on: CASE_PROPOSAL_TYPE,
    when: (state) => state.state === "pending",
    async run(ctx) {
      return rejectCaseProposal(ctx.store, ctx.object.id);
    },
  },
];

function reviewText(data: CaseProposalData): string {
  const quote = (text: string): string => text.split("\n").map((line) => `> ${line}`).join("\n");
  return [
    `The person corrected the bot in chat ${data.chat}.`,
    "",
    "Question:",
    quote(data.question),
    "",
    "The bot's reply:",
    quote(data.wrong),
    "",
    "The correction:",
    quote(data.correction),
    "",
    "Approve with the facts a right answer states, one short phrase per line.",
  ].join("\n");
}

/** The pending items the proposed cases make. */
export async function caseProposalItems(store: ObjectStore): Promise<readonly StandingItem[]> {
  const items: StandingItem[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list(CASE_PROPOSAL_TYPE, { ...(cursor === undefined ? {} : { cursor }) });
    for (const object of page.objects) {
      const data = dataOf(object);
      if (data?.state !== "pending") continue;
      items.push({
        id: object.id,
        prompt: `A correction in chat ${data.chat} is proposed as a memory test case`,
        object: { type: CASE_PROPOSAL_TYPE, id: object.id },
      });
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return items;
}

function row(object: StoredObject): ObjectRow {
  const data = dataOf(object);
  if (data === undefined) return { id: object.id, title: "Proposed memory test case", state: "broken" };
  return {
    id: object.id,
    title: `Proposed memory test case from chat ${data.chat}`,
    state: data.state,
    ...(data.state === "pending" ? { mark: "proposed" as const } : {}),
  };
}

/** How a proposed case shows in a list and on its page. */
export const caseProposalViews: ObjectViews = {
  row,
  sections: () => [{ id: "review", title: "Review" }],
  load: (_ctx, object): SectionContent => {
    const data = dataOf(object);
    return { markdown: data === undefined ? "This proposal has no usable state." : reviewText(data) };
  },
};
