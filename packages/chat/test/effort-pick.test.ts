import { afterAll, describe, expect, test } from "bun:test";
import { Views } from "@operad-io/engine";
import { allMessages, CHAT_TYPE, chatData, chatViews, EFFORT_FACT, startingEffort } from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

const EFFORTS = { list: ["low", "medium", "high"], default: "medium", flag: "--effort" } as const;

type Rig = Awaited<ReturnType<typeof rig>>;

async function act(r: Rig, chat: string, args: Record<string, unknown>) {
  const object = await r.store.get(CHAT_TYPE, chat);
  if (object === undefined) throw new Error("no chat");
  return r.registry.runAction("chat/effort", args, {
    object: { type: CHAT_TYPE, id: chat, data: object.data },
    actor: { via: "cli", id: "me" },
  });
}

async function offered(r: Rig, chat: string) {
  const views = new Views({ registry: r.registry, store: r.store, onLog: () => undefined });
  return (await views.get(`${CHAT_TYPE}:${chat}`)).actions.find((a) => a.name === "chat:effort");
}

describe("chat:effort", () => {
  test("the next reply uses the changed effort, and the history says who changed it and to what", async () => {
    const r = await rig(() => reply("ok"), undefined, EFFORTS);
    const chat = await r.chat({ effort: "medium", effortDefault: "medium" });
    await r.say(chat, "one");
    await r.round(chat);
    expect(r.calls[0]?.params.args).toEqual(["--effort", "medium"]);

    await act(r, chat, { effort: "high" });
    await r.say(chat, "two");
    await r.round(chat);
    expect(r.calls[1]?.params.args).toEqual(["--effort", "high"]);

    const facts = r.store.facts({ type: CHAT_TYPE, id: chat }).facts.filter((fact) => fact.type === EFFORT_FACT);
    expect(facts.map((fact) => fact.data)).toEqual([{ by: { via: "cli", id: "me" }, from: "medium", to: "high" }]);
    expect(chatViews.row((await r.store.get(CHAT_TYPE, chat)) as never).note).toBe("fake · high");
  });

  test("the row leaves the default effort out and shows a choice", async () => {
    const r = await rig(() => reply("ok"), undefined, EFFORTS);
    const chat = await r.chat({ effort: "medium", effortDefault: "medium" });
    expect(chatViews.row((await r.store.get(CHAT_TYPE, chat)) as never).note).toBe("fake");
    await act(r, chat, { effort: "low" });
    expect(chatViews.row((await r.store.get(CHAT_TYPE, chat)) as never).note).toBe("fake · low");
    await act(r, chat, { effort: "medium" });
    expect(chatViews.row((await r.store.get(CHAT_TYPE, chat)) as never).note).toBe("fake");
  });

  test("an effort the agent does not list is refused by name", async () => {
    const r = await rig(() => reply("ok"), undefined, EFFORTS);
    const chat = await r.chat({ effort: "medium", effortDefault: "medium" });
    await expect(act(r, chat, { effort: "extreme" })).rejects.toThrow(/extreme/);
  });

  test("the argument is an enum of the agent's efforts", async () => {
    const r = await rig(() => reply("ok"), undefined, EFFORTS);
    const chat = await r.chat({ effort: "medium", effortDefault: "medium" });
    const action = await offered(r, chat);
    expect(action?.args?.properties?.effort?.enum).toEqual(["low", "medium", "high"]);
  });

  test("a closed chat does not offer it", async () => {
    const r = await rig(() => reply("ok"), undefined, EFFORTS);
    const chat = await r.chat({ effort: "medium", effortDefault: "medium" });
    await r.registry.runAction("chat/close", {}, {
      object: { type: CHAT_TYPE, id: chat, data: (await r.store.get(CHAT_TYPE, chat))?.data ?? {} },
      actor: { via: "cli", id: "me" },
    });
    const object = await r.store.get(CHAT_TYPE, chat);
    expect(chatData(object?.data ?? {}).closed).toBe(true);
    expect(await offered(r, chat)).toBeUndefined();
    await expect(act(r, chat, { effort: "high" })).rejects.toThrow(/closed/);
  });

  test("an agent that offers no effort does not offer the action", async () => {
    const r = await rig(() => reply("ok"), undefined, { list: [], default: null });
    const chat = await r.chat();
    expect(await offered(r, chat)).toBeUndefined();
  });
});

describe("the reply and the effort", () => {
  test("a level the agent cannot take fails the reply naming it, and the agent is never called", async () => {
    const r = await rig(() => reply("ok"), undefined, EFFORTS);
    const chat = await r.chat({ effort: "extreme", effortDefault: "medium" });
    await r.say(chat, "hi");
    const result = await r.round(chat);
    expect(result.result).toBe("failed");
    expect(JSON.stringify(result.data)).toContain("extreme");
    expect(r.calls).toHaveLength(0);
    expect(allMessages(r.store, chat).filter((m) => m.role === "assistant")).toHaveLength(0);
  });

  test("the reply passes the agent's own flag", async () => {
    const r = await rig(() => reply("ok"), undefined, { list: ["off", "high"], default: "off", flag: "--thinking" });
    const chat = await r.chat({ effort: "high", effortDefault: "off" });
    await r.say(chat, "hi");
    await r.round(chat);
    expect(r.calls[0]?.params.args).toEqual(["--thinking", "high"]);
    expect(r.calls[0]?.params.effort).toBe("high");
  });

  test("a chat that stores no effort passes none", async () => {
    const r = await rig(() => reply("ok"), undefined, EFFORTS);
    const chat = await r.chat();
    await r.say(chat, "hi");
    await r.round(chat);
    expect(r.calls[0]?.params.args).toBeUndefined();
    expect(r.calls[0]?.params.effort).toBeUndefined();
  });
});

describe("startingEffort", () => {
  test("asked, else preferred, else the default; an unlisted one is refused", () => {
    expect(startingEffort("fake", EFFORTS, "high", "low")).toBe("high");
    expect(startingEffort("fake", EFFORTS, undefined, "low")).toBe("low");
    expect(startingEffort("fake", EFFORTS, undefined)).toBe("medium");
    expect(startingEffort("fake", undefined, undefined)).toBeUndefined();
    expect(() => startingEffort("fake", EFFORTS, "extreme")).toThrow(/extreme/);
  });
});
