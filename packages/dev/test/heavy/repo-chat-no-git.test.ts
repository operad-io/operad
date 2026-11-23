import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHAT_TYPE, createChatPlugin } from "@operad-io/chat";
import { PluginRegistry, definePlugin } from "@operad-io/engine";
import { addRepository, createDevPlugin } from "../../src/index.ts";
import { cleanupTempRoots, guardLockHandles, storeAt, tempRoot } from "../support.ts";

afterAll(cleanupTempRoots);
guardLockHandles();

const harness = definePlugin({
  name: "claude",
  kind: "harness",
  version: "0.0.0",
  capabilities: { accessLevels: ["plan", "ask", "edits", "full"] },
  models: { list: ["claude-a"], default: "claude-a" },
  efforts: { list: ["low"], default: "low", flag: "--effort" },
  steps: [{ name: "agent", results: ["done", "failed", "interrupted"], run: () => ({ result: "done" }) }],
});

// A folder with no git, added, with a chat open in it.
async function rig(workIn: "branch" | "worktree") {
  const root = await tempRoot();
  const store = storeAt(root);
  const folder = join(root, "plain");
  mkdirSync(folder, { recursive: true });
  await addRepository(store, { path: folder, name: "plain" });
  if (workIn === "worktree") {
    writeFileSync(join(folder, ".operad", "dev.json"), JSON.stringify({ workIn: "worktree" }));
  }
  const registry = new PluginRegistry([createChatPlugin(), createDevPlugin(), harness], {
    home: root,
    cwd: folder,
    store,
    onLog: () => undefined,
  });
  const repo = await store.get("repo", "plain");
  if (repo === undefined) throw new Error("no repository");
  const run = await registry.runAction("dev/chat", {}, {
    object: { type: "repo", id: "plain", data: repo.data },
    actor: { via: "cli", id: "me" },
  });
  const id = /C-\d+/.exec(String(run.value))?.[0];
  if (id === undefined) throw new Error("no chat");
  return { folder, store, registry, id };
}

describe("a chat in a folder without git", () => {
  test("opens, and its context says there is no git and the chat may change files", async () => {
    const r = await rig("branch");
    writeFileSync(join(r.folder, "AGENTS.md"), "plain words\n");
    const result = await r.registry.runStep("dev/chat_settings", { chat: r.id }, {
      runId: "run-1",
      object: { type: CHAT_TYPE, id: r.id, data: {} },
    });
    expect(result.result).toBe("done");
    const data = result.data as { context: { where: string; text: string } };
    expect(data.context.where).toContain("This folder has no git");
    expect(data.context.where).toContain("may change files here");
    expect(data.context.text).toContain("plain words");
    expect(existsSync(join(r.folder, ".git"))).toBe(false);
  });

  test("a worktree is refused, by the step and by the access change, and the chat stays", async () => {
    const r = await rig("worktree");
    const step = await r.registry.runStep("dev/chat_worktree", {}, {
      runId: "run-1",
      object: { type: CHAT_TYPE, id: r.id, data: {} },
    });
    expect(step.result).toBe("failed");
    expect(JSON.stringify(step.data)).toContain("no git");

    const stored = await r.store.get(CHAT_TYPE, r.id);
    if (stored === undefined) throw new Error("no chat");
    await expect(
      r.registry.runAction("dev/chat_access", { level: "edits" }, {
        object: { type: CHAT_TYPE, id: r.id, data: stored.data },
        actor: { via: "cli", id: "me" },
      }),
    ).rejects.toThrow(/no git/);
    const after = await r.store.get(CHAT_TYPE, r.id);
    expect(after?.data.worktree).toBeUndefined();
    expect(after?.data.cwd).toBe(r.folder);
    expect(existsSync(join(r.folder, ".operad-worktrees"))).toBe(false);
    expect(existsSync(join(r.folder, ".git"))).toBe(false);
  });
});
