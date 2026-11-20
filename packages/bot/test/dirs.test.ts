import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { match, readProfile, type AccessProfile } from "@operad-io/access-match";
import { newKeptWorkerSlot, writeKeptWorker, lockTestHooks, withLockFile } from "@operad-io/engine/platform";
import {
  DEFAULT_BOT,
  claudeProjectDirectory,
  defaultBotHomeMigrated,
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

/** Forgets a first read that found no old home, so a test can create one and run the move. */
function forgetMigration(home: string): void {
  const target = join(home, "bot", DEFAULT_BOT);
  rmSync(join(target, ".moved-to-default"), { force: true });
  rmSync(join(target, ".grants-moved-to-default"), { force: true });
}

describe("the default bot's directory", () => {
  test("an old file with the same name does not write over the one already in default", async () => {
    const r = await rig();
    const root = join(r.home, "bot");
    const target = join(root, DEFAULT_BOT);
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(join(root, "memory", "index.md"), "old index\n");
    mkdirSync(join(target, "memory"), { recursive: true });
    writeFileSync(join(target, "memory", "index.md"), "new index\n");
    forgetMigration(r.home);

    await migrateDefaultBotDir(r.home, {
      botNames: ["default"],
      claudeProjects: join(r.root, "no-claude"),
      radianSessionDirs: [],
    });

    expect(readFileSync(join(target, "memory", "index.md"), "utf8")).toBe("new index\n");
    expect(existsSync(join(root, "memory", "index.md"))).toBe(false);
  });

  test("a home without the old directory is marked done and reads no journal", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const oldCwd = join(home, "bot");
    const newCwd = join(oldCwd, DEFAULT_BOT);
    const sessions = join(root, "radian", "sessions");
    mkdirSync(sessions, { recursive: true });
    const journal = join(sessions, "s1.jsonl");
    const original = `${JSON.stringify({ event: "SessionCreated", data: { workspace: oldCwd } })}\n`;
    writeFileSync(journal, original);

    expect(await migrateDefaultBotDir(home, {
      botNames: ["default"],
      claudeProjects: join(root, "claude", "projects"),
      radianSessionDirs: [sessions],
    })).toEqual([]);

    expect(readFileSync(journal, "utf8")).toBe(original);
    expect(defaultBotHomeMigrated(home)).toBe(true);
    // A different journal written after the directory exists stays untouched too.
    mkdirSync(oldCwd, { recursive: true });
    writeFileSync(journal, original);
    await migrateDefaultBotDir(home, {
      botNames: ["default"],
      claudeProjects: join(root, "claude", "projects"),
      radianSessionDirs: [sessions],
    });
    expect(readFileSync(journal, "utf8")).toBe(original);
    expect(existsSync(join(newCwd, ".moved-to-default"))).toBe(true);
  });

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
    forgetMigration(r.home);

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
    forgetMigration(r.home);
    await migrateDefaultBotDir(r.home, { botNames: ["default"] });
    expect(readFileSync(join(target, "memory", "first.md"), "utf8")).toBe("first\n");

    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(join(root, "memory", "later.md"), "later\n");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "after.jsonl"),
      `${JSON.stringify({ event: "SessionCreated", data: { workspace: root } })}\n`,
    );
    expect(await migrateDefaultBotDir(r.home, { botNames: ["default"], radianSessionDirs: [sessions] })).toEqual([]);
    expect(existsSync(join(root, "memory", "later.md"))).toBe(true);
    expect(existsSync(join(target, "memory", "later.md"))).toBe(false);
    expect(readFileSync(join(sessions, "after.jsonl"), "utf8")).toContain(`"workspace":${JSON.stringify(root)}`);
  });

  test("a default bot with a written directory keeps it and its old home is left alone", async () => {
    const r = await rig();
    const own = join(r.root, "own");
    writeFileSync(join(r.home, "config.json"), JSON.stringify({ plugins: { bot: { settings: { bots: { default: { cwd: own } } } } } }));
    mkdirSync(join(r.home, "bot", "memory"), { recursive: true });
    writeFileSync(join(r.home, "bot", "memory", "old.md"), "old\n");
    forgetMigration(r.home);
    await syncBots(r.store, r.home, { bots: { default: { cwd: own } } });
    expect(resolveBot(r.home, DEFAULT_BOT, { cwd: own }).cwd).toBe(own);
    expect(readFileSync(join(r.home, "bot", "memory", "old.md"), "utf8")).toBe("old\n");
    expect(existsSync(join(r.home, "bot", DEFAULT_BOT, "memory", "old.md"))).toBe(false);
    expect(existsSync(join(own, "memory", "old.md"))).toBe(false);
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
    forgetMigration(r.home);
    const source = pathToFileURL(join(import.meta.dir, "..", "src", "bot.ts")).href;
    const code = `
      import { migrateDefaultBotDir } from ${JSON.stringify(source)};
      await migrateDefaultBotDir(${JSON.stringify(r.home)}, {
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

    const moved = await migrateDefaultBotDir(r.home, {
      botNames: ["default"],
      claudeProjects: join(r.root, "no-claude"),
      radianSessionDirs: [],
    });
    expect(readFileSync(join(target, "memory", "old.md"), "utf8")).toBe("remember\n");
    expect(readFileSync(join(target, "skills", "brain", "SKILL.md"), "utf8")).toContain("brain");
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("stays\n");
    expect(moved.length).toBeGreaterThan(0);
    expect(await migrateDefaultBotDir(r.home, { botNames: ["default"] })).toEqual([]);
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
    forgetMigration(r.home);
    // A home handled by the earlier migration still gets its old grant cwd rewritten.
    writeFileSync(join(target, ".moved-to-default"), "");
    const moved = entries.map((entry) => (entry.cwd === root ? { ...entry, cwd: target } : entry));
    const expected = `${JSON.stringify(moved, null, 2)}\n`;

    await migrateDefaultBotDir(r.home, {
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

    await migrateDefaultBotDir(r.home, {
      botNames: ["default"],
      grantFiles: [grants],
      claudeProjects: join(r.root, "no-claude"),
      radianSessionDirs: [],
    });
    expect(readFileSync(grants, "utf8")).toBe(expected);
  });

  test("a grants file that is not JSON is left alone and marked as handled", async () => {
    const r = await rig();
    const root = join(r.home, "bot");
    const target = join(root, DEFAULT_BOT);
    const grants = join(r.home, "access-user.json");
    const invalid = "{ not json\n";
    mkdirSync(root, { recursive: true });
    writeFileSync(grants, invalid);
    forgetMigration(r.home);

    await migrateDefaultBotDir(r.home, {
      botNames: ["default"],
      grantFiles: [grants],
      claudeProjects: join(r.root, "no-claude"),
      radianSessionDirs: [],
    });

    expect(readFileSync(grants, "utf8")).toBe(invalid);
    expect(existsSync(join(target, ".grants-moved-to-default"))).toBe(true);
    expect(defaultBotHomeMigrated(r.home)).toBe(true);
  });

  test("the rewrite waits for the lock the grants file's normal writer holds", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const oldCwd = join(home, "bot");
    const target = join(oldCwd, DEFAULT_BOT);
    const grants = join(home, "access-user.json");
    const entries = [{ kind: "command", value: "touch /tmp/operad-grant", cwd: oldCwd }];
    const original = `${JSON.stringify(entries, null, 2)}\n`;
    mkdirSync(oldCwd, { recursive: true });
    writeFileSync(grants, original);

    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    let acquired!: () => void;
    const tookLock = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const lock = withLockFile(`${grants}.lock`, async () => {
      acquired();
      await held;
    }, { label: "test" });
    await tookLock;

    let attempted!: () => void;
    const tried = new Promise<void>((resolve) => {
      attempted = resolve;
    });
    const previousHook = lockTestHooks.beforeLink;
    lockTestHooks.beforeLink = (temporary, path) => {
      if (path === `${grants}.lock`) attempted();
    };
    try {
      const migration = migrateDefaultBotDir(home, {
        botNames: ["default"],
        grantFiles: [grants],
        claudeProjects: join(root, "no-claude"),
        radianSessionDirs: [],
      });
      const first = await Promise.race([
        migration.then(() => "done"),
        tried.then(() => "waited"),
      ]);
      expect(first).toBe("waited");
      expect(readFileSync(grants, "utf8")).toBe(original);
      releaseHeld();
      await migration;
    } finally {
      lockTestHooks.beforeLink = previousHook;
      releaseHeld();
      await lock;
    }
    const expected = `${JSON.stringify([{ ...entries[0], cwd: target }], null, 2)}\n`;
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
    forgetMigration(r.home);
    const source = pathToFileURL(join(import.meta.dir, "..", "src", "bot.ts")).href;
    const options = {
      botNames: ["default"],
      grantFiles: [grants],
      claudeProjects: join(r.root, "no-claude"),
      radianSessionDirs: [],
    };
    const code = `
      import { migrateDefaultBotDir } from ${JSON.stringify(source)};
      await migrateDefaultBotDir(${JSON.stringify(r.home)}, {
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
    await migrateDefaultBotDir(r.home, options);
    const expected = `${JSON.stringify([{ ...entries[0], cwd: target }], null, 2)}\n`;
    expect(readFileSync(grants, "utf8")).toBe(expected);
    await migrateDefaultBotDir(r.home, options);
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
    await migrateDefaultBotDir(join(root, "home"), { botNames: ["default"], claudeProjects: projects, radianSessionDirs: [] });
    expect(existsSync(from)).toBe(false);
    expect(readFileSync(join(to, "old-session.jsonl"), "utf8")).toBe("old session\n");
    expect(readFileSync(join(to, "new-session.jsonl"), "utf8")).toBe("new session\n");
    // A second run finds no old project directory and changes nothing.
    await migrateDefaultBotDir(join(root, "home"), { botNames: ["default"], claudeProjects: projects, radianSessionDirs: [] });
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

    await migrateDefaultBotDir(home, { botNames: ["default"], claudeProjects: projects, radianSessionDirs: [] });
    expect(existsSync(from)).toBe(true);
    expect(readFileSync(marker, "utf8")).toBe("claude");

    rmSync(slot.meta, { force: true });
    rmSync(slot.socket, { force: true });
    await migrateDefaultBotDir(home, { botNames: ["default"], claudeProjects: projects, radianSessionDirs: [] });
    expect(existsSync(from)).toBe(false);
    expect(readFileSync(join(to, "old-session.jsonl"), "utf8")).toBe("old session\n");
    expect(readFileSync(marker, "utf8")).toBe("");
  });

  test("pi's session file and codex's own home do not depend on the working directory", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const oldCwd = join(home, "bot");
    const piSession = join(home, "harness", "pi", "sessions", "session.jsonl");
    const codexThread = join(root, ".codex", "sessions", "thread.jsonl");
    mkdirSync(join(piSession, ".."), { recursive: true });
    mkdirSync(join(codexThread, ".."), { recursive: true });
    writeFileSync(piSession, `${JSON.stringify({ cwd: oldCwd, answer: "pi session" })}\n`);
    writeFileSync(codexThread, `${JSON.stringify({ session: "codex-thread", cwd: oldCwd })}\n`);
    mkdirSync(oldCwd, { recursive: true });

    await migrateDefaultBotDir(home, {
      botNames: ["default"],
      claudeProjects: join(root, "claude", "projects"),
      radianSessionDirs: [join(root, "radian", "sessions")],
    });

    expect(readFileSync(piSession, "utf8")).toContain("pi session");
    expect(JSON.parse(readFileSync(piSession, "utf8"))).toMatchObject({ cwd: oldCwd });
    expect(readFileSync(codexThread, "utf8")).toContain("codex-thread");
    expect(JSON.parse(readFileSync(codexThread, "utf8"))).toMatchObject({ cwd: oldCwd });
  });

  test("radian's journal records the new workspace and other journals are untouched", async () => {
    const root = await tempRoot();
    const oldCwd = join(root, "home", "bot");
    const newCwd = join(oldCwd, DEFAULT_BOT);
    const sessions = join(root, "radian", "sessions");
    mkdirSync(oldCwd, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    const moved = join(sessions, "s1.jsonl");
    writeFileSync(
      moved,
      `${JSON.stringify({ event: "SessionCreated", data: { workspace: oldCwd } })}\n{"event":"TurnStarted"}\n`,
    );
    const other = join(sessions, "s2.jsonl");
    writeFileSync(other, `${JSON.stringify({ event: "SessionCreated", data: { workspace: join(root, "elsewhere") } })}\n`);

    await migrateDefaultBotDir(join(root, "home"), {
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

  test("the default bot denies another bot's directory on disk even when the settings do not name it", async () => {
    const r = await rig();
    const root = join(r.home, "bot");
    const orphan = join(root, "gone", "memory");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "secret.md"), "not the default bot's\n");
    const home = join(r.root, "user");
    const bot = resolveBot(r.home, DEFAULT_BOT, {});
    const access = accessOf(bot.access);

    expect(match(access, { tool: "read", input: { path: join(orphan, "secret.md") }, cwd: bot.cwd }, { home }).allow).toBe(false);
    expect(match(access, { tool: "write", input: { path: join(orphan, "secret.md") }, cwd: bot.cwd }, { home }).allow).toBe(false);
  });
});
