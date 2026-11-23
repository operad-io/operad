/**
 * The recap a person gets on coming back to a chat after being away: one short
 * message, built by code from what the chat's record holds, that says which
 * routine results arrived and which replies finished meanwhile. It is a
 * message of its own with the role `recap`; it is never put in the model's
 * context (the delivered results already ride on the next message, ADR 0026
 * D19), so it cannot disturb the cached history.
 */

import type { PluginFact } from "@operad-io/engine";
import { COMMAND_FACT, type Message } from "./model.ts";

/** How long without the person counts as away, in minutes, unless the setting says otherwise. */
export const AWAY_MINUTES_DEFAULT = 240;

/** The message id of the recap that came with the person's message `messageId`. */
export function recapIdOf(messageId: string): string {
  return `recap-${messageId}`;
}

function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

function listed(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(", ");
}

/**
 * The recap for the person's message `current`, or undefined when they were
 * not away (the person's last message or command before it is less than
 * `awayMs` older), when there is no earlier activity, or when nothing
 * happened meanwhile. `messages` holds the chat's messages with `current`;
 * `facts` its facts, for the person's commands. A zero or negative `awayMs`
 * turns recaps off.
 */
export function recapOf(
  messages: readonly Message[],
  facts: readonly PluginFact[],
  current: Message,
  awayMs: number,
): string | undefined {
  if (awayMs <= 0 || current.role !== "user") return undefined;
  let lastAt = -1;
  let lastSequence = -1;
  const activity: { readonly at: number; readonly sequence: number }[] = [
    ...messages.filter((message) => message.role === "user"),
    ...facts.filter((fact) => fact.type === COMMAND_FACT),
  ];
  for (const item of activity) {
    if (item.sequence < current.sequence && item.sequence > lastSequence) {
      lastAt = item.at;
      lastSequence = item.sequence;
    }
  }
  if (lastSequence < 0) return undefined;
  const gap = current.at - lastAt;
  if (gap < awayMs) return undefined;
  const meanwhile = messages.filter((message) => message.sequence > lastSequence && message.sequence < current.sequence);
  const results = meanwhile.flatMap((message) =>
    message.role === "delivery" && message.delivery !== undefined
      ? [`${message.delivery.routine}${message.delivery.failed === true ? " (failed)" : ""}`]
      : [],
  );
  const replies = meanwhile.filter((message) => message.role === "assistant").length;
  if (results.length === 0 && replies === 0) return undefined;
  const lines = [`While you were away (${span(gap)}):`];
  if (results.length > 0) lines.push(`- Routine results: ${listed(results)}`);
  if (replies > 0) lines.push(`- ${replies === 1 ? "1 reply" : `${replies} replies`} finished`);
  return lines.join("\n");
}
