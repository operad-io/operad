import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createViews } from "@operad-io/engine";
import { allMessages, CHAT_TYPE, chatData, chatRef, COMMAND_FACT, commandOfFact } from "../src/index.ts";
import { cleanupRoots, reply, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;

/** Writes one skill under the test's own directory and returns that directory. */
function skill(r: Rig, name: string, description: string, body: string): string {
  const directory = join(r.root, "skills", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
  );
  return directory;
}

async function setSkills(r: Rig, chat: string, skills: readonly string[]): Promise<void> {
  const object = await r.store.get(CHAT_TYPE, chat);
  if (object === undefined) throw new Error("no chat");
  await r.store.put(CHAT_TYPE, chat, { ...object.data, skills: [...skills] }, "test");
}

async function send(r: Rig, chat: string, note: string) {
  const object = await r.store.get(CHAT_TYPE, chat);
  if (object === undefined) throw new Error("no chat");
  return r.registry.runAction("chat/send", { note }, {
    object: { type: CHAT_TYPE, id: chat, data: object.data },
    actor: { via: "cli", id: "me" },
  });
}

function commandFacts(r: Rig, chat: string) {
  return r.store
    .facts(chatRef(chat))
    .facts.map(commandOfFact)
    .filter((command) => command !== undefined);
}

describe("a chat's skills", () => {
  test("a bot chat lists its bot's skills with their descriptions, in a stable order", async () => {
    const r = await rig(() => reply("x"));
    const one = skill(r, "first", "The first skill.", "First body.");
    const two = skill(r, "second", "The second skill.", "Second body.");
    await r.store.put("bot", "default", { skills: [two, one] }, "test");
    const chat = await r.chat({ parent: "bot:default" });

    const views = createViews({ registry: r.registry, store: r.store, onLog: () => undefined });
    try {
      const first = await views.get(chat);
      const again = await views.get(chat);
      const expected = [
        { name: "second", description: "The second skill." },
        { name: "first", description: "The first skill." },
      ];
      expect(first.skills).toEqual(expected);
      expect(again.skills).toEqual(expected);
      // The same request already carries the commands.
      expect(first.actions.some((action) => action.command !== undefined)).toBe(true);
    } finally {
      views.close();
    }
  });

  test("a chat without a parent lists the skills it is given", async () => {
    const r = await rig(() => reply("x"));
    const writing = skill(r, "writing", "Write clearly.", "Use short sentences.");
    const chat = await r.chat();
    await setSkills(r, chat, [writing]);
    const views = createViews({ registry: r.registry, store: r.store, onLog: () => undefined });
    try {
      expect((await views.get(chat)).skills).toEqual([
        { name: "writing", description: "Write clearly." },
      ]);
    } finally {
      views.close();
    }
  });

  test("a long description is cut at the same cap as the harness prompt", async () => {
    const r = await rig(() => reply("x"));
    const long = "x".repeat(200);
    const wordy = skill(r, "wordy", long, "Body.");
    const chat = await r.chat();
    await setSkills(r, chat, [wordy]);
    const views = createViews({ registry: r.registry, store: r.store, onLog: () => undefined });
    try {
      const [shown] = (await views.get(chat)).skills ?? [];
      expect(shown?.description).toBe(`${"x".repeat(160)}...`);
    } finally {
      views.close();
    }
  });

  test("a harness that loads skills itself gets `/name rest` unchanged", async () => {
    const r = await rig(
      () => reply("done"),
      undefined,
      undefined,
      "fake",
      [],
      { loadsSkills: true },
    );
    const demo = skill(r, "demo", "A demo skill.", "Do the demo carefully.");
    const chat = await r.chat();
    await setSkills(r, chat, [demo]);

    await send(r, chat, "/demo fast");
    expect((await r.round(chat)).result).toBe("done");
    expect(r.calls[0]?.params.prompt).toBe("/demo fast");
    // The recorded message is what the person typed, not what the agent got.
    expect(allMessages(r.store, chat).filter((message) => message.role === "user").map((message) => message.text)).toEqual(["/demo fast"]);
  });

  test("a harness that does not load skills gets the skill body and then the rest", async () => {
    const r = await rig(() => reply("done"));
    const demo = skill(r, "demo", "A demo skill.", "Do the demo carefully.");
    const chat = await r.chat();
    await setSkills(r, chat, [demo]);

    await send(r, chat, "/demo fast");
    expect((await r.round(chat)).result).toBe("done");
    const prompt = String(r.calls[0]?.params.prompt);
    expect(prompt).toContain('The skill "demo" follows.');
    expect(prompt).toContain("Do the demo carefully.");
    expect(prompt).toContain("fast");
    expect(prompt.indexOf("Do the demo carefully.")).toBeLessThan(prompt.indexOf("fast"));
    expect(allMessages(r.store, chat).filter((message) => message.role === "user").map((message) => message.text)).toEqual(["/demo fast"]);
  });

  test("an operad command of the same name wins, so the skill does not shadow it", async () => {
    const models = { list: ["small", "large"], default: "small" } as const;
    const r = await rig(() => reply("x"), models);
    const command = skill(r, "model", "A skill that shares a command name.", "Not a command.");
    const chat = await r.chat({ model: "small" });
    await setSkills(r, chat, [command]);

    const sent = await send(r, chat, "/model large");
    expect(sent.value).toContain("large");
    expect(allMessages(r.store, chat)).toEqual([]);
    expect(r.events).toEqual([]);
    expect(r.calls).toEqual([]);
    expect(commandFacts(r, chat)).toHaveLength(1);
    expect(chatData((await r.store.get(CHAT_TYPE, chat))?.data ?? {}).model).toBe("large");
  });

  test("`/help` lists the skills after the commands, marked as skills", async () => {
    const models = { list: ["small", "large"], default: "small" } as const;
    const r = await rig(() => reply("x"), models);
    const writing = skill(r, "writing", "Write clearly.", "Use short sentences.");
    const shadowed = skill(r, "model", "A skill a command shadows.", "Never shown by /help.");
    const chat = await r.chat({ model: "small" });
    await setSkills(r, chat, [writing, shadowed]);

    const help = String((await send(r, chat, "/help")).value);
    expect(help).toContain("Skills:");
    expect(help).toContain("`/writing` — skill: Write clearly.");
    expect(help).not.toContain("`/model` — skill");
    expect(help.indexOf("`/help`")).toBeLessThan(help.indexOf("`/writing`"));
  });
});
