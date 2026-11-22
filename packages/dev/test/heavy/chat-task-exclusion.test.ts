/**
 * A repository chat and a task do not write in the main clone at the same time
 * (`workIn` `branch`, ADR 0028 D3, ADR 0039 D3; T-0721): a held clone makes the
 * chat's reply read-only and says why, and a task does not start while a reply
 * that can write there is being written.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHAT_TYPE, createChatPlugin } from "@operad-io/chat";
import { PluginRegistry, definePlugin } from "@operad-io/engine";
import { createPoolPlugin } from "@operad-io/pool";
import { createShellPlugin } from "@operad-io/shell";
import {
  addPlan,
  addRepository,
  addTask,
  cancelTask,
  confirmPlan,
  createDevPlugin,
  taskData,
} from "../../src/index.ts";
import { gitOrThrow, makeRemote } from "../git-support.ts";
import { cleanupTempRoots, guardLockHandles, storeAt, tempRoot } from "../support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const IDENT = ["-c", "user.name=test", "-c", "user.email=t@example.com"];

const harness = definePlugin({
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
      run: () => ({ result: "done", data: { finalMessage: "ok", sessionId: "s-1" } }),
    },
  ],
});

async function rig() {
  const root = await tempRoot();
  const remote = await makeRemote(root);
  const clone = remote.repository;
  const store = storeAt(root);
  const repository = await addRepository(store, { path: clone, name: "repository" });
  mkdirSync(join(clone, ".operad"), { recursive: true });
  writeFileSync(
    join(clone, ".operad", "dev.json"),
    JSON.stringify({
      name: "repository",
      remote: "origin",
      mainBranch: "main",
      workIn: "branch",
      gate: { commands: ["true"], commandTimeoutSecs: 60 },
    }),
  );
  gitOrThrow(clone, ["add", ".operad/dev.json"]);
  gitOrThrow(clone, [...IDENT, "commit", "-qm", "settings"]);
  gitOrThrow(clone, ["push", "origin", "main"]);
  const plan = await addPlan(store, { repository, slug: "plan", title: "Plan", request: "do it" });
  const one = await addTask(store, { plan: plan.id, slug: "one", title: "One", brief: "Do one." });
  await confirmPlan(store, plan.id);
  const registry = new PluginRegistry(
    [createChatPlugin(), createDevPlugin(), createPoolPlugin(), createShellPlugin(), harness],
    { home: root, cwd: clone, store },
  );
  return { root, clone, store, registry, task: one.id };
}
type Rig = Awaited<ReturnType<typeof rig>>;

async function openChat(r: Rig): Promise<string> {
  const repo = await r.store.get("repo", "repository");
  if (repo === undefined) throw new Error("no repository");
  const run = await r.registry.runAction("dev/chat", {}, {
    object: { type: "repo", id: "repository", data: repo.data },
    actor: { via: "cli", id: "me" },
  });
  const id = /C-\d+/.exec(String(run.value))?.[0];
  if (id === undefined) throw new Error(`no chat id in ${String(run.value)}`);
  return id;
}

async function setLevel(r: Rig, id: string, level: string): Promise<void> {
  const stored = await r.store.get(CHAT_TYPE, id);
  if (stored === undefined) throw new Error("no chat");
  r.store.put(CHAT_TYPE, id, { ...stored.data, accessLevel: level }, "test");
}

/** Marks a reply of the chat as being written: its run started and nothing ended it. */
async function startReply(r: Rig, id: string): Promise<void> {
  await r.store.append({
    type: "chat.run",
    object: { type: CHAT_TYPE, id },
    cause: "test",
    data: { runId: `reply-${id}` },
  });
}

async function settings(r: Rig, id: string) {
  const stored = await r.store.get(CHAT_TYPE, id);
  if (stored === undefined) throw new Error("no chat");
  const result = await r.registry.runStep("dev/chat_settings", { chat: id }, {
    runId: "run-settings",
    object: { type: CHAT_TYPE, id, data: stored.data },
  });
  return result.data as {
    context: { where: string; text: string };
    access: { readOnly: boolean };
    worktreeOffer?: boolean;
  };
}

function startTask(r: Rig, runId: string) {
  return r.registry.runStep("dev/worktree", {}, {
    runId,
    object: { type: "task", id: r.task, data: {} },
  });
}

function head(dir: string): string {
  return gitOrThrow(dir, ["symbolic-ref", "--short", "HEAD"]);
}

describe("a task that holds the main clone makes a repository chat read-only", () => {
  test("the reply is read-only, offers no worktree, and its context says why and what to do", async () => {
    const r = await rig();
    const id = await openChat(r);
    await setLevel(r, id, "edits");
    const before = await settings(r, id);
    expect(before.access.readOnly).toBe(false);

    const started = await startTask(r, "run-1");
    expect(started.result).toBe("ready");
    const task = r.task.slice(r.task.indexOf("/") + 1);

    const held = await settings(r, id);
    expect(held.access.readOnly).toBe(true);
    expect(held.worktreeOffer).toBe(false);
    expect(held.context.where).toContain("read-only");
    expect(held.context.where).toContain(task);
    expect(held.context.where).toContain("merged, cancelled or rejected");
  }, 60_000);

  test("the chat writes again once the task is cancelled", async () => {
    const r = await rig();
    const id = await openChat(r);
    await setLevel(r, id, "full");
    await startTask(r, "run-1");
    expect((await settings(r, id)).access.readOnly).toBe(true);
    await cancelTask(r.store, r.task);
    const free = await settings(r, id);
    expect(free.access.readOnly).toBe(false);
    expect(free.context.where).not.toContain("read-only");
  }, 60_000);
});

describe("a task does not start while a chat reply that can write is live", () => {
  for (const level of ["edits", "full"]) {
    test(`a ${level} reply being written refuses the start and names the chat`, async () => {
      const r = await rig();
      const id = await openChat(r);
      await setLevel(r, id, level);
      await startReply(r, id);
      const started = await startTask(r, "run-1");
      expect(started.result).toBe("failed");
      expect(JSON.stringify(started.data)).toContain(id);
      expect(head(r.clone)).toBe("main");
      const task = await r.store.get("task", r.task);
      expect(taskData(task?.data ?? {}).attempt?.inPlace).not.toBe(true);
    }, 60_000);
  }

  test("a read-only reply (plan) does not stop the start", async () => {
    const r = await rig();
    const id = await openChat(r);
    await startReply(r, id);
    expect((await startTask(r, "run-1")).result).toBe("ready");
  }, 60_000);

  test("an edits chat with no reply running does not stop the start", async () => {
    const r = await rig();
    const id = await openChat(r);
    await setLevel(r, id, "edits");
    expect((await startTask(r, "run-1")).result).toBe("ready");
  }, 60_000);

  test("a task that already holds the clone starts its next attempt", async () => {
    const r = await rig();
    expect((await startTask(r, "run-1")).result).toBe("ready");
    const id = await openChat(r);
    await setLevel(r, id, "edits");
    await startReply(r, id);
    expect((await startTask(r, "run-2")).result).toBe("ready");
  }, 60_000);

  test("a refused start holds nothing: the chat stays writable and the next start is checked again", async () => {
    const r = await rig();
    const id = await openChat(r);
    await setLevel(r, id, "edits");
    await startReply(r, id);
    expect((await startTask(r, "run-1")).result).toBe("failed");
    expect((await settings(r, id)).access.readOnly).toBe(false);
    expect((await startTask(r, "run-2")).result).toBe("failed");
  }, 60_000);
});
