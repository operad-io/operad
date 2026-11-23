import { afterAll, describe, expect, test } from "bun:test";
import { CHAT_TYPE } from "@operad-io/chat";
import { createViews, type ClientApi } from "@operad-io/engine";
import { CHAT_IDLE_DAYS, closeIdleChats, findRoutine, pruneRoutineRuns, ROUTINE_TYPE, scheduledPromptOf, ROUTINE_HISTORY_DAYS } from "../src/index.ts";
import { cleanupRoots, rig } from "./support.ts";

afterAll(cleanupRoots);

const DAY = 24 * 60 * 60_000;

describe("idle chats", () => {
  test("a chat bound to no channel closes after 7 idle days; a bound chat, a young chat and a closed one are left", async () => {
    const r = await rig();
    const views = createViews({ registry: r.registry, store: r.store, home: r.home, onLog: () => undefined });
    try {
      const plain = await r.open("default");
      const bound = await r.open("default", { channels: ["telegram:555"] });
      const start = Date.now();
      const client = views as unknown as ClientApi;
      expect(await closeIdleChats(r.store, client, start + (CHAT_IDLE_DAYS - 1) * DAY)).toBe(0);
      expect(await closeIdleChats(r.store, client, start + (CHAT_IDLE_DAYS + 1) * DAY)).toBe(1);
      expect((await r.store.get(CHAT_TYPE, plain))?.data.closed).toBe(true);
      expect((await r.store.get(CHAT_TYPE, bound))?.data.closed).not.toBe(true);
      // Once closed, it is not closed again.
      expect(await closeIdleChats(r.store, client, start + 30 * DAY)).toBe(0);
    } finally {
      views.close();
    }
  });
});

describe("routine history", () => {
  test("runs older than 30 days are removed; the last results on the routine stay", async () => {
    const r = await rig();
    await r.act("bot", "default", "bot/schedule-add", { name: "Old", schedule: "0 8 * * *", prompt: "Go." });
    const object = await findRoutine(r.store, "default", "Old");
    if (object === undefined) throw new Error("no routine");
    const now = Date.now();
    await r.store.put(
      ROUTINE_TYPE,
      object.id,
      {
        ...object.data,
        last: { plannedAt: now - 40 * DAY, schedule: "0 8 * * *", result: "all good" },
        runs: [
          { id: "R-0001", at: now - (ROUTINE_HISTORY_DAYS + 1) * DAY, status: "done" },
          { id: "R-0002", at: now - 2 * DAY, status: "done" },
        ],
      },
      "test",
    );
    expect(await pruneRoutineRuns(r.store, now)).toBe(1);
    const after = await findRoutine(r.store, "default", "Old");
    const entry = after === undefined ? undefined : scheduledPromptOf(after.data);
    expect(entry?.runs?.map((run) => run.id)).toEqual(["R-0002"]);
    expect(entry?.last?.result).toBe("all good");
    expect(await pruneRoutineRuns(r.store, now)).toBe(0);
  });
});
