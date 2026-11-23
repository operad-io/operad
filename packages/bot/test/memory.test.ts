import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { memoryGit } from "@operad-io/memory";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { match } from "@operad-io/access-match";
import { MEMORY_INDEX_MAX, MEMORY_SKILL_DIR, createMemoryPlugin } from "@operad-io/memory";
import { readBots, resolveBot } from "../src/index.ts";
import { cleanupRoots, rig, writePlugins } from "./support.ts";

afterAll(cleanupRoots);

const USER_HOME = "/Users/someone";

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bot-memory-"));
  roots.push(root);
  return join(root, "home");
}

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function verdict(profile: Record<string, unknown>, tool: "read" | "write", path: string, cwd: string) {
  return match(profile as never, { tool, input: { path, content: "x" }, cwd }, { home: USER_HOME });
}

describe("who may write the wiki", () => {
  test("the default bot writes it and every other bot only reads it", async () => {
    const h = await home();
    writePlugins(h, { memory: {}, bot: { settings: { bots: { default: {}, reader: {} } } } });
    const bots = readBots(h);
    const wiki = join(h, "wiki");
    const reader = resolveBot(h, "reader", bots["reader"] ?? {});
    const owner = resolveBot(h, "default", bots["default"] ?? {});
    expect(reader.writeWiki).toBe(false);
    expect(owner.writeWiki).toBe(true);

    expect(verdict(reader.access, "read", join(wiki, "note.md"), reader.cwd).allow).toBe(true);
    expect(verdict(reader.access, "write", join(wiki, "note.md"), reader.cwd).allow).toBe(false);
    expect(verdict(owner.access, "write", join(wiki, "note.md"), owner.cwd).allow).toBe(true);
  });

  test("a bot's writeWiki setting decides for that bot", async () => {
    const h = await home();
    writePlugins(h, { memory: {}, bot: { settings: { bots: { default: { writeWiki: false }, reader: { writeWiki: true } } } } });
    const bots = readBots(h);
    const wiki = join(h, "wiki");
    const turnedOff = resolveBot(h, "default", bots["default"] ?? {});
    const turnedOn = resolveBot(h, "reader", bots["reader"] ?? {});
    expect(turnedOff.writeWiki).toBe(false);
    expect(turnedOn.writeWiki).toBe(true);
    expect(verdict(turnedOff.access, "write", join(wiki, "note.md"), turnedOff.cwd).allow).toBe(false);
    expect(verdict(turnedOn.access, "write", join(wiki, "note.md"), turnedOn.cwd).allow).toBe(true);
  });

  test("a wiki outside the operad home is read by every bot and written by the ones allowed", async () => {
    const h = await home();
    const vault = join(h, "..", "vault");
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, "note.md"), "mine\n");
    writePlugins(h, { memory: { settings: { wikiDir: vault } }, bot: { settings: { bots: { default: {}, reader: {} } } } });
    const bots = readBots(h);
    const reader = resolveBot(h, "reader", bots["reader"] ?? {});
    const owner = resolveBot(h, "default", bots["default"] ?? {});
    expect(verdict(reader.access, "read", join(vault, "note.md"), reader.cwd).allow).toBe(true);
    expect(verdict(reader.access, "write", join(vault, "note.md"), reader.cwd).allow).toBe(false);
    expect(verdict(owner.access, "write", join(vault, "note.md"), owner.cwd).allow).toBe(true);
  });

  test("without the memory plugin the wiki is still only read, but no memory skill is mounted", async () => {
    const r = await rig({ default: {} });
    const bot = resolveBot(r.home, "reader", {});
    expect(verdict(bot.access, "read", join(r.home, "wiki", "note.md"), bot.cwd).allow).toBe(true);
    expect(verdict(bot.access, "write", join(r.home, "wiki", "note.md"), bot.cwd).allow).toBe(false);
    expect(bot.skills).not.toContain(MEMORY_SKILL_DIR);
  });
});

