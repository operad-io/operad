import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { match, readProfile, type AccessProfile } from "@operad-io/access-match";
import { newKeptWorkerSlot, writeKeptWorker } from "@operad-io/engine/platform";
import {
  DEFAULT_BOT,
  claudeProjectDirectory,
  migrateDefaultBotDir,
  resolveBot,
  syncBots,
} from "../src/index.ts";
import { cleanupRoots, rig, writeConfig } from "./support.ts";

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
  test("only skills and memory move; an unknown file and directory stay and the default bot can use them", async () => {
    const r = await rig({ reader: {} });
    const root = join(r.home, "bot");
    const target = join(root, DEFAULT_BOT);
    const home = join(r.root, "user");
    mkdirSync(join(root, "skills", "brain"), { recursive: true });
    writeFileSync(join(root, "skills", "brain", "SKILL.md"), "---\nname: brain\n---\n");
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(join(root, "memory", "old.md"), "remember\n");
    mkdirSync(join(root, "voice"), { recursive: true });
    writeFileSync(join(root, "voice", "style.md"), "voice\n");
    writeFileSync(join(root, "notes.md"), "mine\n");
    mkdirSync(join(root, "reader", "private"), { recursive: true });
    writeFileSync(join(root, "reader", "private", "secret.md"), "not mine\n");
    const grants = join(r.home, "access-user.json");
    const grantsText = '{"entries":[{"kind":"path","value":"/tmp/x","cwd":"/tmp"}]}\n';
    writeFileSync(grants, grantsText);

    await syncBots(r.store, r.home, { bots: { reader: {} } });

    expect(readFileSync(join(target, "skills", "brain", "SKILL.md"), "utf8")).toContain("brain");
    expect(readFileSync(join(target, "memory", "old.md"), "utf8")).toBe("remember\n");
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(root, "voice", "style.md"), "utf8")).toBe("voice\n");
    expect(existsSync(join(target, "notes.md"))).toBe(false);
    expect(existsSync(join(target, "voice"))).toBe(false);
    expect(readFileSync(join(root, "reader", "private", "secret.md"), "utf8")).toBe("not mine\n");
    expect(readFileSync(grants, "utf8")).toBe(grantsText);

    const access = accessOf(resolveBot(r.home, DEFAULT_BOT, {}).access);
    const cwd = join(root, DEFAULT_BOT);
    expect(match(access, { tool: "read", input: { path: join(root, "notes.md") }, cwd }, { home }).allow).toBe(true);
    expect(match(access, { tool: "write", input: { path: join(root, "notes.md") }, cwd }, { home }).allow).toBe(true);
    expect(match(access, { tool: "read", input: { path: join(root, "voice", "style.md") }, cwd }, { home }).allow).toBe(true);
    expect(match(access, { tool: "write", input: { path: join(root, "voice", "style.md") }, cwd }, { home }).allow).toBe(true);
    expect(match(access, { tool: "bash", input: { command: `cat ${join(root, "notes.md")}` }, cwd }, { home }).allow).toBe(true);

    // Running it again moves nothing and keeps everything in place.
    await syncBots(r.store, r.home, { bots: { reader: {} } });
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(root, "reader", "private", "secret.md"), "utf8")).toBe("not mine\n");
  });

  test("a bot named by an entry that operad would move keeps its directory, and so does a removed bot", async () => {
    const r = await rig();
    const root = join(r.home, "bot");
    const target = join(root, DEFAULT_BOT);
    const writer = join(root, "skills");
    const gone = join(root, "memory");
    mkdirSync(writer, { recursive: true });
    mkdirSync(gone, { recursive: true });
    writeFileSync(join(writer, "mine.md"), "writer\n");
    writeFileSync(join(gone, "keep.md"), "gone but still theirs\n");
    await r.store.put("bot", "gone", { name: "gone", cwd: gone, removed: false }, "test");

    const settings = { writer: { cwd: writer } };
    writeConfig(r.home, settings);
    await syncBots(r.store, r.home, { bots: settings });

    expect(readFileSync(join(writer, "mine.md"), "utf8")).toBe("writer\n");
    expect(readFileSync(join(gone, "keep.md"), "utf8")).toBe("gone but still theirs\n");
    expect(existsSync(join(target, "memory", "keep.md"))).toBe(false);
    expect(existsSync(join(target, "skills"))).toBe(false);
  });

  test("once the move is done, a later read moves no new entry and reads no journal", async () => {
    const r = await rig();
    const root = join(r.home, "bot");
    const target = join(root, DEFAULT_BOT);
    const sessions = join(r.root, "radian", "sessions");
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(join(root, "memory", "first.md"), "first\n");
    migrateDefaultBotDir(r.home, { botNames: ["default"] });
    expect(readFileSync(join(target, "memory", "first.md"), "utf8")).toBe("first\n");

    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(join(root, "memory", "later.md"), "later\n");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "after.jsonl"),
      `${JSON.stringify({ event: "SessionCreated", data: { workspace: root } })}\n`,
    );
    expect(migrateDefaultBotDir(r.home, { botNames: ["default"], radianSessionDirs: [sessions] })).toEqual([]);
    expect(existsSync(join(root, "memory", "later.md"))).toBe(true);
    expect(existsSync(join(target, "memory", "later.md"))).toBe(false);
    expect(readFileSync(join(sessions, "after.jsonl"), "utf8")).toContain(`"workspace":${JSON.stringify(root)}`);
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
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(join(root, "memory", "old.md"), "remember\n");
    mkdirSync(join(root, "skills", "brain"), { recursive: true });
    writeFileSync(join(root, "skills", "brain", "SKILL.md"), "---\nname: brain\n---\n");
    writeFileSync(join(root, "notes.md"), "stays\n");
    const source = pathToFileURL(join(import.meta.dir, "..", "src", "bot.ts")).href;
    const code = `
      import { migrateDefaultBotDir } from ${JSON.stringify(source)};
      migrateDefaultBotDir(${JSON.stringify(r.home)}, {
        botNames: ["default"],
        claudeProjects: ${JSON.stringify(join(r.root, "no-claude"))},
        radianSessionDirs: [],
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
      expect(["memory", "skills"]).toContain(text.slice(0, text.indexOf("\n")));
      child.kill("SIGKILL");
      const exit = await child.exited;
      expect(exit).not.toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
    }

    const moved = migrateDefaultBotDir(r.home, {
      botNames: ["default"],
      claudeProjects: join(r.root, "no-claude"),
      radianSessionDirs: [],
    });
    expect(readFileSync(join(target, "memory", "old.md"), "utf8")).toBe("remember\n");
    expect(readFileSync(join(target, "skills", "brain", "SKILL.md"), "utf8")).toContain("brain");
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("stays\n");
    expect(moved.length).toBeGreaterThan(0);
    expect(migrateDefaultBotDir(r.home, { botNames: ["default"] })).toEqual([]);
  });
});

describe("grants after the move", () => {
  test("a grant made in the old home keeps matching, while every other grant stays byte for byte", async () => {
    const r = await rig();
    const root = join(r.home, "bot");
    const target = join(root, DEFAULT_BOT);
    const other = join(root, "reader");
    const repository = join(r.root, "repository");
    const grants = join(r.home, "access-user.json");
    const entries = [
      { kind: "command", value: "touch /tmp/operad-grant", cwd: root },
      { kind: "path", value: "/tmp/operad-note", cwd: root, tool: "write" },
      { kind: "command", value: "git status", cwd: other },
      { kind: "path", value: "src/a.ts", cwd: repository, tool: "edit" },
    ];
    writeFileSync(grants, `${JSON.stringify(entries, null, 2)}\n`);
    // A home handled by the earlier migration still gets its old grant cwd rewritten.
    writeFileSync(join(target, ".moved-to-default"), "");
    const moved = entries.map((entry) => (entry.cwd === root ? { ...entry, cwd: target } : entry));
    const expected = `${JSON.stringify(moved, null, 2)}\n`;

    migrateDefaultBotDir(r.home, {
      botNames: ["default"],
      grantFiles: [grants],
      claudeProjects: join(r.root, "no-claude"),
      radianSessionDirs: [],
    });

    expect(readFileSync(grants, "utf8")).toBe(expected);
    const profile: AccessProfile = {
      alwaysAllow: JSON.parse(expected) as NonNullable<AccessProfile["alwaysAllow"]>,
    };
    const home = join(r.root, "user");
    expect(match(profile, { tool: "bash", input: { command: "touch /tmp/operad-grant" }, cwd: target }, { home })).toMatchObject({
      allow: true,
    });
    expect(match(profile, { tool: "write", input: { path: "/tmp/operad-note" }, cwd: target }, { home }).allow).toBe(true);

    migrateDefaultBotDir(r.home, {
      botNames: ["default"],
      grantFiles: [grants],
      claudeProjects: join(r.root, "no-claude"),
      radianSessionDirs: [],
    });
    expect(readFileSync(grants, "utf8")).toBe(expected);
  });

  test("a crash while writing grants leaves the old file whole, and the next run finishes it", async () => {
    const r = await rig();
    const root = join(r.home, "bot");
    const target = join(root, DEFAULT_BOT);
    const grants = join(r.home, "access-user.json");
    const entries = [{ kind: "command", value: "touch /tmp/operad-grant", cwd: root }];
    const original = `${JSON.stringify(entries, null, 2)}\n`;
    writeFileSync(grants, original);
    const source = pathToFileURL(join(import.meta.dir, "..", "src", "bot.ts")).href;
    const options = {
      botNames: ["default"],
      grantFiles: [grants],
      claudeProjects: join(r.root, "no-claude"),
      radianSessionDirs: [],
    };
    const code = `
      import { migrateDefaultBotDir } from ${JSON.stringify(source)};
      migrateDefaultBotDir(${JSON.stringify(r.home)}, {
        ...${JSON.stringify(options)},
        beforeGrantRename(temporary, file) {
          console.log(file);
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
        if (next.done === true) throw new Error("the child ended before it wrote a grant file");
        text += decoder.decode(next.value, { stream: true });
      }
      expect(text.slice(0, text.indexOf("\n"))).toBe(grants);
      child.kill("SIGKILL");
      expect(await child.exited).not.toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await child.exited;
    }

    expect(readFileSync(grants, "utf8")).toBe(original);
    migrateDefaultBotDir(r.home, options);
    const expected = `${JSON.stringify([{ ...entries[0], cwd: target }], null, 2)}\n`;
    expect(readFileSync(grants, "utf8")).toBe(expected);
    migrateDefaultBotDir(r.home, options);
    expect(readFileSync(grants, "utf8")).toBe(expected);
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

  test("claude's old project directory waits while a claude worker is alive, then moves on the next read", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const oldCwd = join(home, "bot");
    const newCwd = join(oldCwd, DEFAULT_BOT);
    const projects = join(root, "claude", "projects");
    const from = join(projects, claudeProjectDirectory(oldCwd));
    const to = join(projects, claudeProjectDirectory(newCwd));
    mkdirSync(from, { recursive: true });
    mkdirSync(oldCwd, { recursive: true });
    writeFileSync(join(from, "old-session.jsonl"), "old session\n");
    const marker = join(newCwd, ".moved-to-default");
    const slot = newKeptWorkerSlot(home, "claude");
    writeKeptWorker({
      pid: process.pid,
      token: slot.token,
      scope: "chat:C-0001",
      key: "key",
      socket: slot.socket,
      meta: slot.meta,
      session: null,
      startedAt: 1,
      lastUsedAt: 1,
      busy: true,
    });

    migrateDefaultBotDir(home, { botNames: ["default"], claudeProjects: projects, radianSessionDirs: [] });
    expect(existsSync(from)).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("claude");

    rmSync(slot.meta, { force: true });
    rmSync(slot.socket, { force: true });
    migrateDefaultBotDir(home, { botNames: ["default"], claudeProjects: projects, radianSessionDirs: [] });
    expect(existsSync(from)).toBe(false);
    expect(readFileSync(join(to, "old-session.jsonl"), "utf8")).toBe("old session\n");
    expect(readFileSync(marker, "utf8")).toBe("");
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
