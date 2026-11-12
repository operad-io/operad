import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { match, readProfile, type AccessProfile } from "@operad-io/access-match";
import { CHAT_TYPE, chatData } from "@operad-io/chat";
import { createViews } from "@operad-io/engine";
import {
  PROPOSAL_TYPE,
  proposalData,
  syncBots,
} from "../src/index.ts";
import { cleanupRoots, rig, writeConfig } from "./support.ts";

afterAll(cleanupRoots);

function accessOf(value: unknown): AccessProfile {
  const read = readProfile(value);
  if (!read.ok) throw new Error(read.message);
  return read.profile;
}

function skillInput(skillMd: string, files: Record<string, string> = {}): string {
  return JSON.stringify({ skill_md: skillMd, files });
}

function botConfig(home: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
    plugins: { bot: { settings: { bots: Record<string, unknown> } } };
  };
  return parsed.plugins.bot.settings.bots;
}

describe("a bot proposes a skill", () => {
  test("it is one pending item, shows SKILL.md and the files with scripts apart, and applies at the next reply", async () => {
    const r = await rig();
    const said = await r.command(
      "bot",
      "skill",
      ["default", "brain"],
      skillInput("---\nname: brain\n---\nWrite notes.\n", {
        "guide.md": "How to write notes.\n",
        "scripts/save.sh": "echo saved\n",
      }),
    );
    expect(String(said)).toContain('proposed skill "brain"');

    const items = await r.registry.standing();
    expect(items).toHaveLength(1);
    expect(items[0]?.actions).toEqual([
      { plugin: "bot", action: "review" },
      { plugin: "bot", action: "approve" },
      { plugin: "bot", action: "reject" },
    ]);
    const id = items[0]?.object?.id;
    if (id === undefined) throw new Error("no proposal item");
    const proposal = await r.store.get(PROPOSAL_TYPE, id);
    expect(proposal === undefined ? undefined : proposalData(proposal).state).toBe("pending");

    const views = createViews({ registry: r.registry, store: r.store, onLog: () => undefined });
    try {
      const review = await views.section(`${PROPOSAL_TYPE}:${id}`, "review", undefined, { full: true });
      expect(review.markdown).toContain("---\nname: brain");
      expect(review.markdown).toContain("Write notes.");
      expect(review.markdown).toContain("- guide.md");
      expect(review.markdown).toContain("### Scripts");
      expect(review.markdown).toContain("- scripts/save.sh");
      // Not in the section's other files.
      const fileList = review.markdown.slice(review.markdown.indexOf("### Files"), review.markdown.indexOf("### Scripts"));
      expect(fileList).not.toContain("scripts/save.sh");
    } finally {
      views.close();
    }

    const target = join(r.home, "bot", "skills", "brain");
    expect(existsSync(join(target, "SKILL.md"))).toBe(false);
    expect(botConfig(r.home).default).toBeUndefined();

    // A proposal nobody answers does not block the chat and changes nothing.
    const chat = await r.open("default");
    await r.say(chat, "hello");
    expect((await r.reply(chat)).result).toBe("done");
    expect(r.calls[0]?.params.skills).toBeUndefined();
    expect(existsSync(join(target, "SKILL.md"))).toBe(false);

    await r.act(PROPOSAL_TYPE, id, "bot/approve");
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toContain("Write notes.");
    expect(readFileSync(join(target, "scripts", "save.sh"), "utf8")).toBe("echo saved\n");
    expect(JSON.stringify(botConfig(r.home).default)).toContain(target);
    expect(await r.registry.standing()).toEqual([]);

    await r.say(chat, "again");
    expect((await r.reply(chat)).result).toBe("done");
    expect(r.calls[1]?.params.skills).toEqual([target]);
  });

  test("a run nobody started on the spot can only propose; its change waits for a person", async () => {
    const r = await rig();
    await r.command(
      "bot",
      "skill",
      ["default", "digest"],
      skillInput("---\nname: digest\n---\nCollect the day.\n"),
    );
    const target = join(r.home, "bot", "skills", "digest", "SKILL.md");
    expect(existsSync(target)).toBe(false);
    expect((await r.registry.standing()).map((item) => item.id)).toHaveLength(1);
    // Reading the item or opening a chat applies nothing.
    const chat = await r.open("default");
    await r.say(chat, "where is it?");
    await r.reply(chat);
    expect(existsSync(target)).toBe(false);
    expect(await r.registry.standing()).toHaveLength(1);
  });

  test("a changed skill shows its diff, and reject leaves the old files alone", async () => {
    const r = await rig();
    const skill = join(r.root, "brain");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: brain\n---\nold text\n");
    writeFileSync(join(skill, "old.md"), "keep me\n");
    writeConfig(r.home, { reader: { skills: [skill] } });
    await syncBots(r.store, r.home, { bots: { reader: { skills: [skill] } } });

    await r.command(
      "bot",
      "skill",
      ["reader", "brain"],
      skillInput("---\nname: brain\n---\nnew text\n", { "new.md": "added\n" }),
    );
    const item = (await r.registry.standing())[0];
    const id = item?.object?.id;
    if (id === undefined) throw new Error("no proposal item");
    const views = createViews({ registry: r.registry, store: r.store, onLog: () => undefined });
    try {
      const review = await views.section(`${PROPOSAL_TYPE}:${id}`, "review", undefined, { full: true });
      expect(review.markdown).toContain("### Diff");
      expect(review.markdown).toContain("-old text");
      expect(review.markdown).toContain("+new text");
      expect(review.markdown).toContain("### new.md");
      expect(review.markdown).toContain("+added");
    } finally {
      views.close();
    }

    await r.act(PROPOSAL_TYPE, id, "bot/reject");
    expect(readFileSync(join(skill, "SKILL.md"), "utf8")).toContain("old text");
    expect(existsSync(join(skill, "new.md"))).toBe(false);
    expect(existsSync(join(skill, "old.md"))).toBe(true);
    expect(await r.registry.standing()).toEqual([]);
  });
});

