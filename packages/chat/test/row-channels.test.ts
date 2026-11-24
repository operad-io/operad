import { afterAll, describe, expect, test } from "bun:test";
import { chatViews } from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

describe("a chat row's channels", () => {
  test("a bound chat's row lists its channels, and an unbound chat's has none", async () => {
    const r = await rig(async () => reply("ok"));
    const chat = await r.chat();
    const stored = await r.store.get("chat", chat);
    if (stored === undefined) throw new Error("no chat");
    expect(chatViews.row(stored).data?.channels).toBeUndefined();
    const bound = { ...stored, data: { ...stored.data, channels: ["telegram:42"] } };
    expect(chatViews.row(bound).data?.channels).toEqual(["telegram:42"]);
  });
});
