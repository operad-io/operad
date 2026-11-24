import { afterAll, describe, expect, test } from "bun:test";
import { chatViews } from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

describe("a chat row's channels", () => {
  test("a bound chat's row lists its channels, and an unbound chat's has none", async () => {
    const r = await rig(async () => reply("ok"));
    const unbound = await r.store.get("chat", await r.chat());
    const bound = await r.store.get("chat", await r.chat({ channels: ["telegram:42"] }));
    if (unbound === undefined || bound === undefined) throw new Error("no chat");
    expect(chatViews.row(unbound).data?.channels).toBeUndefined();
    expect(chatViews.row(bound).data?.channels).toEqual(["telegram:42"]);
  });
});
