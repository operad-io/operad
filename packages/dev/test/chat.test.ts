import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PluginRegistry, definePlugin, type StoredObject } from "@operad-io/engine";
import { createChatPlugin, createChat, CHAT_TYPE } from "@operad-io/chat";
import { createShellPlugin } from "@operad-io/shell";
import { addRepository, chatActions, createDevPlugin, RADIAN_NOTE } from "../src/index.ts";
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

async function rig(harnesses: readonly string[] = ['harness-radian', 'harness-pi', 'harness-claude']) {
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
      harness: "harness-claude",
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
    const given = await openChat(r, { harness: "harness-pi" });
    expect((await must(r.store, CHAT_TYPE, given)).data.harness).toBe("harness-pi");
    const second = await openChat(r);
    expect((await must(r.store, CHAT_TYPE, second)).data.harness).toBe("harness-claude");
  });

  test("harness-radian is refused with the reason, whether given or the only one loaded", async () => {
    const r = await rig();
    await expect(openChat(r, { harness: "harness-radian" })).rejects.toThrow("cannot stop a tool call before it starts");
    const alone = await rigWith(["harness-radian"]);
    await expect(openChat(alone)).rejects.toThrow("no harness for a repository chat is loaded");
  });

  test("a harness that is not loaded or not offered is refused and the usable ones are named", async () => {
    const r = await rigWith(["harness-radian", "harness-pi"]);
    await expect(openChat(r, { harness: "harness-claude" })).rejects.toThrow(
      'harness "harness-claude" is not offered for a repository chat; the loaded ones that are: harness-pi',
    );
    expect((await must(r.store, CHAT_TYPE, await openChat(r))).data.harness).toBe("harness-pi");
  });

  test("the profile keeps the agent out of the operad command", async () => {
    const r = await rig();
    const id = await openChat(r);
    const access = (await must(r.store, CHAT_TYPE, id)).data.access as Record<string, unknown>;
    expect(access.denyCommands).toContain("operad");
  });

  test("the action says up front that radian is not offered", () => {
    const action = chatActions[0];
    expect(action?.args?.description).toContain(RADIAN_NOTE);
    expect(action?.args?.description).toContain("harness-radian is not offered here");
    expect(action?.args?.properties?.harness?.enum).toBeUndefined();
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
    const id = await createChat(r.store, { harness: "harness-claude", cwd: r.root, title: "loose" }, "test");
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
