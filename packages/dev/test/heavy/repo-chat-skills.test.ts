import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { match } from "@operad-io/access-match";
import { CHAT_TYPE, createChatPlugin } from "@operad-io/chat";
import {
  PluginRegistry,
  Views,
  definePlugin,
  type JsonValue,
  type PluginStepResult,
  type StepContext,
  type StoredObject,
} from "@operad-io/engine";
import {
  addRepository,
  createDevPlugin,
  validateDevSettings,
} from "../../src/index.ts";
import { git, makeRemote } from "../git-support.ts";
import { cleanupTempRoots, guardLockHandles, storeAt, tempRoot } from "../support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

interface Call {
  readonly params: Record<string, unknown>;
  readonly access: Record<string, JsonValue>;
  readonly cwd: string | undefined;
}

function fakeHarness(calls: Call[]) {
  return definePlugin({
    name: "claude",
    kind: "harness",
    version: "0.0.0",
    capabilities: { accessLevels: ["plan", "ask", "edits", "full"] },
    models: { list: ["claude-a"], default: "claude-a" },
    efforts: { list: ["low", "high"], default: "low", flag: "--effort" },
    steps: [
      {
        name: "agent",
        resumable: true,
        results: ["done", "failed", "interrupted"],
        run(ctx: StepContext, params): PluginStepResult {
          calls.push({ params: params as Record<string, unknown>, access: ctx.access as Record<string, JsonValue>, cwd: ctx.cwd });
          return { result: "done", data: { finalMessage: "ok", sessionId: "s-1" } };
        },
      },
    ],
  });
}

async function rig() {
  const root = await tempRoot();
  const store = storeAt(root);
  const calls: Call[] = [];
  const registry = new PluginRegistry([createChatPlugin(), createDevPlugin(), fakeHarness(calls)], {
    home: root,
    cwd: root,
    store,
    onLog: () => undefined,
  });
  return { root, store, registry, calls };
}

async function repository(r: Awaited<ReturnType<typeof rig>>, name: string): Promise<string> {
  const base = join(r.root, name);
  mkdirSync(base, { recursive: true });
  const remote = await makeRemote(base);
  await addRepository(r.store, { path: remote.repository, name });
  return remote.repository;
}

async function openChat(
  r: Awaited<ReturnType<typeof rig>>,
  name: string,
): Promise<string> {
  const repo = await r.store.get("repo", name);
  if (repo === undefined) throw new Error(`no repository ${name}`);
  const run = await r.registry.runAction("dev/chat", {}, {
    object: { type: "repo", id: name, data: repo.data },
    actor: { via: "cli", id: "me" },
  });
  const id = /C-\d+/.exec(String(run.value))?.[0];
  if (id === undefined) throw new Error(`no chat id in ${String(run.value)}`);
  return id;
}

async function chat(r: Awaited<ReturnType<typeof rig>>, id: string): Promise<StoredObject> {
  const stored = await r.store.get(CHAT_TYPE, id);
  if (stored === undefined) throw new Error(`no chat ${id}`);
  return stored;
}

async function access(r: Awaited<ReturnType<typeof rig>>, id: string, level: string): Promise<unknown> {
  const stored = await chat(r, id);
  const run = await r.registry.runAction("chat/access", { level }, {
    object: { type: CHAT_TYPE, id, data: stored.data },
    actor: { via: "cli", id: "me" },
  });
  return run.value;
}

async function sendAccess(r: Awaited<ReturnType<typeof rig>>, id: string, level: string): Promise<unknown> {
  const stored = await chat(r, id);
  const run = await r.registry.runAction("chat/send", { note: `/access ${level}` }, {
    object: { type: CHAT_TYPE, id, data: stored.data },
    actor: { via: "cli", id: "me" },
  });
  return run.value;
}

