/**
 * The chat half of the main clone's exclusion between a task and a repository
 * chat (ADR 0028 D3, ADR 0039 D3): a task does not start while a chat reply
 * that can write in the clone is being written.
 */

import type { ObjectStore, RunControl } from "@operad-io/engine";
import { CHAT_TYPE, chatData, readChat, writingReplyNow } from "@operad-io/chat";
import { listAll } from "./model.ts";

/**
 * The id of a chat about this repository whose reply is being written now and
 * can write in the main clone: its access level is `edits` or `full` and it has
 * no worktree of its own. Undefined when there is none.
 */
export async function writingChat(
  store: ObjectStore,
  repositoryName: string,
  runs: Pick<RunControl, "active"> | undefined,
): Promise<string | undefined> {
  for (const object of await listAll(store, CHAT_TYPE)) {
    const chat = chatData(object.data);
    if (chat.parent !== `repo:${repositoryName}` || chat.closed) continue;
    if (typeof object.data.worktree === "object" && object.data.worktree !== null) continue;
    if (chat.accessLevel !== "edits" && chat.accessLevel !== "full") continue;
    const read = readChat(store, object.id);
    if ((await writingReplyNow(read.facts, read.messages, read.entries, runs)) !== undefined) {
      return object.id;
    }
  }
  return undefined;
}
