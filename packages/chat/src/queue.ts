/**
 * The queue of a chat's messages: the lock that makes taking one and changing
 * one a single choice, and the copy of the queue a chat's row carries.
 */

import { join } from "node:path";
import { safeFileName, type FactWriter, type MaybePromise, type ObjectStore } from "@operad-io/engine";
import { withLockFile } from "@operad-io/engine/platform";
import {
  allMessages,
  CHAT_TYPE,
  chatFacts,
  chatRef,
  queuedData,
  queuedMessages,
  queuedOf,
  TAKEN_FACT,
  takenIds,
} from "./model.ts";

/** Where a chat's queue lock lives. */
export function queueLockPath(home: string, chat: string): string {
  return join(home, "chat", safeFileName(chat), "queue.lock");
}

/** Runs work while holding a chat's queue lock; a take and a change take turns. */
export async function withQueueLock<T>(
  home: string,
  chat: string,
  work: () => MaybePromise<T>,
): Promise<T> {
  return withLockFile(queueLockPath(home, chat), work, { label: "chat queue" });
}

/** Writes what is queued into the chat object, so its row can show it. */
export async function syncQueuedLocked(
  store: ObjectStore,
  chat: string,
  cause: string,
): Promise<void> {
  const facts = chatFacts(store, chat);
  const queued = queuedData(queuedMessages(allMessages(store, chat), facts));
  const stored = await store.get(CHAT_TYPE, chat);
  if (stored === undefined) return;
  const before = queuedOf(stored.data.queued);
  if (JSON.stringify(before) === JSON.stringify(queued)) return;
  const next: Record<string, unknown> = { ...stored.data };
  if (queued.length === 0) delete next.queued;
  else next.queued = queued;
  await store.put(CHAT_TYPE, chat, next, cause);
}

/** Reads the queue again and writes it to the chat object, under the queue lock. */
export async function syncQueued(
  store: ObjectStore,
  home: string,
  chat: string,
  cause: string,
): Promise<void> {
  await withQueueLock(home, chat, () => syncQueuedLocked(store, chat, cause));
}

/** Records that a run took these messages, unless another run already did. */
export async function takeLocked(
  store: ObjectStore,
  facts: FactWriter,
  chat: string,
  runId: string,
  ids: readonly string[],
  cause: string,
): Promise<void> {
  const seen = takenIds(chatFacts(store, chat));
  const fresh = ids.filter((id) => !seen.has(id));
  if (fresh.length > 0) {
    await facts.append({
      type: TAKEN_FACT,
      object: chatRef(chat),
      data: { runId, ids: fresh },
      cause,
    });
  }
  await syncQueuedLocked(store, chat, cause);
}

/** A test waits here before a message is taken, to start an action against it. */
export const queueTestHooks: {
  beforeTake?: ((id: string) => MaybePromise<void>) | undefined;
} = {};
