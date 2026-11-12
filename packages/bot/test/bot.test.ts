import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { match, readProfile, type AccessProfile } from "@operad-io/access-match";
import { CHAT_TYPE, allMessages, chatData } from "@operad-io/chat";
import { createViews, listTypes, Views, type TriggerEvent } from "@operad-io/engine";
import {
  BOT_SETTINGS,
  DEFAULT_BOT,
  BotError,
  defaultAccess,
  readBots,
  resolveBot,
  syncBots,
} from "../src/index.ts";
import { cleanupRoots, rig, writeConfig } from "./support.ts";

afterAll(cleanupRoots);

function accessOf(value: unknown): AccessProfile {
  const read = readProfile(value);
  if (!read.ok) throw new Error(read.message);
  return read.profile;
}

describe("bots", () => {
  test("the plugin puts its objects under settings, so no client gives it a tab", async () => {
    const r = await rig();
    expect(r.registry.objectsUnderSettings("bot")).toBe(true);
    const types = listTypes(r.registry).filter((info) => info.plugin === "bot");
    expect(types.map((info) => [info.type, info.settings])).toEqual([
      ["bot", true],
      ["bot-proposal", true],
    ]);
  });

  test("the default bot exists without being written, with its own directory", async () => {
    const r = await rig();
    expect(Object.keys(readBots(r.home, {}))).toEqual([DEFAULT_BOT]);
    const bot = resolveBot(r.home, DEFAULT_BOT, {});
    expect(bot.cwd).toBe(join(r.home, "bot"));
  });

  test("another bot defaults to a directory of its own, and a written cwd wins", async () => {
    const r = await rig();
    expect(resolveBot(r.home, "reader", {}).cwd).toBe(join(r.home, "bot", "reader"));
    expect(resolveBot(r.home, "elsewhere", { cwd: join(r.root, "work") }).cwd).toBe(join(r.root, "work"));
  });

  test("a working directory that is the operad home, holds it, or is inside it outside bot is refused", async () => {
    const r = await rig();
    for (const cwd of [r.home, r.root, join(r.home, "store"), join(r.home, "secrets")]) {
      expect(() => resolveBot(r.home, "bad", { cwd })).toThrow(BotError);
    }
    expect(() => resolveBot(r.home, "ok", { cwd: join(r.home, "bot", "notes") })).not.toThrow();
  });

  test("a bot name that could leave the bot directory is refused", async () => {
    const r = await rig();
    writeConfig(r.home, { "../escape": {} });
    expect(() => readBots(r.home, {})).toThrow("a name is lowercase letters");
  });

  test("an `assistant` section is no longer read as the bot's settings", async () => {
    const r = await rig();
    writeFileSync(
      join(r.home, "config.json"),
      JSON.stringify({ plugins: { assistant: { settings: { bots: { ghost: {} } } } } }, null, 2),
    );
    expect(Object.keys(readBots(r.home, {}))).toEqual([DEFAULT_BOT]);
  });

  test("the settings are declared with a schema the kernel and the settings view can read", async () => {
    const r = await rig({ reader: { access: { readOnly: true } } });
    const declared = r.registry.settingsDeclarations().find((entry) => entry.plugin === "bot");
    expect(declared?.schema).toEqual(BOT_SETTINGS);
    expect(r.registry.settingsFor("bot").bots).toEqual({ reader: { access: { readOnly: true } } });
  });

  test("the schema file in the package says what the plugin's settings schema says", () => {
    const strip = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(strip)
        : typeof value === "object" && value !== null
          ? Object.fromEntries(
              Object.entries(value)
                .filter(([key]) => key !== "editable")
                .map(([key, item]) => [key, strip(item)]),
            )
          : value;
    const file = JSON.parse(readFileSync(join(import.meta.dir, "..", "bot.schema.json"), "utf8")) as Record<string, unknown>;
    const { $schema, $id, title, description, ...schema } = file;
    expect([typeof $schema, typeof $id, typeof title, typeof description]).toEqual(["string", "string", "string", "string"]);
    expect(schema).toEqual(strip(BOT_SETTINGS) as Record<string, unknown>);
  });

  test("a bot's page calls its default harness an agent, the way people read it", async () => {
    const r = await rig({ reader: { harness: "pi" } });
    const views = createViews({ registry: r.registry, store: r.store, onLog: () => undefined });
    try {
      const page = await views.section("bot:reader", "bot");
      expect(page.markdown).toContain("Default agent: pi");
      expect(page.markdown).not.toContain("Default harness");
    } finally {
      views.close();
    }
  });

  test("each bot is one row in lists, the default one too, and a removed one is marked", async () => {
    const r = await rig({ reader: {} });
    const views = createViews({ registry: r.registry, store: r.store, onLog: () => undefined });
    try {
      const listed = await views.list("bot");
      expect(listed.rows.map((row) => row.id).sort()).toEqual(["default", "reader"]);
      writeConfig(r.home, {});
      await syncBots(r.store, r.home, {});
      expect((await r.store.get("bot", "reader"))?.data.removed).toBe(true);
    } finally {
      views.close();
    }
  });
});