async function reply(r: Awaited<ReturnType<typeof rig>>, id: string): Promise<PluginStepResult> {
  const stored = await chat(r, id);
  const number = r.calls.length + 1;
  await r.store.append({
    type: "chat.message",
    object: { type: CHAT_TYPE, id },
    cause: "test",
    data: {
      id: `m-${number}`,
      role: "user",
      from: { via: "cli", id: "me" },
      text: `message ${number}`,
      attachments: [],
      source: { kind: "cli", ref: null },
    },
  });
  return r.registry.runStep("chat/reply", {}, {
    runId: `run-${number}`,
    object: { type: CHAT_TYPE, id, data: stored.data },
    params: null,
  });
}

function skill(path: string, name = "x"): string {
  const directory = join(path, ".agents", "skills", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\n---\nDo it.\n`);
  return directory;
}

function writeSkills(path: string, skills: readonly string[]): void {
  writeFileSync(join(path, ".operad", "dev.json"), `${JSON.stringify({ skills })}\n`);
}

describe("a repository's skills", () => {
  test("`.agents/skills` gives its own chat the skill, and another repository's chat none", async () => {
    const r = await rig();
    const alpha = await repository(r, "alpha");
    const beta = await repository(r, "beta");
    const x = skill(alpha);

    const alphaChat = await openChat(r, "alpha");
    const betaChat = await openChat(r, "beta");
    expect((await chat(r, alphaChat)).data.skills).toEqual([x]);
    expect((await chat(r, betaChat)).data.skills).toEqual([]);

    expect((await reply(r, alphaChat)).result).toBe("done");
    expect((await reply(r, betaChat)).result).toBe("done");
    expect(r.calls[0]?.params.skills).toEqual([x]);
    expect(r.calls[1]?.params.skills).toBeUndefined();
    expect(r.calls[0]?.access.readPaths).toEqual([join(alpha, ".agents", "skills")]);
    expect(r.calls[0]?.access.denyPaths).toContain(join(alpha, ".agents", "skills"));
    expect(r.calls[1]?.access.readPaths).toBeUndefined();
  });

  test("the setting can change the directory and an empty list turns the skills off", async () => {
    const r = await rig();
    const path = await repository(r, "custom");
    const directory = join(path, "tools", "skills");
    const y = join(directory, "y");
    mkdirSync(y, { recursive: true });
    writeFileSync(join(y, "SKILL.md"), "---\nname: y\n---\n");
    writeSkills(path, ["tools/skills"]);

    const id = await openChat(r, "custom");
    expect((await chat(r, id)).data.skills).toEqual([y]);
    await reply(r, id);
    expect(r.calls[0]?.params.skills).toEqual([y]);

    writeSkills(path, []);
    await reply(r, id);
    expect(r.calls[1]?.params.skills).toBeUndefined();
    expect(r.calls[1]?.access.readPaths).toBeUndefined();
  });

  test("a `.agents` directory expands through its skills directory, including one added later", async () => {
    const r = await rig();
    const path = await repository(r, "agents");
    const x = skill(path, "x");
    writeSkills(path, [".agents"]);

    const id = await openChat(r, "agents");
    await reply(r, id);
    expect(r.calls[0]?.params.skills).toEqual([x]);

    const later = skill(path, "later");
    writeSkills(path, []);
    writeSkills(path, [".agents"]);
    await reply(r, id);
    expect(r.calls[1]?.params.skills).toEqual([x, later].sort((left, right) => left.localeCompare(right)));
  });

  test("a worktree chat reads the worktree's copy, not the main clone's", async () => {
    const r = await rig();
    const path = await repository(r, "branch");
    const mainSkill = skill(path);
    const id = await openChat(r, "branch");
    await reply(r, id);
    expect(r.calls[0]?.params.skills).toEqual([mainSkill]);

    const worktree = join(path, ".operad-worktrees", `chat-${id}`);
    const opened = await r.registry.runStep("dev/chat_worktree", {}, {
      runId: "run-worktree",
      object: { type: CHAT_TYPE, id, data: {} },
    });
    expect(opened.result).toBe("done");
    // A chat raised to edits writes in the worktree it already has.
    const moved = await r.store.get(CHAT_TYPE, id);
    if (moved === undefined) throw new Error("no chat after the worktree opened");
    await r.store.put(CHAT_TYPE, id, { ...moved.data, accessLevel: "edits" }, "test");
    const branchSkill = skill(worktree);
    await reply(r, id);
    expect(r.calls[1]?.cwd).toBe(worktree);
    expect(r.calls[1]?.params.skills).toEqual([branchSkill]);
    expect(r.calls[1]?.params.skills).not.toEqual([mainSkill]);
    expect(r.calls[1]?.access.readOnly).toBe(false);
    expect(r.calls[1]?.access.denyPaths).not.toContain(join(worktree, ".agents", "skills"));
    expect(r.calls[1]?.access.readPaths).toBeUndefined();
  });

  test("a path outside the repository is refused", async () => {
    const r = await rig();
    const path = await repository(r, "outside");
    writeSkills(path, ["../outside"]);
    await expect(openChat(r, "outside")).rejects.toThrow(/skills\[0\]: must stay inside the repository/);

    writeSkills(path, [join(r.root, "elsewhere")]);
    await expect(openChat(r, "outside")).rejects.toThrow(/skills\[0\]: must be relative to the repository/);
  });

  test("the setting defaults to `.agents/skills` and an empty list is kept", () => {
    expect(validateDevSettings({}).skills).toEqual([".agents/skills"]);
    expect(validateDevSettings({ skills: [] }).skills).toEqual([]);
    expect(validateDevSettings({ skills: ["tools/skills"] }).skills).toEqual(["tools/skills"]);
  });
});

describe("a repository chat's access level", () => {
  test("at full it still refuses credentials and sudo, and asks before git push", async () => {
    const r = await rig();
    const path = await repository(r, "tight");
    const id = await openChat(r, "tight");

    await sendAccess(r, id, "full");
    const stored = (await chat(r, id)).data.access as Record<string, JsonValue>;
    const home = join(r.root, "user");
    const worktree = join(path, ".operad-worktrees", `chat-${id}`);
    expect(match(stored, { tool: "read", input: { path: "~/.ssh/id_ed25519" }, cwd: worktree }, { home }).allow).toBe(false);
    expect(match(stored, { tool: "bash", input: { command: "sudo ls" }, cwd: worktree }, { home }).allow).toBe(false);
    expect(match(stored, { tool: "bash", input: { command: "git push origin main" }, cwd: worktree }, { home })).toMatchObject({
      allow: false,
      ask: true,
    });
    expect(match(stored, { tool: "bash", input: { command: 'bash -c "echo hi"' }, cwd: worktree }, { home })).toMatchObject({
      allow: false,
      ask: true,
    });
    expect(match(stored, { tool: "bash", input: { command: "operad dev list" }, cwd: worktree }, { home }).allow).toBe(false);

    await reply(r, id);
    const call = r.calls[0];
    if (call === undefined) throw new Error("the harness was not called");
    const cwd = call.cwd ?? worktree;
    expect(match(call.access, { tool: "read", input: { path: "~/.ssh/id_ed25519" }, cwd }, { home }).allow).toBe(false);
    expect(match(call.access, { tool: "bash", input: { command: "sudo ls" }, cwd }, { home }).allow).toBe(false);
    expect(match(call.access, { tool: "bash", input: { command: "git push origin main" }, cwd }, { home })).toMatchObject({
      allow: false,
      ask: true,
    });
  });

  test("/access edits opens work/chat-<id>, moves the chat there, and a write passes without a question", async () => {
    const r = await rig();
    const path = await repository(r, "edits");
    const id = await openChat(r, "edits");
    const head = git(path, ["rev-parse", "HEAD"]).out;

    expect(String(await sendAccess(r, id, "edits"))).toContain("edits");
    const worktree = join(path, ".operad-worktrees", `chat-${id}`);
    const moved = await chat(r, id);
    expect(moved.data.cwd).toBe(worktree);
    expect(moved.data.accessLevel).toBe("edits");
    expect(moved.data.accessAction).toBe("dev/chat_access");
    const views = new Views({ registry: r.registry, store: r.store, onLog: () => undefined });
    expect((await views.get(`chat:${id}`)).actions.map((action) => action.name)).not.toContain("dev:chat_access");
    expect(moved.data.accessActionRequest).toBeUndefined();
    expect(existsSync(worktree)).toBe(true);
    expect(git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]).out).toBe(`work/chat-${id}`);
    expect(git(path, ["rev-parse", "HEAD"]).out).toBe(head);
    expect(git(path, ["status", "--porcelain", "--untracked-files=no"]).out).toBe("");

    await reply(r, id);
    expect(r.calls[0]?.cwd).toBe(worktree);
    expect(r.calls[0]?.access).toMatchObject({ level: "edits", readOnly: false });
    expect(existsSync(join(path, "new.txt"))).toBe(false);
  });

  test("/access full does the same, and the main clone does not move", async () => {
    const r = await rig();
    const path = await repository(r, "full");
    const id = await openChat(r, "full");
    const head = git(path, ["rev-parse", "HEAD"]).out;

    await sendAccess(r, id, "full");
    const worktree = join(path, ".operad-worktrees", `chat-${id}`);
    const moved = await chat(r, id);
    expect(moved.data.cwd).toBe(worktree);
    expect(moved.data.accessLevel).toBe("full");
    expect(git(path, ["rev-parse", "HEAD"]).out).toBe(head);
    expect(git(path, ["status", "--porcelain", "--untracked-files=no"]).out).toBe("");

    await reply(r, id);
    expect(r.calls[0]?.cwd).toBe(worktree);
    expect(r.calls[0]?.access).toMatchObject({ level: "full", readOnly: false });
  });

  test("a worktree that cannot be opened leaves the level unchanged and says why", async () => {
    const r = await rig();
    const path = await repository(r, "failed");
    const id = await openChat(r, "failed");
    const worktree = join(path, ".operad-worktrees", `chat-${id}`);
    mkdirSync(worktree, { recursive: true });

    await expect(access(r, id, "edits")).rejects.toThrow(/exists but is not a git worktree/);
    const stayed = await chat(r, id);
    expect(stayed.data.cwd).toBe(path);
    expect(stayed.data.accessLevel).toBe("plan");
    expect(stayed.data.worktree).toBeUndefined();
  });

  test("a chat already in its worktree changes the level there and opens nothing new", async () => {
    const r = await rig();
    const path = await repository(r, "already");
    const id = await openChat(r, "already");
    await r.registry.runStep("dev/chat_worktree", {}, {
      runId: "run-worktree",
      object: { type: CHAT_TYPE, id, data: {} },
    });
    const worktree = join(path, ".operad-worktrees", `chat-${id}`);
    const listed = git(path, ["worktree", "list", "--porcelain"]).out;

    await sendAccess(r, id, "full");
    const changed = await chat(r, id);
    expect(changed.data.cwd).toBe(worktree);
    expect(changed.data.accessLevel).toBe("full");
    expect(git(path, ["worktree", "list", "--porcelain"]).out).toBe(listed);
  });

  test("ask and plan in the main clone open no worktree", async () => {
    const r = await rig();
    const path = await repository(r, "read-only");
    const id = await openChat(r, "read-only");

    await sendAccess(r, id, "ask");
    expect((await chat(r, id)).data.cwd).toBe(path);
    expect(existsSync(join(path, ".operad-worktrees", `chat-${id}`))).toBe(false);
  });
});