describe("the memory skill and the commit step", () => {
  test("every bot mounts the memory skill while the plugin is enabled", async () => {
    const r = await rig({ default: {} }, ["pi"], undefined, [createMemoryPlugin()]);
    writePlugins(r.home, { memory: {}, bot: { settings: { bots: { default: {} } } } });
    const chat = await r.open("default");
    await r.say(chat, "hi");
    await r.reply(chat);
    expect(r.calls[0]?.params.skills).toContain(MEMORY_SKILL_DIR);
  });

  test("a bot's memory gets the three-layer layout when the plugin is enabled", async () => {
    const h = await home();
    writePlugins(h, { memory: {}, bot: { settings: { bots: { default: {}, reader: {} } } } });
    const bots = readBots(h);
    const bot = resolveBot(h, "reader", bots["reader"] ?? {});
    const memory = join(bot.cwd, "memory");
    expect(existsSync(join(memory, "index.md"))).toBe(true);
    expect(existsSync(join(memory, "instructions.md"))).toBe(true);
    expect(existsSync(join(memory, "log"))).toBe(true);
  });

  test("a reply that wrote to the bot's memory is committed, naming the bot and the chat", async () => {
    const r = await rig({ default: {} }, ["pi"], undefined, [createMemoryPlugin()]);
    writePlugins(r.home, { memory: {}, bot: { settings: { bots: { default: {} } } } });
    const chat = await r.open("default");
    const memory = join(r.home, "bot", "default", "memory");
    mkdirSync(join(memory, "topics"), { recursive: true });
    writeFileSync(join(memory, "topics", "rule.md"), "a rule a person verified\n");
    await r.say(chat, "hi");
    await r.reply(chat);
    expect(memoryGit(memory, ["log", "--format=%s"]).out).toBe(`memory: bot default, chat ${chat}`);
  });

  test("the bot's settings name the commit step only when the memory plugin is loaded", async () => {
    const withMemory = await rig({ default: {} }, ["pi"], undefined, [createMemoryPlugin()]);
    writePlugins(withMemory.home, { memory: {}, bot: { settings: { bots: { default: {} } } } });
    const chat = await withMemory.open("default");
    const stored = await withMemory.store.get("chat", chat);
    const settings = await withMemory.registry.runStep("bot/settings", { chat }, {
      runId: "run-1",
      ...(stored === undefined ? {} : { object: { type: "chat", id: chat, data: stored.data } }),
      params: null,
    });
    expect((settings.data as Record<string, unknown>)["after"]).toBe("memory/commit");

    const without = await rig({ default: {} }, ["pi"]);
    writePlugins(without.home, { memory: {}, bot: { settings: { bots: { default: {} } } } });
    const plain = await without.open("default");
    const plainStored = await without.store.get("chat", plain);
    const plainSettings = await without.registry.runStep("bot/settings", { chat: plain }, {
      runId: "run-1",
      ...(plainStored === undefined ? {} : { object: { type: "chat", id: plain, data: plainStored.data } }),
      params: null,
    });
    expect((plainSettings.data as Record<string, unknown>)["after"]).toBeUndefined();
  });
});

describe("the memory notes a bot chat carries", () => {
  test("its index and instructions go on the message, never into the chat's own text", async () => {
    const r = await rig({ default: {} }, ["pi"], undefined, [createMemoryPlugin()]);
    writePlugins(r.home, { memory: {}, bot: { settings: { bots: { default: {} } } } });
    const chat = await r.open("default");
    const memory = join(r.home, "bot", "default", "memory");
    writeFileSync(join(memory, "index.md"), "INDEX FOR THE FIRST REPLY\n");
    writeFileSync(join(memory, "instructions.md"), "THE PERSON'S RULES\n");
    await r.say(chat, "hi");
    await r.reply(chat);

    const prompt = String(r.calls[0]?.params.prompt);
    expect(prompt).toContain("[memory/index.md]\nINDEX FOR THE FIRST REPLY");
    expect(prompt).toContain("[memory/instructions.md]\nTHE PERSON'S RULES");
    // The message the person sent stays as it was; the notes are not in it.
    const said = r.store.facts().flatMap((fact) => (fact.type === "chat.message" ? [String(fact.data.text)] : []));
    expect(said.join("\n")).not.toContain("INDEX FOR THE FIRST REPLY");
  });

  test("a change made elsewhere is sent whole on the next reply, once", async () => {
    const r = await rig({ default: {} }, ["pi"], undefined, [createMemoryPlugin()]);
    writePlugins(r.home, { memory: {}, bot: { settings: { bots: { default: {} } } } });
    const chat = await r.open("default");
    const memory = join(r.home, "bot", "default", "memory");
    writeFileSync(join(memory, "index.md"), "INDEX ONE\n");
    await r.say(chat, "first");
    await r.reply(chat);

    writeFileSync(join(memory, "index.md"), "INDEX TWO\n");
    await r.say(chat, "second");
    await r.reply(chat);
    const second = String(r.calls[1]?.params.prompt);
    expect(second).toContain("[memory/index.md]\nINDEX TWO");
    expect(second).not.toContain("INDEX ONE");

    await r.say(chat, "third");
    await r.reply(chat);
    expect(r.calls[2]?.params.prompt).toBe("third");
  });

  test("every agent's bot chat carries the notes", async () => {
    for (const agent of ["claude", "pi", "codex", "radian"]) {
      const r = await rig({ default: {} }, ["claude", "pi", "codex", "radian"], undefined, [createMemoryPlugin()]);
      writePlugins(r.home, { memory: {}, bot: { settings: { bots: { default: {} } } } });
      const chat = await r.open("default", { agent });
      const memory = join(r.home, "bot", "default", "memory");
      writeFileSync(join(memory, "index.md"), `INDEX FOR ${agent}\n`);
      await r.say(chat, "hi");
      await r.reply(chat);
      expect(String(r.calls[0]?.params.prompt)).toContain(`[memory/index.md]\nINDEX FOR ${agent}`);
    }
  });

  test("a long index is cut at the memory plugin's limit", async () => {
    const r = await rig({ default: {} }, ["pi"], undefined, [createMemoryPlugin()]);
    writePlugins(r.home, { memory: {}, bot: { settings: { bots: { default: {} } } } });
    const chat = await r.open("default");
    const memory = join(r.home, "bot", "default", "memory");
    writeFileSync(join(memory, "index.md"), `INDEX${"x".repeat(MEMORY_INDEX_MAX + 100)}`);
    await r.say(chat, "hi");
    await r.reply(chat);
    const prompt = String(r.calls[0]?.params.prompt);
    expect(prompt).toContain("[memory/index.md was cut at 8000 characters.]");
  });
});
