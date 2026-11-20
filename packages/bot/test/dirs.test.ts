import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { match, readProfile, type AccessProfile } from "@operad-io/access-match";
import {
  DEFAULT_BOT,
  claudeProjectDirectory,
  migrateDefaultBotDir,
  resolveBot,
  syncBots,
} from "../src/index.ts";
import { cleanupRoots, rig } from "./support.ts";

afterAll(cleanupRoots);

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bot-dirs-"));
  roots.push(root);
  return root;
}

function accessOf(value: unknown): AccessProfile {
  const read = readProfile(value);
  if (!read.ok) throw new Error(read.message);
  return read.profile;
}

describe("the default bot's directory", () => {
  test("the old home moves into default, while another bot's directory stays put", async () => {
    const r = await rig({ reader: {} });
    const root = join(r.home, "bot");
    const target = join(root, DEFAULT_BOT);
    mkdirSync(join(root, "skills", "brain"), { recursive: true });
    writeFileSync(join(root, "notes.md"), "mine\n");
    writeFileSync(join(root, "skills", "brain", "SKILL.md"), "---\nname: brain\n---\n");
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(join(root, "memory", "old.md"), "remember\n");
    mkdirSync(join(root, "reader", "private"), { recursive: true });
    writeFileSync(join(root, "reader", "private", "secret.md"), "not mine\n");

    await syncBots(r.store, r.home, { bots: { reader: {} } });

    expect(readFileSync(join(target, "notes.md"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(target, "skills", "brain", "SKILL.md"), "utf8")).toContain("brain");
    expect(readFileSync(join(target, "memory", "old.md"), "utf8")).toBe("remember\n");
    expect(existsSync(join(root, "notes.md"))).toBe(false);
    expect(existsSync(join(root, "skills"))).toBe(false);
    expect(readFileSync(join(root, "reader", "private", "secret.md"), "utf8")).toBe("not mine\n");

    // Running it again moves nothing and keeps everything in place.
    await syncBots(r.store, r.home, { bots: { reader: {} } });
    expect(readFileSync(join(target, "notes.md"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(root, "reader", "private", "secret.md"), "utf8")).toBe("not mine\n");
  });

  test("a default bot with a written directory keeps it and its old home is left alone", async () => {
    const r = await rig();
    const own = join(r.root, "own");
    writeFileSync(join(r.home, "config.json"), JSON.stringify({ plugins: { bot: { settings: { bots: { default: { cwd: own } } } } } }));
    mkdirSync(join(r.home, "bot"), { recursive: true });
    writeFileSync(join(r.home, "bot", "notes.md"), "old\n");
    await syncBots(r.store, r.home, { bots: { default: { cwd: own } } });
    expect(resolveBot(r.home, DEFAULT_BOT, { cwd: own }).cwd).toBe(own);
    expect(existsSync(join(r.home, "bot", "notes.md"))).toBe(true);
    expect(existsSync(join(own, "notes.md"))).toBe(false);
  });

  test("a crash in a child halfway through the move loses nothing, and the next run finishes it", async () => {
    const r = await rig();
    const root = join(r.home, "bot");
    const target = join(root, DEFAULT_BOT);
    for (const name of ["a.md", "b.md", "c.md"]) writeFileSync(join(root, name), `${name}\n`);
    const source = pathToFileURL(join(import.meta.dir, "..", "src", "bot.ts")).href;
    const code = `
      import { migrateDefaultBotDir } from ${JSON.stringify(source)};
      migrateDefaultBotDir(${JSON.stringify(r.home)}, {
        botNames: ["default"],
        afterMove(name) {
          console.log(name);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
        }
      });
    `;
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", code],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    try {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes("\n")) {
        const next = await reader.read();
        if (next.done === true) throw new Error("the child ended before it moved an entry");
        text += decoder.decode(next.value, { stream: true });
      }
      expect(["a.md", "b.md", "c.md"]).toContain(text.slice(0, text.indexOf("\n")));
      child.kill("SIGKILL");
      const exit = await child.exited;
      expect(exit).not.toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
    }

    const moved = migrateDefaultBotDir(r.home, { botNames: ["default"] });
    const found = readdirSync(target).filter((name) => name.endsWith(".md")).sort();
    expect(found).toEqual(["a.md", "b.md", "c.md"]);
    for (const name of found) expect(readFileSync(join(target, name), "utf8")).toBe(`${name}\n`);
    expect(moved.length).toBeGreaterThan(0);
    expect(migrateDefaultBotDir(r.home, { botNames: ["default"] })).toEqual([]);
  });
});

