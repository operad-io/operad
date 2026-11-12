import { afterAll, describe, expect, test } from "bun:test";
import { Views } from "@operad-io/engine";
import { allMessages, CHAT_TYPE, chatData, chatViews, MODEL_FACT, startingModel } from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

const MODELS = { list: ["small", "large"], default: "small" } as const;

type Rig = Awaited<ReturnType<typeof rig>>;

async function act(r: Rig, chat: string, args: Record<string, unknown>) {
  const object = await r.store.get(CHAT_TYPE, chat);
  if (object === undefined) throw new Error("no chat");
  return r.registry.runAction("chat/model", args, {
    object: { type: CHAT_TYPE, id: chat, data: object.data },
    actor: { via: "cli", id: "me" },
  });
}

async function offered(r: Rig, chat: string) {
  const views = new Views({ registry: r.registry, store: r.store, onLog: () => undefined });
  return (await views.get(`${CHAT_TYPE}:${chat}`)).actions.find((a) => a.name === "chat:model");
}

describe("chat:model", () => {
  test("the next reply uses the changed model, and the history says who changed it and to what", async () => {
    const r = await rig(() => reply("ok"), MODELS);
    const chat = await r.chat({ model: "small" });
    await r.say(chat, "one");
    await r.round(chat);
    expect(r.calls[0]?.params.args).toEqual(["--model", "small"]);

    await act(r, chat, { model: "large" });
    await r.say(chat, "two");
    await r.round(chat);
    expect(r.calls[1]?.params.args).toEqual(["--model", "large"]);

    const facts = r.store.facts({ type: CHAT_TYPE, id: chat }).facts.filter((fact) => fact.type === MODEL_FACT);
    expect(facts.map((fact) => fact.data)).toEqual([{ by: { via: "cli", id: "me" }, from: "small", to: "large" }]);
    expect(chatViews.row((await r.store.get(CHAT_TYPE, chat)) as never).note).toBe("fake · large");
  });

  test("a model the agent does not list is refused by name", async () => {
    const r = await rig(() => reply("ok"), MODELS);
    const chat = await r.chat({ model: "small" });
    await expect(act(r, chat, { model: "huge" })).rejects.toThrow(/huge/);
  });

  test("the argument is an enum of the agent's models", async () => {
    const r = await rig(() => reply("ok"), MODELS);
    const chat = await r.chat({ model: "small" });
    const action = await offered(r, chat);
    expect(action?.args?.properties?.model?.enum).toEqual(["small", "large"]);
  });

  test("a closed chat does not offer it", async () => {
    const r = await rig(() => reply("ok"), MODELS);
    const chat = await r.chat({ model: "small" });
    await r.registry.runAction("chat/close", {}, {
      object: { type: CHAT_TYPE, id: chat, data: (await r.store.get(CHAT_TYPE, chat))?.data ?? {} },
      actor: { via: "cli", id: "me" },
    });
    const object = await r.store.get(CHAT_TYPE, chat);
    expect(chatData(object?.data ?? {}).closed).toBe(true);
    expect(await offered(r, chat)).toBeUndefined();
    await expect(act(r, chat, { model: "large" })).rejects.toThrow(/closed/);
  });
});

describe("the reply and the model", () => {
  test("a model the agent cannot take fails the reply naming it, and the agent is never called", async () => {
    const r = await rig(() => reply("ok"), MODELS);
    const chat = await r.chat({ model: "huge" });
    await r.say(chat, "hi");
    const result = await r.round(chat);
    expect(result.result).toBe("failed");
    expect(JSON.stringify(result.data)).toContain("huge");
    expect(r.calls).toHaveLength(0);
    expect(allMessages(r.store, chat).filter((m) => m.role === "assistant")).toHaveLength(0);
  });

  test("a chat that stores no model passes none", async () => {
    const r = await rig(() => reply("ok"));
    const chat = await r.chat();
    await r.say(chat, "hi");
    await r.round(chat);
    expect(r.calls[0]?.params.args).toBeUndefined();
  });
});

describe("startingModel", () => {
  test("asked, else preferred, else the default; an unlisted one is refused", () => {
    expect(startingModel("fake", MODELS, "large", "small")).toBe("large");
    expect(startingModel("fake", MODELS, undefined, "large")).toBe("large");
    expect(startingModel("fake", MODELS, undefined)).toBe("small");
    expect(startingModel("fake", undefined, undefined)).toBeUndefined();
    expect(() => startingModel("fake", MODELS, "huge")).toThrow(/huge/);
  });
});