describe("a bot proposes settings", () => {
  test("the item shows before and after; approve applies them at the next reply; reject leaves them", async () => {
    const r = await rig();
    await r.command(
      "bot",
      "setting",
      ["default"],
      JSON.stringify({ speaker: "Nova", access: { denyPaths: ["~/private"] } }),
    );
    const item = (await r.registry.standing())[0];
    const id = item?.object?.id;
    if (id === undefined) throw new Error("no proposal item");
    const views = createViews({ registry: r.registry, store: r.store, onLog: () => undefined });
    try {
      const review = await views.section(`${PROPOSAL_TYPE}:${id}`, "review", undefined, { full: true });
      expect(review.markdown).toContain("### Before");
      expect(review.markdown).toContain("### After");
      expect(review.markdown).toContain('"speaker": "Nova"');
      expect(review.markdown).toContain("~/private");
    } finally {
      views.close();
    }

    const chat = await r.open("default");
    await r.say(chat, "one");
    await r.reply(chat);
    expect(accessOf(r.calls[0]?.access).denyPaths).not.toContain("~/private");

    await r.act(PROPOSAL_TYPE, id, "bot/approve");
    expect((botConfig(r.home).default as { speaker?: string; access?: { denyPaths?: string[] } }).speaker).toBe("Nova");
    expect((await r.store.get(CHAT_TYPE, chat))?.data.speaker).toBeUndefined();
    await r.say(chat, "two");
    await r.reply(chat);
    expect(accessOf(r.calls[1]?.access).denyPaths).toContain("~/private");

    await r.command("bot", "setting", ["default"], JSON.stringify({ speaker: "Other" }));
    const second = (await r.registry.standing())[0]?.object?.id;
    if (second === undefined) throw new Error("no second proposal");
    await r.act(PROPOSAL_TYPE, second, "bot/reject");
    expect((botConfig(r.home).default as { speaker?: string }).speaker).toBe("Nova");
  });

  test("a setting proposal that does not fit the schema is refused and makes no item", async () => {
    const r = await rig();
    await expect(
      r.command("bot", "setting", ["default"], JSON.stringify({ speaker: "" })),
    ).rejects.toThrow();
    expect(await r.registry.standing()).toEqual([]);
    expect(botConfig(r.home).default).toBeUndefined();
  });
});

describe("a direct write to what the bot changes itself is refused", () => {
  test("the skill directories and config.json are outside the bot's write access", async () => {
    const r = await rig();
    const skill = join(r.root, "brain");
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
    for (const path of [
      join(skill, "SKILL.md"),
      join(cwd, "skills", "new", "SKILL.md"),
      join(r.home, "config.json"),
    ]) {
      expect(match(access, { tool: "write", input: { path }, cwd }, { home }).allow).toBe(false);
      expect(match(access, { tool: "edit", input: { path }, cwd }, { home }).allow).toBe(false);
    }
    expect(
      match(access, { tool: "bash", input: { command: `printf x > ${join(skill, "SKILL.md")}` }, cwd }, { home }).allow,
    ).toBe(false);
  });
});
