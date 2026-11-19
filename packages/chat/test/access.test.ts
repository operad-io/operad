import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Views, type AskRequest, type StepContext } from "@operad-io/engine";
import { readLiveAccess } from "@operad-io/access-match";
import {
  ACCESS_FACT,
  ACCESS_LEVEL_INFO,
  accessLevelPath,
  allMessages,
  CHAT_TYPE,
  chatData,
  chatViews,
} from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;

async function act(r: Rig, chat: string, args: Record<string, unknown>) {
  const object = await r.store.get(CHAT_TYPE, chat);
  if (object === undefined) throw new Error("no chat");
  return r.registry.runAction("chat/access", args, {
    object: { type: CHAT_TYPE, id: chat, data: object.data },
    actor: { via: "cli", id: "me" },
  });
}

async function offered(r: Rig, chat: string) {
  const views = new Views({ registry: r.registry, store: r.store, onLog: () => undefined });
  return (await views.get(`${CHAT_TYPE}:${chat}`)).actions.find((a) => a.name === "chat:access");
}

describe("chat:access", () => {
  test("the next reply uses the changed level, and the history says who changed it and to what", async () => {
    const r = await rig(() => reply("ok"));
    const chat = await r.chat({ accessLevel: "ask", accessDefault: "ask" });
    await r.say(chat, "one");
    await r.round(chat);
    expect(r.calls[0]?.access).toMatchObject({ level: "ask" });
    expect(chatViews.row((await r.store.get(CHAT_TYPE, chat)) as never).note).toBe("fake");

    await act(r, chat, { level: "full" });
    await r.say(chat, "two");
    await r.round(chat);
    expect(r.calls[1]?.access).toMatchObject({ level: "full" });

    const facts = r.store.facts({ type: CHAT_TYPE, id: chat }).facts.filter((fact) => fact.type === ACCESS_FACT);
    expect(facts.map((fact) => fact.data)).toEqual([
      { by: { via: "cli", id: "me" }, from: "ask", to: "full" },
    ]);
    expect(chatData((await r.store.get(CHAT_TYPE, chat))?.data ?? {}).accessLevel).toBe("full");
    expect(chatViews.row((await r.store.get(CHAT_TYPE, chat)) as never).note).toBe("fake · full");
  });

  test("a change updates the live file a running reply reads, keeping its base profile", async () => {
    const r = await rig(() => reply("ok"));
    const chat = await r.chat({ access: { denyCommands: ["rm"] }, accessLevel: "ask", accessDefault: "ask" });
    const file = accessLevelPath(join(r.root, "home"), chat);

    await act(r, chat, { level: "full" });
    expect(readLiveAccess(file)).toEqual({ access: { denyCommands: ["rm"] }, level: "full" });

    await act(r, chat, { level: "edits" });
    expect(readLiveAccess(file)).toEqual({ access: { denyCommands: ["rm"] }, level: "edits" });
  });

  test("a question open when the level rises is checked again under the new level", async () => {
    const asked: AskRequest[] = [];
    let checked: unknown;
    const r = await rig(async (ctx: StepContext) => {
      await ctx.ask({
        prompt: "Let write use this path? /repo/a.ts",
        choices: ["allow_once", "reject_once"],
        resume: { session: "s", grant: { kind: "path", value: "/repo/a.ts", choice: "allow_once", tool: "write" } },
      });
      return reply("done");
    });
    const chat = await r.chat({ access: { readOnly: true }, accessLevel: "plan", accessDefault: "plan" });
    await r.say(chat, "go");
    const asker = {
      async ask(request: AskRequest) {
        asked.push(request);
        await act(r, chat, { level: "full" });
        checked = await request.recheck?.();
        return { kind: "answered" as const, answer: { choice: checked === undefined ? "reject_once" : "allow_once" } };
      },
      async useGrant() {
        return false;
      },
    };

    expect((await r.round(chat, {}, asker)).result).toBe("done");
    expect(asked).toHaveLength(1);
    expect(checked).toEqual({ ask: false, note: "Full access", actor: { via: "cli", id: "me" } });
  });

  test("the row leaves the starting level out and shows a choice", async () => {
    const r = await rig(() => reply("ok"));
    const chat = await r.chat({ accessLevel: "plan", accessDefault: "plan" });
    expect(chatViews.row((await r.store.get(CHAT_TYPE, chat)) as never).note).toBe("fake");
    await act(r, chat, { level: "edits" });
    expect(chatViews.row((await r.store.get(CHAT_TYPE, chat)) as never).note).toBe("fake · edits");
    await act(r, chat, { level: "plan" });
    expect(chatViews.row((await r.store.get(CHAT_TYPE, chat)) as never).note).toBe("fake");
  });

  test("the argument lists the four levels and says what each one does", async () => {
    const r = await rig(() => reply("ok"));
    const chat = await r.chat();
    const action = await offered(r, chat);
    expect(action?.args?.properties?.level?.enum).toEqual(["plan", "ask", "edits", "full"]);
    const choices = action?.args?.properties?.level?.oneOf ?? [];
    expect(choices.map((choice) => [choice.const, choice.title, choice.description])).toEqual(
      ["plan", "ask", "edits", "full"].map((level) => [
        level,
        ACCESS_LEVEL_INFO[level as "plan" | "ask" | "edits" | "full"].title,
        ACCESS_LEVEL_INFO[level as "plan" | "ask" | "edits" | "full"].description,
      ]),
    );
    expect(ACCESS_LEVEL_INFO.full.description).toContain("deny");
    expect(ACCESS_LEVEL_INFO.full.description).toContain("ask");
  });

  test("a level it already uses changes nothing, and a closed chat does not offer it", async () => {
    const r = await rig(() => reply("ok"));
    const chat = await r.chat({ accessLevel: "ask", accessDefault: "ask" });
    expect(String((await act(r, chat, { level: "ask" })).value)).toContain("already uses");
    expect(r.store.facts({ type: CHAT_TYPE, id: chat }).facts.filter((fact) => fact.type === ACCESS_FACT)).toEqual([]);

    await r.registry.runAction("chat/close", {}, {
      object: { type: CHAT_TYPE, id: chat, data: (await r.store.get(CHAT_TYPE, chat))?.data ?? {} },
      actor: { via: "cli", id: "me" },
    });
    expect(await offered(r, chat)).toBeUndefined();
    await expect(act(r, chat, { level: "full" })).rejects.toThrow(/closed/);
  });

  test("/access changes the level and leaves one command line, not a message", async () => {
    const r = await rig(() => reply("ok"));
    const chat = await r.chat({ accessLevel: "plan", accessDefault: "plan" });
    const object = await r.store.get(CHAT_TYPE, chat);
    if (object === undefined) throw new Error("no chat");
    const sent = await r.registry.runAction("chat/send", { note: "/access full" }, {
      object: { type: CHAT_TYPE, id: chat, data: object.data },
      actor: { via: "cli", id: "me" },
    });
    expect(String(sent.value)).toContain("full");
    expect(chatData((await r.store.get(CHAT_TYPE, chat))?.data ?? {}).accessLevel).toBe("full");
    expect(allMessages(r.store, chat)).toEqual([]);
    expect(r.events).toEqual([]);
  });
});

describe("a chat whose agent cannot carry the level", () => {
  test("the reply is refused at its start, names the level, and the agent is never called", async () => {
    for (const harness of ["codex", "radian"]) {
      const r = await rig(() => reply("ok"), undefined, undefined, harness, [], { accessLevels: [] });
      const chat = await r.chat({ accessLevel: "ask", accessDefault: "ask" });
      await r.say(chat, "hi");
      const result = await r.round(chat);
      expect(result.result).toBe("failed");
      expect(JSON.stringify(result.data)).toContain(harness);
      expect(JSON.stringify(result.data)).toContain("ask");
      expect(r.calls).toHaveLength(0);
      expect(allMessages(r.store, chat).filter((message) => message.role === "assistant")).toHaveLength(0);
    }
  });
});
