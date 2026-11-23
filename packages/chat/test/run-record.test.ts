import { afterAll, describe, expect, test } from "bun:test";
import { createViews, filterShows, typeFilters } from "@operad-io/engine";
import { CHAT_TYPE, chatData, chatViews, createChat, createChatPlugin } from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

describe("the record of a routine's run", () => {
  test("takes an R- id of its own, leaves the chat numbers alone, and is in no chat list", async () => {
    const r = await rig(() => reply("x"));
    const first = await r.chat();
    const run = await createChat(
      r.store,
      { harness: "fake", cwd: r.root, title: "Morning (2026-01-01)", run: true },
      "test",
    );
    const second = await r.chat();
    expect(first).toBe("C-0001");
    expect(run).toBe("R-0001");
    // The run took no chat number.
    expect(second).toBe("C-0002");
    const next = await createChat(r.store, { harness: "fake", cwd: r.root, title: "Again", run: true }, "test");
    expect(next).toBe("R-0002");

    const object = await r.store.get(CHAT_TYPE, run);
    if (object === undefined) throw new Error("no record");
    expect(chatData(object.data).run).toBe(true);
    const row = chatViews.row(object);
    expect(row).toMatchObject({ id: run, state: "run", final: true });
    // The kernel's own "all" filter shows every state; the chat plugin's two lists do not show a run.
    const declared = typeFilters(createChatPlugin().objects?.find((item) => item.name === CHAT_TYPE));
    const lists = (declared?.filters ?? []).filter((filter) => filter.name !== "all");
    expect(lists.map((filter) => filter.name)).toEqual(["open", "closed"]);
    for (const filter of lists) expect(filterShows(filter, row.state)).toBe(false);
    const chatRow = chatViews.row((await r.store.get(CHAT_TYPE, first)) ?? object);
    expect(lists.some((filter) => filterShows(filter, chatRow.state))).toBe(true);
  });
});

describe("a run record is in no list", () => {
  test("not in open, closed or all, in the tree, and still read by its id", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    const run = await createChat(r.store, { harness: "fake", cwd: r.root, title: "Morning", run: true }, "test");
    const views = createViews({ registry: r.registry, store: r.store, onLog: () => undefined });
    try {
      for (const filter of ["open", "closed", "all"]) {
        const page = await views.list(CHAT_TYPE, { filter });
        expect(page.rows.map((row) => row.id)).not.toContain(run);
      }
      expect((await views.list(CHAT_TYPE, { filter: "all" })).rows.map((row) => row.id)).toContain(chat);
      expect((await views.list(CHAT_TYPE)).rows.map((row) => row.id)).not.toContain(run);
      expect((await views.listTree(CHAT_TYPE, { root: true, filter: "all" })).rows.map((row) => row.id)).not.toContain(run);
      // Readable from its routine's page: the object is still there.
      expect(await r.store.get(CHAT_TYPE, run)).toBeDefined();
    } finally {
      views.close();
    }
  });
});
