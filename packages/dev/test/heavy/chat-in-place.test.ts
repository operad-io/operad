import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { match, withAccessLevel } from "@operad-io/access-match";
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
import { addRepository, createDevPlugin } from "../../src/index.ts";
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


async function inPlaceRepository(r: Awaited<ReturnType<typeof rig>>, name: string, workIn: string): Promise<string> {
  const path = await repository(r, name);
  mkdirSync(join(path, ".operad"), { recursive: true });
  writeFileSync(join(path, ".operad", "dev.json"), `${JSON.stringify({ workIn })}\n`);
  return path;
}

describe("a repository chat with workIn branch", () => {
  test("at edits and full it works in the main clone: no worktree question, no work/chat branch, writes allowed there", async () => {
    const r = await rig();
    const path = await inPlaceRepository(r, "place", "branch");
    const id = await openChat(r, "place");
    const head = git(path, ["rev-parse", "HEAD"]).out;
    const branches = git(path, ["branch", "--list"]).out;
    const home = join(r.root, "user");

    for (const level of ["edits", "full"]) {
      expect(String(await sendAccess(r, id, level))).toContain(level);
      const moved = await chat(r, id);
      expect(moved.data.cwd).toBe(path);
      expect(moved.data.worktree).toBeUndefined();
      expect(existsSync(join(path, ".operad-worktrees", `chat-${id}`))).toBe(false);
      expect(git(path, ["branch", "--list"]).out).toBe(branches);

      await reply(r, id);
      const call = r.calls[r.calls.length - 1];
      if (call === undefined) throw new Error("the harness was not called");
      expect(call.cwd).toBe(path);
      expect(call.access).toMatchObject({ level, readOnly: false });
      expect(match(call.access, { tool: "write", input: { path: join(path, "new.txt") }, cwd: path }, { home })).toEqual({ allow: true });
    }
    expect(git(path, ["rev-parse", "HEAD"]).out).toBe(head);
  });

  test("the first reply's context no longer says read-only", async () => {
    const r = await rig();
    await inPlaceRepository(r, "text", "branch");
    const id = await openChat(r, "text");
    const stored = await chat(r, id);
    const result = await r.registry.runStep("dev/chat_settings", { chat: id }, {
      runId: "run-settings",
      object: { type: CHAT_TYPE, id, data: stored.data },
    });
    const data = result.data as { context: { where: string }; access: { readOnly: boolean }; worktreeOffer: boolean };
    expect(data.context.where).not.toContain("read-only");
    expect(data.context.where).toContain("works in the main clone");
    expect(data.access.readOnly).toBe(false);
    expect(data.worktreeOffer).toBe(false);
  });

  test("plan stays read-only and offers no worktree", async () => {
    const r = await rig();
    const path = await inPlaceRepository(r, "plan", "branch");
    const id = await openChat(r, "plan");
    await reply(r, id);
    const call = r.calls[0];
    if (call === undefined) throw new Error("the harness was not called");
    expect(call.cwd).toBe(path);
    expect(call.access).toMatchObject({ level: "plan", readOnly: true });
    expect(match(call.access, { tool: "write", input: { path: join(path, "new.txt") }, cwd: path }, { home: join(r.root, "user") }).allow).toBe(false);
  });

  test("a worktree repository is unchanged: edits opens work/chat-<id>", async () => {
    const r = await rig();
    const path = await inPlaceRepository(r, "tree", "worktree");
    const id = await openChat(r, "tree");
    await sendAccess(r, id, "edits");
    expect((await chat(r, id)).data.cwd).toBe(join(path, ".operad-worktrees", `chat-${id}`));
  });
});
