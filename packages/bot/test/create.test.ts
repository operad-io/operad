import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createViews } from "@operad-io/engine";
import {
  createBot,
  knownMcpServers,
  knownSkills,
  readBots,
  resolveBot,
  syncBots,
  type McpServerSettings,
} from "../src/index.ts";
import { cleanupRoots, rig, writeConfig } from "./support.ts";

afterAll(cleanupRoots);

function skillAt(root: string, name: string, title = name): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), `---\nname: ${title}\n---\n`);
  return path;
}

const NOTES: McpServerSettings = {
  command: "npx",
  args: ["-y", "fake-notes@1.2.3"],
  package: "fake-notes",
  version: "1.2.3",
  secrets: ["TOKEN"],
  tools: [{ name: "echo", description: "Say hello back." }],
  digest: "sha256:notes",
};

const CALENDAR: McpServerSettings = {
  command: "npx",
  args: ["-y", "fake-calendar@2.0.0"],
  package: "fake-calendar",
  version: "2.0.0",
  tools: [{ name: "today", description: "Show today." }],
  digest: "sha256:calendar",
};

async function createAction(r: Awaited<ReturnType<typeof rig>>) {
  const views = createViews({ registry: r.registry, store: r.store, onLog: () => undefined });
  try {
    return (await views.get("bot:default")).actions.find((action) => action.name === "bot:create");
  } finally {
    views.close();
  }
}

async function create(r: Awaited<ReturnType<typeof rig>>, args: Record<string, unknown>) {
  return r.registry.runAction("bot/create", args, {
    object: { type: "bot", id: "default", data: (await r.store.get("bot", "default"))?.data ?? {} },
    actor: { via: "cli", id: "me" },
  });
}

describe("bot:create offers what the home already knows", () => {
  test("the skill and server choices are the ones the bots and the standard directory know", async () => {
    const r = await rig();
    const parent = join(r.root, "skills");
    const brain = skillAt(parent, "brain");
    const digest = skillAt(parent, "digest");
    const plan = skillAt(parent, "plan");
    const other = skillAt(join(r.root, "other"), "other");
    const standard = skillAt(join(r.root, "user", ".agents", "skills"), "standard");
    writeConfig(r.home, {
      default: { skills: [parent], mcpServers: { notes: NOTES, calendar: CALENDAR } },
      reader: { skills: [other] },
    });
    await syncBots(r.store, r.home, {});

    expect(knownSkills(r.home, join(r.root, "user")).map((skill) => skill.path).sort()).toEqual(
      [brain, digest, plan, other, standard].sort(),
    );
    expect(knownMcpServers(r.home).map((server) => server.key)).toEqual(["calendar", "notes"]);

    const action = await createAction(r);
    const skills = action?.args?.properties?.skills?.items;
    expect(skills?.oneOf?.[0]?.enum).toEqual(expect.arrayContaining(["brain", "digest", "other", "plan"]));
    expect(action?.args?.properties?.mcpServers?.items?.enum).toEqual(["calendar", "notes"]);
    expect(action?.args?.required).toEqual(["name", "agent"]);
  });
});

