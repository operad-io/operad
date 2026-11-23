/**
 * Cleanup of chats nobody writes in (docs/backlog/operad-long-chat.md, ADR 0026,
 * ADR 0030): a bot's chat bound to no channel closes by itself after 7 days with
 * no message; a chat bound to a channel never does, because the channel's next
 * message would only open a new one. Repository chats are not swept: they hold a
 * worktree and may be tied to a task, which this plugin cannot see.
 */

import { CHAT_TYPE, chatData, chatFacts } from "@operad-io/chat";
import type { ClientApi, ObjectStore } from "@operad-io/engine";
import { BOT_TYPE } from "./bot.ts";
import { SCHEDULE_SOURCE } from "./schedule.ts";

/** How many days a chat bound to no channel may go without a message. */
export const CHAT_IDLE_DAYS = 7;

const DAY_MS = 24 * 60 * 60_000;

/** Closes the bot chats that are open, bound to no channel and idle; returns how many. */
export async function closeIdleChats(store: ObjectStore, client: ClientApi, now: number): Promise<number> {
  let closed = 0;
  let cursor: string | undefined;
  do {
    const page = await store.list(CHAT_TYPE, { ...(cursor === undefined ? {} : { cursor }) });
    for (const object of page.objects) {
      const chat = chatData(object.data);
      if (chat.closed || chat.run === true || chat.channels.length > 0) continue;
      if (chat.parent === undefined || !chat.parent.startsWith(`${BOT_TYPE}:`)) continue;
      const last = chatFacts(store, object.id).at(-1)?.at ?? object.at;
      if (now - last < CHAT_IDLE_DAYS * DAY_MS) continue;
      await client.act("chat:close", `${CHAT_TYPE}:${object.id}`, {
        actor: { via: SCHEDULE_SOURCE, id: "idle" },
        yes: true,
      });
      closed += 1;
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return closed;
}
