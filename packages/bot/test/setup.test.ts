import { afterAll, describe, expect, test } from "bun:test";
import { definePlugin } from "@operad-io/engine";
import { chatSetupAction, setupTitle } from "../src/index.ts";
import { cleanupRoots, rig } from "./support.ts";

afterAll(cleanupRoots);

type Rig = Awaited<ReturnType<typeof rig>>;

/** A plugin that is set up: its check reports nothing missing. */
function ready() {
  return definePlugin({
    name: "ready",
    kind: "domain",
    version: "0.0.0",
    guide: `${import.meta.dir}/../../engine/test/fixtures/plugins/guided/SKILL.md`,
    check: () => ({ missing: [] }),
  });
}

async function firstMessage(r: Rig, chat: string): Promise<string> {
  const texts = (await r.store.facts().filter((fact) => fact.object?.id === chat && fact.type === "chat.message")).map(
    (fact) => String((fact.data as { text?: unknown }).text),
  );
  return texts[0] ?? "";
}

describe("Setup <plugin> (ADR 0010 D7)", () => {
  test("every guide is Setup and the plugin's name, capitalised", () => {
    expect(setupTitle("dev")).toBe("Setup Dev");
    expect(setupTitle("telegram")).toBe("Setup Telegram");
  });

  test("the command answers what the check finds missing, then the guide's steps for the target", async () => {
    const r = await rig();
    const text = String(await r.command("bot", "setup", ["default", "dev", "/work/repo"]));
    expect(text).toContain("Setup Dev. What the plugin's own check finds missing now:");
    expect(text).toContain("- repository: no repository is registered with dev");
    expect(text).toContain("Follow only the steps of the guide that fix these items.");
    expect(text).toContain("Set up operad's dev for the repository at /work/repo");
    expect(text).toContain("arguments `default` and `/work/repo`");
    expect(text).not.toContain("{target}");
  });

  test("a plugin with nothing missing and no target gets one sentence and no steps", async () => {
    const r = await rig({}, ["claude", "pi"], undefined, [ready()]);
    const text = String(await r.command("bot", "setup", ["default", "ready"]));
    expect(text).toBe(
      "Setup Ready: nothing is missing, ready is set up. Tell me so and stop unless I ask for something to change.",
    );
  });

  test("a target is worked on even when nothing is missing", async () => {
    const r = await rig({}, ["claude", "pi"], undefined, [ready()]);
    const text = String(await r.command("bot", "setup", ["default", "ready", "x"]));
    expect(text).toContain("nothing (it is set up); the target below still needs its steps");
    expect(text).toContain("Ask the person for the token");
  });

  test("a plugin with no guide, a missing bot and a bad usage are refused", async () => {
    const r = await rig();
    await expect(r.command("bot", "setup", ["default", "chat"])).rejects.toThrow(
      'the plugin "chat" has no setup guide; plugins with one: dev',
    );
    await expect(r.command("bot", "setup", ["nobody", "dev"])).rejects.toThrow('there is no bot "nobody"');
    await expect(r.command("bot", "setup", ["default"])).rejects.toThrow("usage: operad bot setup");
  });

  test("a bot chat's first line says how to set up another plugin", async () => {
    const r = await rig();
    const chat = await r.open("default");
    await r.say(chat, "hello");
    await r.reply(chat);
    const prompt = String(r.calls[0]?.params.prompt ?? "");
    expect(prompt).toContain("Setup <name>");
    expect(prompt).toContain("verb `setup`");
  });

  test("the action opens a chat titled Setup and the name that shows the title and gives the agent the guide", async () => {
    const r = await rig();
    const text = String(await r.act("bot", "default", "setup", { plugin: "dev", target: "/work/repo" }));
    const chat = /C-\d+/.exec(text)?.[0];
    if (chat === undefined) throw new Error(`no chat in ${text}`);
    expect(await firstMessage(r, chat)).toBe("Setup Dev (repo)");
    const sent = (await r.store.facts().filter((fact) => fact.object?.id === chat && fact.type === "chat.message"))
      .map((fact) => String((fact.data as { instruction?: unknown }).instruction))[0] ?? "";
    expect(sent).toContain("Setup Dev. What the plugin's own check finds missing now:");
    expect(sent).toContain("the repository at /work/repo");
    expect((await r.store.get("chat", chat))?.data.title).toBe("Setup Dev (repo)");
    await r.reply(chat);
    expect(String(r.calls[0]?.params.prompt ?? "")).toContain(sent);
  });

  test("/setup in a bot chat sends the guide to that chat, and records the command", async () => {
    const r = await rig();
    const chat = await r.open("default");
    await r.act("chat", chat, "send", { note: "/setup dev /work/repo" });
    const first = await firstMessage(r, chat);
    expect(first).toContain("Setup Dev. What the plugin's own check finds missing now:");
    expect(first).toContain("the repository at /work/repo");
    expect(first).not.toContain("/setup");
  });

  test("/setup names a plugin without a guide in the chat and sends nothing", async () => {
    const r = await rig();
    const chat = await r.open("default");
    await r.act("chat", chat, "send", { note: "/setup chat" });
    expect(await firstMessage(r, chat)).toBe("");
  });

  test("/setup is offered in an open bot chat only", async () => {
    const r = await rig();
    const chat = await r.open("default");
    const bot = (await r.store.get("chat", chat))?.data ?? {};
    const env = { store: r.store, harnesses: [] };
    expect(await chatSetupAction.when(bot, env)).toBe(true);
    expect(await chatSetupAction.when({ ...bot, closed: true }, env)).toBe(false);
    expect(await chatSetupAction.when({ title: "no bot" }, env)).toBe(false);
    const stored = await r.store.get("chat", chat);
    if (stored === undefined) throw new Error("no chat");
    const why = await chatSetupAction.why?.({ ...stored, data: { title: "no bot" } }, env);
    expect(why).toContain("is not a bot chat");
  });
});