describe("creating a bot with chosen skills and MCP servers", () => {
  test("two of three known skills and one of two approved servers are exactly what it gets", async () => {
    const r = await rig();
    const parent = join(r.root, "skills");
    const brain = skillAt(parent, "brain");
    const digest = skillAt(parent, "digest");
    skillAt(parent, "plan");
    const other = skillAt(join(r.root, "other"), "other");
    writeConfig(r.home, {
      default: { skills: [parent], mcpServers: { notes: NOTES, calendar: CALENDAR } },
      reader: { skills: [other] },
    });
    await syncBots(r.store, r.home, {});

    const run = await create(r, {
      name: "chosen",
      agent: "pi",
      model: "pi-b",
      effort: "pi-low",
      speaker: "Nova",
      skills: ["brain", "digest"],
      mcpServers: ["notes"],
    });

    expect(run.value).toContain('created bot "chosen"');
    expect(run.opens).toBe("bot:chosen");
    expect(readBots(r.home).chosen).toEqual({
      harness: "pi",
      model: "pi-b",
      effort: "pi-low",
      speaker: "Nova",
      skills: [brain, digest],
      mcpServers: { notes: NOTES },
    });
    const bot = resolveBot(r.home, "chosen", readBots(r.home).chosen ?? {});
    expect(bot.skills).toEqual([brain, digest]);
    expect(Object.keys(bot.mcpServers)).toEqual(["notes"]);
    expect(bot.harness).toBe("pi");
    expect(bot.speaker).toBe("Nova");
    expect((await r.store.get("bot", "chosen"))?.data.skills).toEqual([brain, digest]);

    const views = createViews({ registry: r.registry, store: r.store, onLog: () => undefined });
    try {
      const page = await views.section("bot:chosen", "bot", undefined, { full: true });
      expect(page.markdown).toContain("Skills: brain, digest");
      expect(page.markdown).not.toContain("plan");
      expect(page.markdown).toContain("MCP servers: notes");
    } finally {
      views.close();
    }
  });

  test("nothing chosen means no skills and no servers, and nothing comes from default", async () => {
    const r = await rig();
    const parent = join(r.root, "skills");
    skillAt(parent, "brain");
    writeConfig(r.home, {
      default: { harness: "pi", skills: [parent], mcpServers: { notes: NOTES }, mcpAllow: ["notes.echo"] },
    });
    await syncBots(r.store, r.home, {});

    await create(r, { name: "bare", agent: "claude" });
    const settings = readBots(r.home).bare ?? {};
    expect(settings).toEqual({ harness: "claude" });
    const bot = resolveBot(r.home, "bare", settings);
    expect(bot.skills).toEqual([]);
    expect(bot.mcpServers).toEqual({});
    expect(bot.model).toBeNull();
    expect(bot.effort).toBeNull();
    expect(bot.speaker).toBeNull();

    const page = await (async () => {
      const views = createViews({ registry: r.registry, store: r.store, onLog: () => undefined });
      try {
        return await views.section("bot:bare", "bot", undefined, { full: true });
      } finally {
        views.close();
      }
    })();
    expect(page.markdown).toContain("No skills.");
    expect(page.markdown).not.toContain("MCP servers:");
  });

  test("a copied server keeps its pin, tools and digest, and starts without a new approval", async () => {
    const r = await rig({}, ["claude", "pi"]);
    writeConfig(r.home, { default: { mcpServers: { notes: NOTES, calendar: CALENDAR } } });
    await syncBots(r.store, r.home, {});

    await create(r, { name: "copy", agent: "claude", mcpServers: ["notes"] });
    const copied = readBots(r.home).copy?.mcpServers?.notes;
    expect(copied).toEqual(NOTES);
    expect(copied?.version).toBe("1.2.3");
    expect(copied?.digest).toBe("sha256:notes");
    expect(await r.registry.standing()).toEqual([]);

    const chat = await r.open("copy", { agent: "claude" });
    await r.say(chat, "hi");
    await r.reply(chat);
    const mounted = r.calls[0]?.params.mcpServers;
    expect(mounted !== null && typeof mounted === "object" && !Array.isArray(mounted) ? Object.keys(mounted) : []).toEqual([
      "notes",
    ]);
  });

  test("the result names the secrets the copied servers need", async () => {
    const r = await rig();
    const needs: McpServerSettings = { ...NOTES, secrets: ["TOKEN", "API_KEY"] };
    writeConfig(r.home, { default: { mcpServers: { notes: needs } } });
    await syncBots(r.store, r.home, {});

    const run = await create(r, { name: "secretive", agent: "claude", mcpServers: ["notes"] });
    expect(String(run.value)).toContain("notes.TOKEN");
    expect(String(run.value)).toContain("notes.API_KEY");
    expect(String(run.value)).toContain("operad secret set bot notes.TOKEN");
  });

  test("a path may be given instead of a known skill, and the path stays the setting", async () => {
    const r = await rig();
    const parent = join(r.root, "chosen");
    const first = skillAt(parent, "first");
    const second = skillAt(parent, "second");

    await create(r, { name: "from-path", agent: "claude", skills: [parent] });
    const settings = readBots(r.home)["from-path"] ?? {};
    expect(settings.skills).toEqual([parent]);
    expect(resolveBot(r.home, "from-path", settings).skills).toEqual([first, second].sort());
  });
});

describe("refusals while creating a bot", () => {
  test("a server that was never approved is refused and nothing is written", async () => {
    const r = await rig();
    writeConfig(r.home, { default: { mcpServers: { notes: NOTES } } });
    await syncBots(r.store, r.home, {});
    await expect(create(r, { name: "odd", agent: "claude", mcpServers: ["calendar"] })).rejects.toThrow(/calendar/);
    expect(readBots(r.home).odd).toBeUndefined();
    await expect(
      createBot(r.store, r.home, { name: "odd", agent: "claude", mcpServers: ["calendar"] }),
    ).rejects.toThrow("is not approved on another bot");
  });

  test("a duplicate or bad name is refused and the existing bot is unchanged", async () => {
    const r = await rig({ reader: { harness: "pi" } });
    await expect(create(r, { name: "reader", agent: "claude" })).rejects.toThrow('there is already a bot "reader"');
    expect(readBots(r.home).reader).toEqual({ harness: "pi" });
    await expect(create(r, { name: "default", agent: "claude" })).rejects.toThrow('there is already a bot "default"');
    await expect(create(r, { name: "Bad", agent: "claude" })).rejects.toThrow(/name is lowercase letters/);
    await expect(createBot(r.store, r.home, { name: "../escape", agent: "claude" })).rejects.toThrow(
      /name is lowercase letters/,
    );
    expect(readBots(r.home)["../escape"]).toBeUndefined();
  });

  test("a skill path without a SKILL.md is refused", async () => {
    const r = await rig();
    await expect(create(r, { name: "broken", agent: "claude", skills: [join(r.root, "nothing")] })).rejects.toThrow(
      "there is no SKILL.md",
    );
    expect(readBots(r.home).broken).toBeUndefined();
  });

  test("a model or effort the chosen agent does not list is refused by name", async () => {
    const r = await rig();
    await expect(create(r, { name: "wrong-model", agent: "pi", model: "claude-a" })).rejects.toThrow("claude-a");
    await expect(create(r, { name: "wrong-effort", agent: "pi", effort: "claude-low" })).rejects.toThrow("claude-low");
    expect(readBots(r.home)["wrong-model"]).toBeUndefined();
    expect(readBots(r.home)["wrong-effort"]).toBeUndefined();
  });
});