describe("the default access profile", () => {
  test("a chat of the default bot cannot read the secrets or the token, and can read its own directory", async () => {
    const r = await rig();
    mkdirSync(join(r.home, "secrets"), { recursive: true });
    writeFileSync(join(r.home, "secrets", "token"), "t");
    writeFileSync(join(r.home, "serve.lock"), "1");
    const cwd = join(r.home, "bot");
    const chat = await r.open(DEFAULT_BOT);
    await r.say(chat, "hi");
    await r.reply(chat);
    const call = r.calls[0];
    if (call === undefined) throw new Error("the harness was not called");
    expect(call.cwd).toBe(cwd);
    const access = accessOf(call.access);
    const home = join(r.root, "user");
    for (const path of ["secrets/token", "secrets", "store", "config.json", "serve.lock"]) {
      const verdict = match(access, { tool: "read", input: { path: join(r.home, path) }, cwd }, { home });
      expect(verdict.allow).toBe(false);
    }
    expect(match(access, { tool: "bash", input: { command: `cat ${join(r.home, "secrets", "token")}` }, cwd }, { home }).allow).toBe(false);
    expect(match(access, { tool: "read", input: { path: join(cwd, "notes.md") }, cwd }, { home }).allow).toBe(true);
    expect(match(access, { tool: "read", input: { path: "~/.ssh/id_ed25519" }, cwd }, { home: "/Users/someone" }).allow).toBe(false);
    expect(match(access, { tool: "bash", input: { command: "operad dev list" }, cwd }, { home }).allow).toBe(false);
  });

  test("anything new that appears in the home is denied too, but not the bot directory", async () => {
    const r = await rig();
    mkdirSync(join(r.home, "bot"), { recursive: true });
    writeFileSync(join(r.home, "gate.log"), "x");
    const denied = defaultAccess(r.home).denyPaths;
    expect(denied).toContain(join(r.home, "gate.log"));
    expect(denied).not.toContain(join(r.home, "bot"));
  });

  test("a bot only adds to the default; it cannot loosen it", async () => {
    const r = await rig();
    const tightened = resolveBot(r.home, "reader", {
      access: { denyPaths: ["~/notes"], readOnly: true, denyCommands: [] },
    }).access;
    const base = defaultAccess(r.home);
    expect(tightened.denyPaths).toEqual([
      ...(base.denyPaths as string[]),
      join(r.home, "bot", "reader", "skills"),
      "~/notes",
    ]);
    expect(tightened.denyCommands).toEqual(base.denyCommands);
    expect(tightened.readOnly).toBe(true);
    expect(resolveBot(r.home, "plain", { access: { readOnly: false } }).access.readOnly).toBeUndefined();
  });
});

describe("repositories", () => {
  test("a chat cannot write or read a repository's files, and a repository added later is covered at the next reply", async () => {
    const r = await rig();
    const id = await r.open("default");
    const repository = join(r.root, "repository");
    await r.store.put("repo", "repository", { path: repository, name: "repository" }, "test");
    await r.say(id, "hi");
    await r.reply(id);
    const access = accessOf(r.calls[0]?.access);
    const cwd = join(r.home, "bot");
    const home = join(r.root, "user");
    for (const call of [
      { tool: "write", input: { path: join(repository, "src", "file.ts") } },
      { tool: "bash", input: { command: `cd ${repository} && printf x > src/file` } },
      { tool: "bash", input: { command: `printf x > ${repository}/src/file` } },
    ]) {
      expect(match(access, { ...call, cwd }, { home }).allow).toBe(false);
    }
  });
});

describe("bot:chat with a first message", () => {
  test("creates the chat, sends the message, titles it from the message and opens it", async () => {
    const events: TriggerEvent[] = [];
    const r = await rig({}, undefined, (event) => void events.push(event));
    await syncBots(r.store, r.home, {});
    const id = await r.open(DEFAULT_BOT, { message: "Remind me what is on today" });
    expect(allMessages(r.store, id).map((message) => message.text)).toEqual(["Remind me what is on today"]);
    expect(events.map((event) => `${event.type} ${event.object}`)).toEqual([`message chat:${id}`]);
    expect(chatData((await r.store.get(CHAT_TYPE, id))?.data ?? {}).title).toBe("Remind me what is on today");
  });

  test("without a message nothing is sent, and the action declares what it creates", async () => {
    const events: TriggerEvent[] = [];
    const r = await rig({}, undefined, (event) => void events.push(event));
    await syncBots(r.store, r.home, {});
    const id = await r.open(DEFAULT_BOT);
    expect(allMessages(r.store, id)).toEqual([]);
    expect(events).toEqual([]);
    expect(r.registry.actions().find((info) => info.name === "bot:chat")?.creates).toBe("chat");
  });
});

