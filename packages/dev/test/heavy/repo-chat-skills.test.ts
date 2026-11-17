import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChatPlugin, CHAT_TYPE } from "@operad-io/chat";
import {
  PluginRegistry,
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
import { makeRemote } from "../git-support.ts";
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
