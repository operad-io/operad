import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { match, readProfile, type AccessProfile } from "@operad-io/access-match";
import { CHAT_TYPE, chatData } from "@operad-io/chat";
import { createViews } from "@operad-io/engine";
import {
  ASSISTANT_SETTINGS,
  DEFAULT_PROFILE,
  ProfileError,
  defaultAccess,
  readProfiles,
  resolveProfile,
  syncProfiles,
} from "../src/index.ts";
import { cleanupRoots, rig, writeConfig } from "./support.ts";

afterAll(cleanupRoots);

function accessOf(value: unknown): AccessProfile {
  const read = readProfile(value);
  if (!read.ok) throw new Error(read.message);
  return read.profile;
}

describe("profiles", () => {
  test("the default profile exists without being written, with its own directory", async () => {
    const r = await rig();
    expect(Object.keys(readProfiles(r.home, {}))).toEqual([DEFAULT_PROFILE]);
    const profile = resolveProfile(r.home, DEFAULT_PROFILE, {});
    expect(profile.cwd).toBe(join(r.home, "assistant"));
  });

  test("another profile defaults to a directory of its own, and a written cwd wins", async () => {
    const r = await rig();
    expect(resolveProfile(r.home, "reader", {}).cwd).toBe(join(r.home, "assistant", "reader"));
    expect(resolveProfile(r.home, "elsewhere", { cwd: join(r.root, "work") }).cwd).toBe(join(r.root, "work"));
  });

  test("a working directory that is the operad home, holds it, or is inside it outside assistant is refused", async () => {
    const r = await rig();
    for (const cwd of [r.home, r.root, join(r.home, "store"), join(r.home, "secrets")]) {
      expect(() => resolveProfile(r.home, "bad", { cwd })).toThrow(ProfileError);
    }
    expect(() => resolveProfile(r.home, "ok", { cwd: join(r.home, "assistant", "notes") })).not.toThrow();
  });

  test("a profile name that could leave the assistant directory is refused", async () => {
    const r = await rig();
    writeConfig(r.home, { "../escape": {} });
    expect(() => readProfiles(r.home, {})).toThrow("a name is lowercase letters");
  });

  test("the settings are declared with a schema the kernel and the settings view can read", async () => {
    const r = await rig({ reader: { access: { readOnly: true } } });
    const declared = r.registry.settingsDeclarations().find((entry) => entry.plugin === "assistant");
    expect(declared?.schema).toEqual(ASSISTANT_SETTINGS);
    expect(r.registry.settingsFor("assistant").profiles).toEqual({ reader: { access: { readOnly: true } } });
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
    const file = JSON.parse(readFileSync(join(import.meta.dir, "..", "assistant.schema.json"), "utf8")) as Record<string, unknown>;
    const { $schema, $id, title, description, ...schema } = file;
    expect([typeof $schema, typeof $id, typeof title, typeof description]).toEqual(["string", "string", "string", "string"]);
    expect(schema).toEqual(strip(ASSISTANT_SETTINGS) as Record<string, unknown>);
  });

  test("each profile is one row in lists, the default one too, and a removed one is marked", async () => {
    const r = await rig({ reader: {} });
    const views = createViews({ registry: r.registry, store: r.store, onLog: () => undefined });
    try {
      const listed = await views.list("profile");
      expect(listed.rows.map((row) => row.id).sort()).toEqual(["default", "reader"]);
      writeConfig(r.home, {});
      await syncProfiles(r.store, r.home, {});
      expect((await r.store.get("profile", "reader"))?.data.removed).toBe(true);
    } finally {
      views.close();
    }
  });
});