describe("bot:chat", () => {
  test("says which chat it opened, so a client can open it", async () => {
    const r = await rig();
    await syncBots(r.store, r.home, {});
    const object = await r.store.get("bot", DEFAULT_BOT);
    const run = await r.registry.runAction("bot/chat", {}, {
      object: { type: "bot", id: DEFAULT_BOT, data: object?.data ?? {} },
      actor: { via: "cli", id: "me" },
    });
    const id = /C-\d+/.exec(String(run.value))?.[0];
    expect(run.opens).toBe(`chat:${id}`);
  });

  test("opens a chat of the chat plugin with the bot as its parent", async () => {
    const r = await rig();
    await syncBots(r.store, r.home, {});
    const id = await r.open(DEFAULT_BOT, { title: "Morning" });
    const chat = chatData((await r.store.get(CHAT_TYPE, id))?.data ?? {});
    expect(chat.parent).toBe("bot:default");
    expect(chat.title).toBe("Morning");
    expect(chat.cwd).toBe(join(r.home, "bot"));
    expect(existsSync(chat.cwd)).toBe(true);
    const row = r.registry.viewsFor("chat")?.views.row((await r.store.get(CHAT_TYPE, id)) as never);
    expect(row?.parent).toBe("bot:default");
  });

  test("the title is Bot (<name>) unless one is given", async () => {
    const r = await rig({ reader: {} });
    await syncBots(r.store, r.home, {});
    const id = await r.open("reader");
    expect((await r.store.get(CHAT_TYPE, id))?.data.title).toBe("Bot (reader)");
  });

  test("the agent is the one given, else the bot's, else the first loaded; an unloaded one is refused", async () => {
    const r = await rig({ pi: { harness: "pi" } });
    await syncBots(r.store, r.home, r.registry.settingsFor("bot"));
    const agentOf = async (id: string) => (await r.store.get(CHAT_TYPE, id))?.data.harness;
    expect(await agentOf(await r.open("default"))).toBe("claude");
    expect(await agentOf(await r.open("pi"))).toBe("pi");
    expect(await agentOf(await r.open("pi", { agent: "claude" }))).toBe("claude");
    await expect(r.open("default", { agent: "radian" })).rejects.toThrow("claude");
  });

  test("the agent argument is a choice of the loaded harness plugins, defaulting to the bot's own, else the first", async () => {
    const r = await rig({ pi: { harness: "pi" } }, ["claude", "radian", "pi"]);
    await syncBots(r.store, r.home, r.registry.settingsFor("bot"));
    const views = new Views({ registry: r.registry, store: r.store, onLog: () => undefined });
    const agent = async (bot: string) => {
      const chat = (await views.get(`bot:${bot}`)).actions.find((a) => a.name === "bot:chat");
      return chat?.args?.properties?.agent;
    };
    expect(await agent("default")).toMatchObject({ enum: ["claude", "radian", "pi"], default: "claude" });
    expect(await agent("pi")).toMatchObject({ enum: ["claude", "radian", "pi"], default: "pi" });
    const fewer = await rig({}, ["radian"]);
    await syncBots(fewer.store, fewer.home, {});
    const other = new Views({ registry: fewer.registry, store: fewer.store, onLog: () => undefined });
    const only = (await other.get("bot:default")).actions.find((a) => a.name === "bot:chat")?.args?.properties?.agent;
    expect(only).toMatchObject({ enum: ["radian"], default: "radian" });
    expect((await views.get("bot:default")).actions.find((a) => a.name === "bot:chat")?.args?.properties?.harness).toBeUndefined();
  });

  test("with no agent loaded the chat is not offered, and says why", async () => {
    const r = await rig({}, []);
    await syncBots(r.store, r.home, {});
    const views = new Views({ registry: r.registry, store: r.store, onLog: () => undefined });
    expect((await views.get("bot:default")).actions.map((a) => a.name)).not.toContain("bot:chat");
    await expect(views.act("bot:chat", "bot:default", { surface: "cli", actor: { via: "cli", id: "me" } })).rejects.toThrow(
      "no agent is loaded",
    );
  });

  test("an agent outside the loaded ones is refused with the list", async () => {
    const r = await rig({}, ["claude", "pi"]);
    await syncBots(r.store, r.home, {});
    await expect(r.open("default", { agent: "grok" })).rejects.toThrow('"claude", "pi"');
  });

  test("the agent stays what it was when the bot's default changes", async () => {
    const r = await rig({ reader: { harness: "pi" } });
    await syncBots(r.store, r.home, {});
    const id = await r.open("reader");
    writeConfig(r.home, { reader: { harness: "claude" } });
    await r.say(id, "hi");
    await r.reply(id);
    expect((await r.store.get(CHAT_TYPE, id))?.data.harness).toBe("pi");
    expect(r.calls).toHaveLength(1);
  });

  test("a bot that was removed or cannot be used offers no chat", async () => {
    const r = await rig({ bad: { cwd: "/" } });
    await syncBots(r.store, r.home, {});
    expect((await r.store.get("bot", "bad"))?.data.problem).toContain("operad home");
    await expect(r.open("bad")).rejects.toThrow();
  });
});

