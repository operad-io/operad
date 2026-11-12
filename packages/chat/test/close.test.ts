import { afterAll, describe, expect, test } from "bun:test";
import { filterShows, typeFilters } from "@operad-io/engine";
import {
  allMessages,
  CHAT_TYPE,
  chatData,
  chatViews,
  CLOSED_FACT,
  createChatPlugin,
} from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;

async function act(r: Rig, chat: string, name: string, args: Record<string, unknown> = {}) {
  const object = await r.store.get(CHAT_TYPE, chat);
  if (object === undefined) throw new Error("no chat");
  return r.registry.runAction(name, args, {
    object: { type: CHAT_TYPE, id: chat, data: object.data },
    actor: { via: "cli", id: "me" },
  });
}

async function stored(r: Rig, chat: string) {
  const object = await r.store.get(CHAT_TYPE, chat);
  if (object === undefined) throw new Error("no chat");
  return object;
}

describe("chat:close", () => {
  test("records a closed fact, makes the row closed, and keeps the transcript readable", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    await r.say(chat, "before close");
    const result = await act(r, chat, "chat/close");
    expect(result.value).toBe(`closed ${chat}`);

    const facts = r.store.facts({ type: CHAT_TYPE, id: chat });
    const closed = facts.facts.filter((fact) => fact.type === CLOSED_FACT);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.data).toEqual({ by: { via: "cli", id: "me" } });

    const object = await stored(r, chat);
    expect(chatData(object.data).closed).toBe(true);
    expect(chatViews.row(object)).toMatchObject({ id: chat, state: "closed", final: true });
    expect(allMessages(r.store, chat).map((message) => message.text)).toEqual(["before close"]);
    expect(
      (
        await chatViews.load(
          {
            plugin: "chat",
            home: "",
            cwd: "",
            store: r.store,
            facts: { append: () => Promise.reject(new Error("read only")) },
            logger: { path: "", write: () => Promise.resolve("") },
            signal: new AbortController().signal,
            settings: {},
            secrets: {
              get: () => Promise.resolve(undefined),
              set: () => Promise.resolve(),
              delete: () => Promise.resolve(),
              names: () => Promise.resolve([]),
            },
          },
          object,
          "transcript",
          {},
        )
      ).markdown,
    ).toContain("before close");
    expect(r.registry.actions().find((info) => info.name === "chat:close")).toMatchObject({
      confirm: true,
      ends: true,
    });
  });

  test("a closed chat refuses chat:send with a short message and adds no message or event", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    await act(r, chat, "chat/close");
    await expect(act(r, chat, "chat/send", { note: "too late" })).rejects.toThrow(
      `chat ${chat} is closed; it takes no messages`,
    );
    expect(allMessages(r.store, chat)).toEqual([]);
    expect(r.events).toEqual([]);
  });

  test("a closed chat offers neither send nor close again", async () => {
    const r = await rig(() => reply("x"));
    const chat = await r.chat();
    await act(r, chat, "chat/close");
    const object = await stored(r, chat);
    for (const name of ["send", "close"]) {
      const action = r.registry.actionDefinition("chat", name, CHAT_TYPE);
      expect(action).toBeDefined();
      expect(await action?.when(object.data, { store: r.store })).toBe(false);
    }
  });
});

describe("chat filters", () => {
  test("open is the default and closed is next to the kernel's all", () => {
    const definition = createChatPlugin().objects?.find((object) => object.name === CHAT_TYPE);
    const declared = typeFilters(definition);
    expect(declared?.default).toBe("open");
    expect(declared?.filters).toEqual([
      { name: "open", states: ["open"] },
      { name: "all" },
      { name: "closed", states: ["closed"] },
    ]);
    const open = declared?.filters.find((filter) => filter.name === "open");
    if (open === undefined) throw new Error("no open filter");
    expect(filterShows(open, "open")).toBe(true);
    expect(filterShows(open, "closed")).toBe(false);
  });
});
