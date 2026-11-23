/**
 * A result a plugin delivers into a chat (ADR 0026 D19): one message in the
 * chat's record, headed with the routine's name, that starts no reply. It is
 * sent to a bound channel like any message of the assistant, and the next
 * message of the chat carries its summary to the model, the way a memory note
 * rides (D18); the whole result stays in the run's record.
 */

import type { FactWriter, ObjectStore } from "@operad-io/engine";
import { MESSAGE_FACT, allMessages, chatRef, type DeliveryData } from "./model.ts";

/** What a delivery is: the whole result, and what the model carries of it. */
export interface Delivery extends DeliveryData {
  /** The whole result, shown in the chat and sent to a bound channel. */
  readonly text: string;
  /** Who delivers it, as the message records it: the plugin and the routine. */
  readonly from: { readonly via: string; readonly id: string };
}

/** The message id a delivery of one run has, so a delivery repeated after a crash is recorded once. */
export function deliveryIdOf(runId: string): string {
  return `delivery-${runId}`;
}

/** Records a delivery in chat `chatId`; false when the chat already holds it. */
export async function deliverResult(
  ctx: { readonly facts: FactWriter; readonly store: ObjectStore },
  chatId: string,
  delivery: Delivery,
): Promise<boolean> {
  const id = deliveryIdOf(delivery.runId);
  if (allMessages(ctx.store, chatId).some((message) => message.id === id)) return false;
  await ctx.facts.append({
    type: MESSAGE_FACT,
    object: chatRef(chatId),
    data: {
      id,
      role: "delivery",
      from: delivery.from,
      text: delivery.text,
      attachments: [],
      source: { kind: delivery.from.via, ref: null },
      delivery: {
        routine: delivery.routine,
        ...(delivery.routineId === undefined || delivery.routineId.length === 0 ? {} : { routineId: delivery.routineId }),
        runId: delivery.runId,
        summary: delivery.summary,
        ...(delivery.failed === true ? { failed: true } : {}),
      },
    },
  });
  return true;
}
