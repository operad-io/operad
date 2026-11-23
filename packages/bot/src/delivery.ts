/**
 * How a routine's result reaches the bot's main chat (ADR 0030 D10, ADR 0026
 * D19). A result with content is one message in the main chat, headed with the
 * routine's name; a bound Telegram chat is sent it like any message of the
 * chat. It starts no reply: its summary, not its whole text, rides on the
 * chat's next message, and the whole run stays readable on demand.
 */

import { deliverResult, mainChatOf } from "@operad-io/chat";
import type { FactWriter, ObjectStore } from "@operad-io/engine";
import { BOT_TYPE } from "./bot.ts";
import { ROUTINE_TYPE } from "./schedule.ts";

/** What a routine run hands over. */
export interface RoutineResult {
  readonly bot: string;
  /** The routine's bare object id, when it has one. */
  readonly routineId?: string | undefined;
  readonly title: string;
  readonly runId: string;
  readonly summary: string;
  readonly text: string;
  readonly failed: boolean;
}

/**
 * Delivers one result to the bot's main chat. False when the bot has no open
 * chat, so there is nowhere to put it; true when the message is there, also
 * when an earlier call already put it.
 */
export async function deliverToMainChat(
  ctx: { readonly store: ObjectStore; readonly facts: FactWriter },
  bot: string,
  result: Omit<RoutineResult, "bot">,
): Promise<boolean> {
  const chat = await mainChatOf(ctx.store, `${BOT_TYPE}:${bot}`);
  if (chat === undefined) return false;
  await deliverResult(ctx, chat, {
    routine: result.title,
    ...(result.routineId === undefined || result.routineId.length === 0 ? {} : { routineId: `${ROUTINE_TYPE}:${result.routineId}` }),
    runId: result.runId,
    summary: result.summary,
    text: result.text,
    ...(result.failed ? { failed: true } : {}),
    from: { via: "bot", id: result.title },
  });
  return true;
}
