import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PluginRegistry, definePlugin, type CommandContext, type StoredObject } from "@operad-io/engine";
import { createChatPlugin, createChat, CHAT_TYPE } from "@operad-io/chat";
import { createShellPlugin } from "@operad-io/shell";
import { addPlan, addRepository, CHAT_HARNESSES, chatActions, commands, createDevPlugin, RADIAN_NOTE, taskData } from "../src/index.ts";
import { git, makeRemote } from "./git-support.ts";
import { cleanupTempRoots, guardLockHandles, storeAt, tempRoot } from "./support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

function fakeHarness(name: string) {
  return definePlugin({
    name,
    kind: "harness",
    version: "0.0.0",
    steps: [{ name: "agent", results: ["done", "failed", "interrupted"], run: () => ({ result: "failed" }) }],
  });
}

async function rig(harnesses: readonly string[] = ['radian', 'pi', 'claude']) {
  const root = await tempRoot();
  const remote = await makeRemote(root);
  const store = storeAt(root);
  const repository = await addRepository(store, { path: remote.repository, name: "repository" });
  const registry = new PluginRegistry([createChatPlugin(), createDevPlugin(), createShellPlugin(), ...[...harnesses].reverse().map(fakeHarness)], {
    home: root,
    cwd: remote.repository,
    store,
    onLog: () => undefined,
  });
  return { root, remote, repository, store, registry };
}

async function must(store: ReturnType<typeof storeAt>, type: string, id: string): Promise<StoredObject> {
  const object = await store.get(type, id);
  if (object === undefined) throw new Error(`no ${type} ${id}`);
  return object;
}

function rigWith(harnesses: readonly string[]) {
  return rig(harnesses);
}

async function openChat(r: Awaited<ReturnType<typeof rig>>, args: Record<string, unknown> = {}): Promise<string> {
  const repo = await must(r.store, "repo", "repository");
  const run = await r.registry.runAction("dev/chat", args, {
    object: { type: "repo", id: repo.id, data: repo.data },
    actor: { via: "cli", id: "me" },
  });
  const id = /C-\d+/.exec(String(run.value))?.[0];
  if (id === undefined) throw new Error(`no chat id in ${String(run.value)}`);
  return id;
}

describe("dev:chat", () => {
  test("creates a chat under the repository, in the main clone, read-only", async () => {
    const r = await rig();
    const id = await openChat(r, { title: "About the build" });
    const chat = await must(r.store, CHAT_TYPE, id);
    expect(chat.data).toMatchObject({
      parent: "repo:repository",
      harness: "claude",
      cwd: r.remote.repository,
      title: "About the build",
      skills: [],
      channels: [],
    });
    expect((chat.data.access as Record<string, unknown>).readOnly).toBe(true);
    expect(chat.data.session).toBeNull();
    // It shows under the repository.
    const row = r.registry.viewsFor("chat")?.views.row(chat);
    expect(row?.parent).toBe("repo:repository");
  });

  test("the harness is the one given, else the first offered one that is loaded", async () => {
    const r = await rig();
    const given = await openChat(r, { harness: "pi" });
    expect((await must(r.store, CHAT_TYPE, given)).data.harness).toBe("pi");
    const second = await openChat(r);
    expect((await must(r.store, CHAT_TYPE, second)).data.harness).toBe("claude");
  });

  test("radian is refused by the choice, and when it is the only one loaded the run says so", async () => {
    const r = await rig();
    await expect(openChat(r, { harness: "radian" })).rejects.toThrow(
      'args.harness: "radian" is not one of "claude", "pi"',
    );
    const alone = await rigWith(["radian"]);
    await expect(openChat(alone)).rejects.toThrow("no harness for a repository chat is loaded");
  });

  test("a harness outside the choice is refused by the schema before the run", async () => {
    const r = await rig();
    await expect(openChat(r, { harness: "Claude" })).rejects.toThrow(
      'action "dev:chat": args.harness: "Claude" is not one of "claude", "pi"',
    );
    expect((await r.store.list(CHAT_TYPE)).objects).toEqual([]);
  });

  test("a harness that is not loaded or not offered is refused and the usable ones are named", async () => {
    const r = await rigWith(["radian", "pi"]);
    await expect(openChat(r, { harness: "claude" })).rejects.toThrow(
      'harness "claude" is not offered for a repository chat; the loaded ones that are: pi',
    );
    expect((await must(r.store, CHAT_TYPE, await openChat(r))).data.harness).toBe("pi");
  });

  test("the profile keeps the agent out of the operad command", async () => {
    const r = await rig();
    const id = await openChat(r);
    const access = (await must(r.store, CHAT_TYPE, id)).data.access as Record<string, unknown>;
    expect(access.denyCommands).toContain("operad");
  });

  test("the action lists its harness choices, keeps the field optional and says radian is not offered", () => {
    const action = chatActions[0];
    expect(action?.args?.description).toContain(RADIAN_NOTE);
    expect(action?.args?.description).toContain("radian is not offered here");
    expect(action?.args?.properties?.harness?.enum).toEqual([...CHAT_HARNESSES]);
    expect(action?.args?.properties?.harness?.description).toBe(
      "Which harness runs the chat; the first loaded one when left out. It cannot change later.",
    );
    expect(action?.args?.required ?? []).not.toContain("harness");
  });
});