describe("harness sessions after the move", () => {
  test("claude's project directory moves to the directory named for the new working directory", async () => {
    const root = await tempRoot();
    const oldCwd = join(root, "home", "bot");
    const newCwd = join(oldCwd, DEFAULT_BOT);
    const projects = join(root, "claude", "projects");
    const from = join(projects, claudeProjectDirectory(oldCwd));
    const to = join(projects, claudeProjectDirectory(newCwd));
    mkdirSync(from, { recursive: true });
    mkdirSync(to, { recursive: true });
    writeFileSync(join(from, "old-session.jsonl"), "old session\n");
    writeFileSync(join(to, "new-session.jsonl"), "new session\n");
    migrateDefaultBotDir(join(root, "home"), { botNames: ["default"], claudeProjects: projects, radianSessionDirs: [] });
    expect(existsSync(from)).toBe(false);
    expect(readFileSync(join(to, "old-session.jsonl"), "utf8")).toBe("old session\n");
    expect(readFileSync(join(to, "new-session.jsonl"), "utf8")).toBe("new session\n");
    // A second run finds no old project directory and changes nothing.
    migrateDefaultBotDir(join(root, "home"), { botNames: ["default"], claudeProjects: projects, radianSessionDirs: [] });
    expect(readdirSync(to).sort()).toEqual(["new-session.jsonl", "old-session.jsonl"]);
  });

  test("radian's journal records the new workspace and other journals are untouched", async () => {
    const root = await tempRoot();
    const oldCwd = join(root, "home", "bot");
    const newCwd = join(oldCwd, DEFAULT_BOT);
    const sessions = join(root, "radian", "sessions");
    mkdirSync(sessions, { recursive: true });
    const moved = join(sessions, "s1.jsonl");
    writeFileSync(
      moved,
      `${JSON.stringify({ event: "SessionCreated", data: { workspace: oldCwd } })}\n{"event":"TurnStarted"}\n`,
    );
    const other = join(sessions, "s2.jsonl");
    writeFileSync(other, `${JSON.stringify({ event: "SessionCreated", data: { workspace: join(root, "elsewhere") } })}\n`);

    migrateDefaultBotDir(join(root, "home"), {
      botNames: ["default"],
      claudeProjects: join(root, "claude", "projects"),
      radianSessionDirs: [sessions],
    });

    const [first] = readFileSync(moved, "utf8").split("\n");
    expect(JSON.parse(first ?? "{}")).toEqual({ event: "SessionCreated", data: { workspace: newCwd } });
    expect(readFileSync(moved, "utf8")).toContain('{"event":"TurnStarted"}');
    expect(readFileSync(other, "utf8")).toContain(join(root, "elsewhere"));
  });
});

describe("memory and the other bots' directories", () => {
  test("every bot gets memory, which it may write, while another bot's directory is denied", async () => {
    const r = await rig({ reader: {} });
    const home = join(r.root, "user");
    const first = resolveBot(r.home, DEFAULT_BOT, {});
    const second = resolveBot(r.home, "reader", {});
    expect(existsSync(join(first.cwd, "memory"))).toBe(true);
    expect(existsSync(join(second.cwd, "memory"))).toBe(true);
    rmSync(join(first.cwd, "memory"), { recursive: true, force: true });
    expect(existsSync(join(resolveBot(r.home, DEFAULT_BOT, {}).cwd, "memory"))).toBe(true);

    const one = accessOf(first.access);
    const two = accessOf(second.access);
    expect(match(one, { tool: "write", input: { path: join(first.cwd, "memory", "note.md") }, cwd: first.cwd }, { home }).allow).toBe(true);
    expect(match(one, { tool: "read", input: { path: join(first.cwd, "memory", "note.md") }, cwd: first.cwd }, { home }).allow).toBe(true);
    expect(match(one, { tool: "read", input: { path: join(second.cwd, "memory", "note.md") }, cwd: first.cwd }, { home }).allow).toBe(false);
    expect(match(one, { tool: "write", input: { path: join(second.cwd, "memory", "note.md") }, cwd: first.cwd }, { home }).allow).toBe(false);
    expect(match(two, { tool: "read", input: { path: join(first.cwd, "memory", "note.md") }, cwd: second.cwd }, { home }).allow).toBe(false);
    expect(match(two, { tool: "write", input: { path: join(first.cwd, "memory", "note.md") }, cwd: second.cwd }, { home }).allow).toBe(false);
  });
});
