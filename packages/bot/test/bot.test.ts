import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { match, readProfile, type AccessProfile } from "@operad-io/access-match";
import { CHAT_TYPE, allMessages, chatData } from "@operad-io/chat";
import { createViews, listTypes, Views, type HarnessModelInfo, type TriggerEvent } from "@operad-io/engine";
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

  test("using the owner's own agent settings is off unless the bot turns it on", async () => {
    const r = await rig();
    expect(resolveBot(r.home, "reader", {}).useOwnSettings).toBe(false);
    expect(resolveBot(r.home, "reader", { useOwnSettings: true }).useOwnSettings).toBe(true);
    expect(resolveBot(r.home, "reader", { useOwnSettings: false }).useOwnSettings).toBe(false);
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

  test("a bot's page shows each skill's name, not only its path", async () => {
    const r = await rig({ reader: {} });
    const skill = join(r.root, "folder");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: brain\n---\n");
    writeConfig(r.home, { reader: { skills: [skill] } });
    await syncBots(r.store, r.home, { bots: { reader: { skills: [skill] } } });
    const views = createViews({ registry: r.registry, store: r.store, onLog: () => undefined });
    try {
      const page = await views.section("bot:reader", "bot");
      expect(page.markdown).toContain("Skills: brain");
      expect(page.markdown).not.toContain(skill);
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
    expect(match(access, { tool: "bash", input: { command: "sudo ls" }, cwd }, { home }).allow).toBe(false);
    expect(match(access, { tool: "bash", input: { command: "git push origin main" }, cwd }, { home })).toMatchObject({
      allow: false,
      ask: true,
    });
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

describe("skills", () => {
  test("a skill is readable but cannot be written, edited or removed", async () => {
    const r = await rig({ reader: {} });
    const skill = join(r.root, "skills", "brain");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: brain\n---\n");
    writeConfig(r.home, { reader: { skills: [skill] } });
    await syncBots(r.store, r.home, { bots: { reader: { skills: [skill] } } });
    const chat = await r.open("reader");
    await r.say(chat, "hi");
    await r.reply(chat);
    const access = accessOf(r.calls[0]?.access);
    const cwd = join(r.home, "bot", "reader");
    const home = join(r.root, "user");
    const file = join(skill, "SKILL.md");
    expect(match(access, { tool: "read", input: { path: file }, cwd }, { home }).allow).toBe(true);
    expect(match(access, { tool: "read", input: { path: join(skill, "scripts", "run.sh") }, cwd }, { home }).allow).toBe(true);
    expect(match(access, { tool: "bash", input: { command: `cat ${file}` }, cwd }, { home }).allow).toBe(true);
    for (const call of [
      { tool: "write", input: { path: file } },
      { tool: "edit", input: { path: file } },
      { tool: "bash", input: { command: `printf x > ${file}` } },
      { tool: "bash", input: { command: `rm ${file}` } },
      { tool: "bash", input: { command: `mv ${file} ${join(skill, "old.md")}` } },
    ]) {
      const verdict = match(access, { ...call, cwd }, { home });
      expect(verdict.allow).toBe(false);
      expect(verdict.allow === false ? verdict.ask : true).not.toBe(true);
      expect(verdict.allow === false ? verdict.reason : "").toContain("denyPaths");
    }
  });

  test("a listed parent directory loads every skill directly inside it, including one added later", async () => {
    const r = await rig({ reader: {} });
    const parent = join(r.root, "skills");
    const brain = join(parent, "brain");
    mkdirSync(brain, { recursive: true });
    writeFileSync(join(brain, "SKILL.md"), "---\nname: brain\n---\n");
    writeConfig(r.home, { reader: { skills: [parent] } });
    await syncBots(r.store, r.home, { bots: { reader: { skills: [parent] } } });
    const chat = await r.open("reader");
    await r.say(chat, "one");
    await r.reply(chat);
    expect(r.calls[0]?.params.skills).toEqual([brain]);

    const later = join(parent, "later");
    mkdirSync(later, { recursive: true });
    writeFileSync(join(later, "SKILL.md"), "---\nname: later\n---\n");
    await r.say(chat, "two");
    await r.reply(chat);
    expect(r.calls[1]?.params.skills).toEqual([brain, later]);
  });

  test("a listed .agents directory loads the skills directly inside its skills directory, including one added later", async () => {
    const r = await rig({ reader: {} });
    const agents = join(r.root, "home", ".agents");
    const brain = join(agents, "skills", "brain");
    mkdirSync(brain, { recursive: true });
    writeFileSync(join(brain, "SKILL.md"), "---\nname: brain\n---\n");
    writeConfig(r.home, { reader: { skills: [agents] } });
    await syncBots(r.store, r.home, { bots: { reader: { skills: [agents] } } });
    const chat = await r.open("reader");
    await r.say(chat, "one");
    await r.reply(chat);
    expect(r.calls[0]?.params.skills).toEqual([brain]);

    const later = join(agents, "skills", "later");
    mkdirSync(later, { recursive: true });
    writeFileSync(join(later, "SKILL.md"), "---\nname: later\n---\n");
    await r.say(chat, "two");
    await r.reply(chat);
    expect(r.calls[1]?.params.skills).toEqual([brain, later]);
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

describe("bot:chat and the model", () => {
  const modelOf = async (r: Awaited<ReturnType<typeof rig>>, id: string) => (await r.store.get(CHAT_TYPE, id))?.data.model;

  test("a chat starts with the agent's default model, the bot's configured one, or the one asked for", async () => {
    const r = await rig({ tuned: { harness: "pi", model: "pi-b" } }, ["claude", "pi"]);
    await syncBots(r.store, r.home, r.registry.settingsFor("bot"));
    expect(await modelOf(r, await r.open("default"))).toBe("claude-a");
    expect(await modelOf(r, await r.open("tuned"))).toBe("pi-b");
    expect(await modelOf(r, await r.open("tuned", { model: "pi-a" }))).toBe("pi-a");
  });

  test("a model the agent does not list is refused by name", async () => {
    const r = await rig({}, ["claude", "pi"]);
    await syncBots(r.store, r.home, {});
    await expect(r.open("default", { agent: "pi", model: "claude-b" })).rejects.toThrow("claude-b");
  });

  test("a configured bot model its agent does not list is refused by name, not replaced by the default", async () => {
    const r = await rig({ odd: { harness: "pi", model: "huge" } }, ["claude", "pi"]);
    await syncBots(r.store, r.home, r.registry.settingsFor("bot"));
    await expect(r.open("odd")).rejects.toThrow("huge");
  });

  test("the model argument is an enum of the loaded agents' models", async () => {
    const r = await rig({}, ["claude", "pi"]);
    await syncBots(r.store, r.home, {});
    const views = new Views({ registry: r.registry, store: r.store, onLog: () => undefined });
    const chat = (await views.get("bot:default")).actions.find((a) => a.name === "bot:chat");
    expect(chat?.args?.properties?.model?.enum).toEqual(["claude-a", "claude-b", "pi-a", "pi-b"]);
  });

  test("bot:chat and bot:create carry what each agent knows about each model", async () => {
    const r = await rig({}, ["claude", "pi"]);
    await syncBots(r.store, r.home, {});
    const views = new Views({ registry: r.registry, store: r.store, onLog: () => undefined });
    try {
      const actions = (await views.get("bot:default")).actions;
      const expected: Readonly<Record<string, HarnessModelInfo>> = {
        "claude-a": {
          id: "claude-a",
          name: "claude A",
          provider: "fake",
          window: 100_000,
          capabilities: ["vision", "tools"],
        },
        "claude-b": {
          id: "claude-b",
          name: "claude B",
          provider: "fake",
          capabilities: ["reasoning", "web"],
        },
        "pi-a": {
          id: "pi-a",
          name: "pi A",
          provider: "fake",
          window: 100_000,
          capabilities: ["vision", "tools"],
        },
        "pi-b": {
          id: "pi-b",
          name: "pi B",
          provider: "fake",
          capabilities: ["reasoning", "web"],
        },
      };
      expect(actions.find((a) => a.name === "bot:chat")?.args?.properties?.model?.info).toEqual(expected);
      expect(actions.find((a) => a.name === "bot:create")?.args?.properties?.model?.info).toEqual(expected);
    } finally {
      views.close();
    }
  });
});

describe("bot:chat per-agent conditionals", () => {
  test("one if/then per agent carries its lists and defaults; a bot's model is the default only of the agent that lists it", async () => {
    const r = await rig({ tuned: { harness: "pi", model: "pi-b", effort: "pi-high" } }, ["claude", "pi", "radian"]);
    await syncBots(r.store, r.home, r.registry.settingsFor("bot"));
    const views = new Views({ registry: r.registry, store: r.store, onLog: () => undefined });
    const chat = (await views.get("bot:tuned")).actions.find((a) => a.name === "bot:chat");
    const all = chat?.args?.allOf ?? [];
    expect(all.map((c) => c.if?.properties?.agent?.const)).toEqual(["claude", "pi", "radian"]);
    const then = (i: number) => all[i]?.then?.properties;
    expect(then(0)?.model).toMatchObject({ type: "string", enum: ["claude-a", "claude-b"], default: "claude-a" });
    expect(then(0)?.effort).toEqual({ type: "string", enum: ["claude-low", "claude-high"], default: "claude-low" });
    expect(then(1)?.model?.default).toBe("pi-b");
    expect(then(1)?.effort?.default).toBe("pi-high");
    expect(then(2)?.model).toBeUndefined();
    expect(then(2)?.effort).toBeUndefined();
    expect(chat?.args?.properties?.model?.enum).toContain("pi-a");
  });

  test("claude with a pi model is refused by name", async () => {
    const r = await rig({}, ["claude", "pi"]);
    await syncBots(r.store, r.home, {});
    await expect(r.open("default", { agent: "claude", model: "pi-a" })).rejects.toThrow("pi-a");
  });
});

describe("bot:chat and the effort", () => {
  const effortOf = async (r: Awaited<ReturnType<typeof rig>>, id: string) => (await r.store.get(CHAT_TYPE, id))?.data.effort;

  test("a chat starts with the agent's default effort, the bot's configured one, or the one asked for", async () => {
    const r = await rig({ tuned: { harness: "pi", effort: "pi-high" } }, ["claude", "pi"]);
    await syncBots(r.store, r.home, r.registry.settingsFor("bot"));
    expect(await effortOf(r, await r.open("default"))).toBe("claude-low");
    expect(await effortOf(r, await r.open("tuned"))).toBe("pi-high");
    expect(await effortOf(r, await r.open("tuned", { effort: "pi-low" }))).toBe("pi-low");
  });

  test("an effort the agent does not list is refused by name", async () => {
    const r = await rig({}, ["claude", "pi"]);
    await syncBots(r.store, r.home, {});
    await expect(r.open("default", { agent: "pi", effort: "claude-high" })).rejects.toThrow("claude-high");
  });

  test("a configured bot effort its agent does not list is refused by name, not replaced by the default", async () => {
    const r = await rig({ odd: { harness: "pi", effort: "extreme" } }, ["claude", "pi"]);
    await syncBots(r.store, r.home, r.registry.settingsFor("bot"));
    await expect(r.open("odd")).rejects.toThrow("extreme");
  });

  test("the effort argument is an enum of the loaded agents' efforts", async () => {
    const r = await rig({}, ["claude", "pi"]);
    await syncBots(r.store, r.home, {});
    const views = new Views({ registry: r.registry, store: r.store, onLog: () => undefined });
    const chat = (await views.get("bot:default")).actions.find((a) => a.name === "bot:chat");
    expect(chat?.args?.properties?.effort?.enum).toEqual(["claude-low", "claude-high", "pi-low", "pi-high"]);
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
    expect(chat.accessLevel).toBe("ask");
    expect(chat.accessDefault).toBe("ask");
    expect(existsSync(chat.cwd)).toBe(true);
    const row = r.registry.viewsFor("chat")?.views.row((await r.store.get(CHAT_TYPE, id)) as never);
    expect(row?.parent).toBe("bot:default");
  });

  test("bot:chat puts the channels it is given on the new chat, and refuses another form", async () => {
    const r = await rig();
    await syncBots(r.store, r.home, {});
    const id = await r.open(DEFAULT_BOT, { channels: ["telegram:555"] });
    expect(chatData((await r.store.get(CHAT_TYPE, id))?.data ?? {}).channels).toEqual(["telegram:555"]);
    await expect(r.open(DEFAULT_BOT, { channels: ["slack:1"] })).rejects.toThrow(/channels/);
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

describe("a bot chat's access level", () => {
  test("full runs a heredoc and a substitution; edits asks; deny and ask rules still hold", async () => {
    const r = await rig({ reader: {} });
    await syncBots(r.store, r.home, {});
    const id = await r.open("reader");
    await r.act("chat", id, "chat/access", { level: "full" });
    await r.say(id, "run it");
    await r.reply(id);
    const full = accessOf(r.calls[0]?.access);
    const cwd = String(r.calls[0]?.cwd);
    const unreadable = ["python3 - <<'PY'\nprint(1)\nPY", "echo $(git rev-parse HEAD)"];
    for (const command of unreadable) {
      expect(match(full, { tool: "bash", input: { command }, cwd }, { home: r.home })).toEqual({ allow: true });
    }
    const denied = match(
      full,
      { tool: "read", input: { path: join(r.home, "store", "log.sqlite") }, cwd },
      { home: r.home },
    );
    expect(denied.allow).toBe(false);
    expect(denied.ask).toBeUndefined();
    expect(match(full, { tool: "bash", input: { command: "git push origin main" }, cwd }, { home: r.home })).toMatchObject({
      allow: false,
      ask: true,
    });

    await r.act("chat", id, "chat/access", { level: "edits" });
    await r.say(id, "run it again");
    await r.reply(id);
    const edits = accessOf(r.calls[1]?.access);
    for (const command of unreadable) {
      expect(match(edits, { tool: "bash", input: { command }, cwd }, { home: r.home })).toMatchObject({
        allow: false,
        ask: true,
      });
    }
  });

  test("/access edits writes in the bot's own directory, and opens no worktree", async () => {
    const r = await rig({ reader: {} });
    await syncBots(r.store, r.home, {});
    const id = await r.open("reader");
    const before = chatData((await r.store.get(CHAT_TYPE, id))?.data ?? {});
    expect(before.accessAction).toBeUndefined();

    await r.act("chat", id, "chat/access", { level: "edits" });
    const changed = chatData((await r.store.get(CHAT_TYPE, id))?.data ?? {});
    expect(changed.cwd).toBe(before.cwd);
    expect(changed.accessLevel).toBe("edits");
    expect(changed.accessAction).toBeUndefined();

    await r.say(id, "write a note");
    expect((await r.reply(id)).result).toBe("done");
    expect(r.calls[0]?.cwd).toBe(before.cwd);
    const access = accessOf(r.calls[0]?.access);
    expect(access.level).toBe("edits");
    expect(match(access, { tool: "write", input: { path: join(changed.cwd, "note.md") }, cwd: changed.cwd }, { home: r.home }).allow).toBe(true);
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

  test("the own-settings switch is off by default and reaches the agent when on", async () => {
    const r = await rig({ reader: {} });
    await syncBots(r.store, r.home, {});
    const id = await r.open("reader");
    await r.say(id, "one");
    await r.reply(id);
    expect(r.calls[0]?.params.useOwnSettings).toBeUndefined();

    writeConfig(r.home, { reader: { useOwnSettings: true } });
    await r.say(id, "two");
    await r.reply(id);
    expect(r.calls[1]?.params.useOwnSettings).toBe(true);
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
    expect(String(result.data?.message)).toContain(join(r.root, "nothing"));
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

  test("a bot whose agent is pi is unchanged: the switch is absent unless the bot sets it", async () => {
    const r = await rig({ reader: { harness: "pi" } });
    await syncBots(r.store, r.home, {});
    const id = await r.open("reader");
    await r.say(id, "hi");
    const result = await r.reply(id);
    expect(result.result).toBe("done");
    expect(r.calls[0]?.params.useOwnSettings).toBeUndefined();
  });

  test("a bot whose agent is pi passes the own-settings switch on", async () => {
    const r = await rig({ reader: { harness: "pi", useOwnSettings: true } });
    await syncBots(r.store, r.home, {});
    const id = await r.open("reader");
    await r.say(id, "hi");
    const result = await r.reply(id);
    expect(result.result).toBe("done");
    expect(r.calls[0]?.params.useOwnSettings).toBe(true);
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