describe("dev/chat_worktree", () => {
  test("opens work/chat-<id>, moves the working directory there once, and it is writable there", async () => {
    const r = await rig();
    const id = await openChat(r);
    const run = (runId: string) =>
      r.registry.runStep("dev/chat_worktree", {}, { runId, object: { type: CHAT_TYPE, id, data: {} } });

    const first = await run("run-1");
    expect(first.result).toBe("done");
    const path = join(r.remote.repository, ".operad-worktrees", `chat-${id}`);
    expect(first.data).toMatchObject({ moved: true, path, branch: `work/chat-${id}` });
    expect(existsSync(path)).toBe(true);
    expect(git(path, ["rev-parse", "--abbrev-ref", "HEAD"]).out).toBe(`work/chat-${id}`);
    const moved = await must(r.store, CHAT_TYPE, id);
    expect(moved.data.cwd).toBe(path);
    expect((moved.data.access as Record<string, unknown>).readOnly).toBe(false);
    // The main clone stays where it was.
    expect(git(r.remote.repository, ["rev-parse", "--abbrev-ref", "HEAD"]).out).toBe("main");

    const again = await run("run-2");
    expect(again).toMatchObject({ result: "done", data: { moved: false } });
    const unchanged = await must(r.store, CHAT_TYPE, id);
    expect(unchanged.version).toBe(moved.version);
    expect(unchanged.data.cwd).toBe(path);
  });

  test("a chat that is not about a repository is refused", async () => {
    const r = await rig();
    const id = await createChat(r.store, { harness: "claude", cwd: r.root, title: "loose" }, "test");
    const result = await r.registry.runStep("dev/chat_worktree", {}, {
      runId: "run-1",
      object: { type: CHAT_TYPE, id, data: {} },
    });
    expect(result.result).toBe("failed");
    expect((await must(r.store, CHAT_TYPE, id)).data.cwd).toBe(r.root);
  });

  test("the plugin's rule starts the flow when a chat's worktree is said yes to", async () => {
    const r = await rig();
    const rule = r.registry
      .triggerRules()
      .map((entry) => entry.rule)
      .find((candidate) => candidate.type === "chat.worktree");
    expect(rule).toMatchObject({ source: "operad", start: { flow: "dev:chat-worktree" }, object: "$event.object", mode: "auto" });
    expect(r.registry.flow("dev:chat-worktree")).toBeDefined();
    expect(r.registry.startProblem("dev:chat-worktree")).toBeUndefined();
  });
});

