/**
 * The segments of a long chat: each stretch that `/new` or a compaction starts.
 * A segment is named by the sequence of the fact that began it, so a title
 * recorded for it keeps meaning the same stretch as the chat grows.
 */

import type { PluginFact } from "@operad-io/engine";
import { COMMAND_FACT, MESSAGE_FACT, NEW_FACT, type Message } from "./model.ts";

/** A title made for a segment after its first exchange. */
export const SEGMENT_TITLE_FACT = "chat.segment_title";

/** The longest a segment's title is, in characters. */
export const SEGMENT_TITLE_MAX = 80;

/** How a segment began: the chat's start, a `/new`, or a compaction. */
export type SegmentKind = "first" | "new" | "compact";

/** One segment of a chat. */
export interface Segment {
  /** Counting from 1, in order. */
  readonly number: number;
  /** The sequence of the fact that began it; 0 for the first. */
  readonly sequence: number;
  /** When it began, in milliseconds since the epoch. */
  readonly at: number;
  readonly kind: SegmentKind;
  /** The goal of `/new`, the generated title, or the chat's own title for the first. Empty when none exists yet. */
  readonly title: string;
}

/** One line, cut to what a marker and a list show. */
export function titleLine(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= SEGMENT_TITLE_MAX ? flat : `${flat.slice(0, SEGMENT_TITLE_MAX - 1)}…`;
}

/** Whether a command line says the context was compacted: `/compact` and the automatic one, when they worked. */
function compactedLine(fact: PluginFact): boolean {
  return (
    fact.type === COMMAND_FACT &&
    fact.data.ok === true &&
    (fact.data.command === "compact" || fact.data.command === "compact (automatic)")
  );
}

interface Boundary {
  readonly sequence: number;
  readonly at: number;
  readonly kind: "new" | "compact";
  readonly goal: string;
}

/**
 * The segments in order. A stretch with no message in it is not one, so a
 * `/new` typed twice, or a compaction nothing followed, adds none and the
 * numbers stay what a client saw.
 */
export function segmentsOf(facts: readonly PluginFact[], chatTitle: string): readonly Segment[] {
  const boundaries: Boundary[] = [];
  const titles = new Map<number, string>();
  const withMessage = new Set<number>();
  let current = 0;
  const start = facts[0]?.at ?? 0;
  for (const fact of facts) {
    if (fact.type === NEW_FACT || compactedLine(fact)) {
      const goal = fact.type === NEW_FACT && typeof fact.data.goal === "string" ? titleLine(fact.data.goal) : "";
      boundaries.push({ sequence: fact.sequence, at: fact.at, kind: fact.type === NEW_FACT ? "new" : "compact", goal });
      current = fact.sequence;
      continue;
    }
    if (fact.type === MESSAGE_FACT) withMessage.add(current);
    else if (
      fact.type === SEGMENT_TITLE_FACT &&
      typeof fact.data.segment === "number" &&
      typeof fact.data.text === "string"
    ) {
      const text = titleLine(fact.data.text);
      if (text.length > 0) titles.set(fact.data.segment, text);
    }
  }
  const found: Segment[] = [];
  if (withMessage.has(0) || boundaries.length === 0) {
    found.push({ number: 1, sequence: 0, at: start, kind: "first", title: chatTitle });
  }
  for (const boundary of boundaries) {
    if (!withMessage.has(boundary.sequence)) continue;
    found.push({
      number: found.length + 1,
      sequence: boundary.sequence,
      at: boundary.at,
      kind: boundary.kind,
      title: boundary.goal.length > 0 ? boundary.goal : (titles.get(boundary.sequence) ?? ""),
    });
  }
  return found;
}

/** The first exchange of a segment that has no title yet. */
export interface TitleDue {
  readonly segment: number;
  readonly question: string;
  readonly answer: string;
}

/**
 * The segment that has had its first exchange and has no title: not the first
 * (it carries the chat's own title), not one `/new` gave a goal, and not one
 * already titled. Undefined when none is due.
 */
export function titleDue(facts: readonly PluginFact[], messages: readonly Message[], chatTitle: string): TitleDue | undefined {
  const segments = segmentsOf(facts, chatTitle);
  for (const segment of segments) {
    if (segment.kind === "first" || segment.title.length > 0) continue;
    const after = messages.filter((message) => message.sequence > segment.sequence);
    const next = segments[segment.number]?.sequence;
    const inside = next === undefined ? after : after.filter((message) => message.sequence < next);
    const question = inside.find((message) => message.role === "user");
    const answer = question === undefined ? undefined : inside.find((message) => message.role === "assistant" && message.sequence > question.sequence);
    if (question !== undefined && answer !== undefined) {
      return { segment: segment.sequence, question: question.text, answer: answer.text };
    }
  }
  return undefined;
}
