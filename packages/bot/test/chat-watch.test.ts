import { afterAll, describe, expect, test } from "bun:test";
import { chatRef, RUN_FACT } from "@operad-io/chat";
import type { RunControl } from "@operad-io/engine";
import { ChatWatches } from "../src/chat-watch.ts";
import { cleanupRoots, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;

function watches(r: Rig, active: RunControl["active"]): ChatWatches {
  return new ChatWatches(
    { write: async () => "" },
    r.store,
    { active, cancel: () => false },
  );
}

async function crashed(r: Rig, chat: string): Promise<void> {
  await r.store.append({
    type: RUN_FACT,
    object: chatRef(chat),
    cause: "test",
    data: { runId: "run-crashed" },
  });
}

describe("a chat watch", () => {
  test("reads a chat once the host says its latest run has ended", async () => {
    const r = await rig();
    const chat = await r.open("default");
    await r.say(chat, "hello");
    await crashed(r, chat);
    const watched = watches(r, (runId) => (runId === "run-crashed" ? false : undefined));
    let read = 0;
    let done = 0;
    watched.watchChatReply(
      "key",
      chat,
      () => {
        read += 1;
        return "ready";
      },
      async () => {
        done += 1;
      },
    );
    await watched.settled();
    expect(read).toBe(1);
    expect(done).toBe(1);
  });

  test("waits while the host cannot tell, then reads once it says the run has ended", async () => {
    const r = await rig();
    const chat = await r.open("default");
    await r.say(chat, "hello");
    await crashed(r, chat);
    let active: boolean | undefined;
    const watched = watches(r, () => active);
    let read = 0;
    watched.watchChatReply(
      "key",
      chat,
      () => {
        read += 1;
        return "ready";
      },
      async () => undefined,
    );
    await watched.settled();
    expect(read).toBe(0);

    active = false;
    await r.say(chat, "more");
    await watched.settled();
    expect(read).toBe(1);
  });
});