describe("task add --chat", () => {
  async function addFromChat(r: Awaited<ReturnType<typeof rig>>, chat: string): Promise<string> {
    const plan = await addPlan(r.store, { repository: r.repository, slug: "plan", title: "Plan", request: "go" });
    const task = commands.find((command) => command.name === "task");
    const context = { store: r.store, cwd: r.remote.repository, input: "Change it.\n" } as unknown as CommandContext;
    return String(
      await task?.run(context, ["add", "--plan", plan.id.slice(plan.id.indexOf("/") + 1), "--slug", "t", "--title", "T", "--chat", chat]),
    );
  }

  test("a chat that has its worktree gives the task that worktree", async () => {
    const r = await rig();
    const id = await openChat(r);
    await r.registry.runStep("dev/chat_worktree", {}, { runId: "run-1", object: { type: CHAT_TYPE, id, data: {} } });
    await addFromChat(r, id);
    const stored = (await r.store.list("task")).objects[0];
    expect(stored === undefined ? undefined : taskData(stored.data).worktree).toBe(`chat-${id}`);
  });

  test("the task's worktree step uses the chat's worktree and branch", async () => {
    const r = await rig();
    const id = await openChat(r);
    await r.registry.runStep("dev/chat_worktree", {}, { runId: "run-1", object: { type: CHAT_TYPE, id, data: {} } });
    await addFromChat(r, id);
    const stored = (await r.store.list("task")).objects[0];
    if (stored === undefined) throw new Error("no task");
    const result = await r.registry.runStep("dev/worktree", {}, { runId: "run-2", object: { type: "task", id: stored.id, data: {} } });
    expect(result.result).toBe("ready");
    const attempt = taskData((await must(r.store, "task", stored.id)).data).attempt;
    expect(attempt?.branch).toBe(`work/chat-${id}`);
    expect(attempt?.worktree).toBe(join(r.remote.repository, ".operad-worktrees", `chat-${id}`));
    // The task opened no worktree of its own.
    expect(existsSync(join(r.remote.repository, ".operad-worktrees", stored.id.slice(stored.id.indexOf("/") + 1)))).toBe(false);
  });

  test("a chat without a worktree, or one that does not exist, is refused and adds no task", async () => {
    const r = await rig();
    const id = await openChat(r);
    await expect(addFromChat(r, id)).rejects.toThrow(/has no worktree yet/);
    await expect(addFromChat(r, "C-999")).rejects.toThrow(/there is no chat/);
    expect((await r.store.list("task")).objects).toHaveLength(0);
  });

  test("a chat whose recorded worktree was removed is refused", async () => {
    const r = await rig();
    const id = await openChat(r);
    await r.registry.runStep("dev/chat_worktree", {}, { runId: "run-1", object: { type: CHAT_TYPE, id, data: {} } });
    const path = join(r.remote.repository, ".operad-worktrees", `chat-${id}`);
    git(r.remote.repository, ["worktree", "remove", "--force", path]);
    await expect(addFromChat(r, id)).rejects.toThrow(/is gone/);
    expect((await r.store.list("task")).objects).toHaveLength(0);
  });

  test("cleanup after the merge leaves the chat's worktree and branch", async () => {
    const r = await rig();
    const id = await openChat(r);
    await r.registry.runStep("dev/chat_worktree", {}, { runId: "run-1", object: { type: CHAT_TYPE, id, data: {} } });
    await addFromChat(r, id);
    const stored = (await r.store.list("task")).objects[0];
    if (stored === undefined) throw new Error("no task");
    const cleaned = await r.registry.runStep("dev/cleanup", {}, { runId: "run-2", object: { type: "task", id: stored.id, data: {} } });
    expect(cleaned.result).not.toBe("failed");
    const path = join(r.remote.repository, ".operad-worktrees", `chat-${id}`);
    expect(existsSync(path)).toBe(true);
    expect(git(r.remote.repository, ["rev-parse", "--verify", "--quiet", `refs/heads/work/chat-${id}`]).ok).toBe(true);
  });
});