describe("a reply reads the bot again", () => {
  test("tightening the access profile applies to the next reply of the same chat", async () => {
    const r = await rig({ reader: {} });
    await syncBots(r.store, r.home, {});
    const id = await r.open("reader");
    await r.say(id, "one");
    await r.reply(id);
    expect(accessOf(r.calls[0]?.access).readOnly).toBeUndefined();
    expect(accessOf(r.calls[0]?.access).denyPaths).not.toContain("~/private");

    writeConfig(r.home, { reader: { access: { readOnly: true, denyPaths: ["~/private"] } } });
    await r.say(id, "two");
    await r.reply(id);
    const access = accessOf(r.calls[1]?.access);
    expect(access.readOnly).toBe(true);
    expect(access.denyPaths).toContain("~/private");
  });

  test("a skill added to the bot is given at the next reply; none before", async () => {
    const r = await rig({ reader: {} });
    await syncBots(r.store, r.home, {});
    const id = await r.open("reader");
    await r.say(id, "one");
    await r.reply(id);
    expect(r.calls[0]?.params.skills).toBeUndefined();

    const skill = join(r.root, "skills", "brain");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: brain\n---\n");
    writeConfig(r.home, { reader: { skills: [skill] } });
    await r.say(id, "two");
    await r.reply(id);
    expect(r.calls[1]?.params.skills).toEqual([skill]);
  });

  test("a skill directory without a SKILL.md fails the reply and names it", async () => {
    const r = await rig({ reader: {} });
    await syncBots(r.store, r.home, {});
    const id = await r.open("reader");
    writeConfig(r.home, { reader: { skills: [join(r.root, "nothing")] } });
    await r.say(id, "hi");
    const result = await r.reply(id);
    expect(result.result).toBe("failed");
    expect(String(result.data?.message)).toContain("there is no SKILL.md");
    expect(r.calls).toHaveLength(0);
  });

  test("a bot taken out of the settings stops answering instead of using an older copy", async () => {
    const r = await rig({ reader: {} });
    await syncBots(r.store, r.home, {});
    const id = await r.open("reader");
    writeConfig(r.home, {});
    await r.say(id, "hi");
    const result = await r.reply(id);
    expect(result.result).toBe("failed");
    expect(result.data).toMatchObject({ message: 'bot "reader" is no longer in the settings' });
    expect(r.calls).toHaveLength(0);
  });

  test("a bot's speaker is read again when a transcript is drawn", async () => {
    const r = await rig({ reader: {} });
    await syncBots(r.store, r.home, {});
    const id = await r.open("reader");
    await r.say(id, "hi");
    await r.reply(id);
    const views = createViews({ registry: r.registry, store: r.store, onLog: () => undefined });
    try {
      const first = await views.section(`chat:${id}`, "transcript", undefined, {});
      expect(first.markdown).toContain("**Operad Bot**");
      writeConfig(r.home, { reader: { speaker: "Nova" } });
      const second = await views.section(`chat:${id}`, "transcript", undefined, {});
      expect(second.markdown).toContain("**Nova**");
    } finally {
      views.close();
    }
  });

  test("the agent gets operad's tools and works in the bot's directory, not a repository", async () => {
    const r = await rig();
    await syncBots(r.store, r.home, {});
    const id = await r.open("default");
    await r.say(id, "hi");
    await r.reply(id);
    expect(r.calls[0]?.params.operadTools).toEqual({ home: r.home });
    expect(r.calls[0]?.params.cwd).toBe(join(r.home, "bot"));
    expect(defaultAccess(r.home).denyCommands).toContain("operad");
  });
});