describe("the default access profile", () => {
  test("a chat of the default profile cannot read the secrets or the token, and can read its own directory", async () => {
    const r = await rig();
    mkdirSync(join(r.home, "secrets"), { recursive: true });
    writeFileSync(join(r.home, "secrets", "token"), "t");
    writeFileSync(join(r.home, "serve.lock"), "1");
    const cwd = join(r.home, "assistant");
    const chat = await r.open(DEFAULT_PROFILE);
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

  test("anything new that appears in the home is denied too, but not the assistant directory", async () => {
    const r = await rig();
    mkdirSync(join(r.home, "assistant"), { recursive: true });
    writeFileSync(join(r.home, "gate.log"), "x");
    const denied = defaultAccess(r.home).denyPaths;
    expect(denied).toContain(join(r.home, "gate.log"));
    expect(denied).not.toContain(join(r.home, "assistant"));
  });

  test("a profile only adds to the default; it cannot loosen it", async () => {
    const r = await rig();
    const tightened = resolveProfile(r.home, "reader", {
      access: { denyPaths: ["~/notes"], readOnly: true, denyCommands: [] },
    }).access;
    const base = defaultAccess(r.home);
    expect(tightened.denyPaths).toEqual([...(base.denyPaths as string[]), "~/notes"]);
    expect(tightened.denyCommands).toEqual(base.denyCommands);
    expect(tightened.readOnly).toBe(true);
    expect(resolveProfile(r.home, "plain", { access: { readOnly: false } }).access.readOnly).toBeUndefined();
  });
});

describe("assistant:chat", () => {
  test("opens a chat of the chat plugin with the profile as its parent", async () => {
    const r = await rig();
    await syncProfiles(r.store, r.home, {});
    const id = await r.open(DEFAULT_PROFILE, { title: "Morning" });
    const chat = chatData((await r.store.get(CHAT_TYPE, id))?.data ?? {});
    expect(chat.parent).toBe("profile:default");
    expect(chat.title).toBe("Morning");
    expect(chat.cwd).toBe(join(r.home, "assistant"));
    expect(existsSync(chat.cwd)).toBe(true);
    const row = r.registry.viewsFor("chat")?.views.row((await r.store.get(CHAT_TYPE, id)) as never);
    expect(row?.parent).toBe("profile:default");
  });

  test("the harness is the one given, else the profile's, else the first loaded; an unloaded one is refused", async () => {
    const r = await rig({ pi: { harness: "harness-pi" } });
    await syncProfiles(r.store, r.home, r.registry.settingsFor("assistant"));
    const harnessOf = async (id: string) => (await r.store.get(CHAT_TYPE, id))?.data.harness;
    expect(await harnessOf(await r.open("default"))).toBe("harness-claude");
    expect(await harnessOf(await r.open("pi"))).toBe("harness-pi");
    expect(await harnessOf(await r.open("pi", { harness: "harness-claude" }))).toBe("harness-claude");
    await expect(r.open("default", { harness: "harness-radian" })).rejects.toThrow('harness "harness-radian" is not loaded');
  });

  test("the harness stays what it was when the profile's default changes", async () => {
    const r = await rig({ reader: { harness: "harness-pi" } });
    await syncProfiles(r.store, r.home, {});
    const id = await r.open("reader");
    writeConfig(r.home, { reader: { harness: "harness-claude" } });
    await r.say(id, "hi");
    await r.reply(id);
    expect((await r.store.get(CHAT_TYPE, id))?.data.harness).toBe("harness-pi");
    expect(r.calls).toHaveLength(1);
  });

  test("a profile that was removed or cannot be used offers no chat", async () => {
    const r = await rig({ bad: { cwd: "/" } });
    await syncProfiles(r.store, r.home, {});
    expect((await r.store.get("profile", "bad"))?.data.problem).toContain("operad home");
    await expect(r.open("bad")).rejects.toThrow();
  });
});

describe("a reply reads the profile again", () => {
  test("tightening the access profile applies to the next reply of the same chat", async () => {
    const r = await rig({ reader: {} });
    await syncProfiles(r.store, r.home, {});
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

  test("a skill added to the profile is given at the next reply; none before", async () => {
    const r = await rig({ reader: {} });
    await syncProfiles(r.store, r.home, {});
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
    await syncProfiles(r.store, r.home, {});
    const id = await r.open("reader");
    writeConfig(r.home, { reader: { skills: [join(r.root, "nothing")] } });
    await r.say(id, "hi");
    const result = await r.reply(id);
    expect(result.result).toBe("failed");
    expect(String(result.data?.message)).toContain("there is no SKILL.md");
    expect(r.calls).toHaveLength(0);
  });

  test("a profile taken out of the settings stops answering instead of using an older copy", async () => {
    const r = await rig({ reader: {} });
    await syncProfiles(r.store, r.home, {});
    const id = await r.open("reader");
    writeConfig(r.home, {});
    await r.say(id, "hi");
    const result = await r.reply(id);
    expect(result.result).toBe("failed");
    expect(result.data).toMatchObject({ message: 'profile "reader" is no longer in the settings' });
    expect(r.calls).toHaveLength(0);
  });

  test("the agent gets operad's tools and works in the profile's directory, not a repository", async () => {
    const r = await rig();
    await syncProfiles(r.store, r.home, {});
    const id = await r.open("default");
    await r.say(id, "hi");
    await r.reply(id);
    expect(r.calls[0]?.params.operadTools).toEqual({ home: r.home });
    expect(r.calls[0]?.params.cwd).toBe(join(r.home, "assistant"));
    expect(defaultAccess(r.home).denyCommands).toContain("operad");
  });
});
