import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createChat } from "@operad-io/chat";
import { PluginRegistry } from "@operad-io/engine";
import {
  addRepository,
  CHAT_CONTEXT_PATH_MAX,
  createDevPlugin,
  repositoryChatContext,
} from "../../src/index.ts";
import { gitOrThrow } from "../git-support.ts";
import { cleanupTempRoots, makeGitRepository, storeAt, tempRoot } from "../support.ts";

afterAll(cleanupTempRoots);

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function track(repo: string, path: string): void {
  gitOrThrow(repo, ["add", path]);
  gitOrThrow(repo, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", path]);
}

function context(repo: string, overrides: Partial<Parameters<typeof repositoryChatContext>[0]> = {}) {
  return repositoryChatContext({
    repository: "repository",
    cwd: repo,
    readOnly: true,
    skills: [],
    denyCommands: ["operad"],
    ...overrides,
  });
}

describe("a repository chat's starting text", () => {
  test("names where it is and what is refused", async () => {
    const root = await tempRoot();
    const repo = await makeGitRepository(root);
    const answer = context(repo);
    expect(answer.where).toBe(
      [
        `You are answering in an operad chat about the repository repository, in ${repo}.`,
        "This chat is read-only in the main clone. Commands that only read run at once; a call that changes a file asks the person first.",
        "These commands are refused here: operad.",
        "Use the operad tools you were given to read plans, tasks and pending items.",
      ].join("\n"),
    );
    expect(answer.text.startsWith(answer.where)).toBe(true);

    expect(
      context(repo, { readOnly: false, branch: "work/chat-C-0001", denyCommands: [] }).where,
    ).toBe(
      [
        `You are answering in an operad chat about the repository repository, in ${repo}.`,
        "This chat works in its own worktree on the branch work/chat-C-0001. Changes reach main through a task, not by merging here.",
      ].join("\n"),
    );
  });

  test("uses AGENTS.md, CLAUDE.md only without it, and a link to the other once", async () => {
    const root = await tempRoot();
    const repo = await makeGitRepository(root);
    write(join(repo, "AGENTS.md"), "the AGENTS words\n");
    write(join(repo, "CLAUDE.md"), "the CLAUDE words\n");
    track(repo, "AGENTS.md");
    track(repo, "CLAUDE.md");

    const agents = context(repo);
    expect(agents.text).toContain("the AGENTS words");
    expect(agents.text).not.toContain("the CLAUDE words");

    unlinkSync(join(repo, "AGENTS.md"));
    const claude = context(repo);
    expect(claude.text).toContain("the CLAUDE words");
    expect(claude.text).not.toContain("the AGENTS words");

    write(join(repo, "CLAUDE.md"), "the shared words\n");
    symlinkSync("CLAUDE.md", join(repo, "AGENTS.md"));
    const linked = context(repo);
    expect(linked.text.split("the shared words").length - 1).toBe(1);
  });

  test("cuts a file over 32 KB at a line end and says where the whole file is", async () => {
    const root = await tempRoot();
    const repo = await makeGitRepository(root);
    const lines = Array.from({ length: 400 }, (_, index) => `line ${String(index).padStart(3, "0")} ${"y".repeat(88)}`);
    write(join(repo, "AGENTS.md"), `${lines.join("\n")}\n`);
    const answer = context(repo);
    const intro = "The repository's instructions follow. Follow them.\n\n";
    const start = answer.text.indexOf(intro) + intro.length;
    const note = `\n\nThe file was cut at 32 KB; the whole file is at ${join(repo, "AGENTS.md")}.`;
    const end = answer.text.indexOf(note);
    expect(end).toBeGreaterThan(start);
    const kept = answer.text.slice(start, end);
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(32 * 1024);
    expect(kept.split("\n").every((line) => /^line \d{3} y{88}$/.test(line))).toBe(true);
    expect(kept.endsWith("yyyy")).toBe(true);
  });

  test("lists other agent files by tracked path, leaving out untracked files and loaded skills", async () => {
    const root = await tempRoot();
    const repo = await makeGitRepository(root);
    const skill = join(repo, ".agents", "skills", "loaded");
    write(join(repo, "docs", "AGENTS.md"), "docs instructions\n");
    write(join(repo, "src", "deep", "AGENTS.md"), "deep instructions\n");
    write(join(skill, "SKILL.md"), "skill words\n");
    write(join(repo, ".agents", "rules", "team.md"), "team rules\n");
    write(join(repo, "hidden", "AGENTS.md"), "untracked instructions\n");
    track(repo, "docs/AGENTS.md");
    track(repo, "src/deep/AGENTS.md");
    track(repo, ".agents/skills/loaded/SKILL.md");
    track(repo, ".agents/rules/team.md");

    const answer = context(repo, { skills: [skill] });
    expect(answer.text).toContain(
      "Other agent files in this repository; read the ones that apply to what you work on:",
    );
    expect(answer.text).toContain("docs/AGENTS.md");
    expect(answer.text).toContain("src/deep/AGENTS.md");
    expect(answer.text).toContain(".agents/rules/team.md");
    expect(answer.text).not.toContain("hidden/AGENTS.md");
    expect(answer.text).not.toContain(".agents/skills/loaded/SKILL.md");
  });

  test("at most 50 paths, and says how many were left out", async () => {
    const root = await tempRoot();
    const repo = await makeGitRepository(root);
    for (let index = 0; index < CHAT_CONTEXT_PATH_MAX + 3; index += 1) {
      write(join(repo, "many", `n${String(index).padStart(2, "0")}`, "AGENTS.md"), "x\n");
    }
    track(repo, "many");
    const answer = context(repo);
    expect(answer.text).toContain("[3 more files were left out.]");
    const intro = "Other agent files in this repository; read the ones that apply to what you work on:\n";
    const start = answer.text.indexOf(intro) + intro.length;
    const listed = answer.text.slice(start).split("\n").filter((line) => line.startsWith("many/"));
    expect(listed).toHaveLength(CHAT_CONTEXT_PATH_MAX);
  });

  test("skips a link that leaves the repository, for both the text and the path list", async () => {
    const root = await tempRoot();
    const repo = await makeGitRepository(root);
    const outside = join(root, "outside.md");
    write(outside, "outside words\n");
    write(join(repo, "CLAUDE.md"), "inside words\n");
    symlinkSync(outside, join(repo, "AGENTS.md"));
    mkdirSync(join(repo, ".agents"), { recursive: true });
    symlinkSync(outside, join(repo, ".agents", "leak.md"));
    write(join(repo, "docs", "AGENTS.md"), "docs instructions\n");
    track(repo, "docs/AGENTS.md");

    const answer = context(repo);
    expect(answer.text).toContain("inside words");
    expect(answer.text).not.toContain("outside words");
    expect(answer.text).not.toContain(".agents/leak.md");
    expect(answer.text).toContain("docs/AGENTS.md");
  });
});

describe("dev/chat_settings and the starting text", () => {
  test("gives the text built for the chat's working directory, and its place alone after a move", async () => {
    const root = await tempRoot();
    const repo = await makeGitRepository(root);
    write(join(repo, "AGENTS.md"), "start here\n");
    track(repo, "AGENTS.md");
    const store = storeAt(root);
    await addRepository(store, { path: repo, name: "repository" });
    const registry = new PluginRegistry([createDevPlugin()], {
      home: root,
      cwd: repo,
      store,
      onLog: () => undefined,
    });
    const id = await createChat(
      store,
      {
        parent: "repo:repository",
        harness: "claude",
        cwd: repo,
        title: "chat",
        refresh: "dev/chat_settings",
      },
      "test",
    );
    const run = (runId: string) =>
      registry.runStep("dev/chat_settings", { chat: id }, {
        runId,
        object: { type: "chat", id, data: {} },
      });

    const first = await run("run-1");
    expect(first.result).toBe("done");
    const context = (first.data as { context: { where: string; text: string } }).context;
    expect(context.where).toContain(`about the repository repository, in ${repo}.`);
    expect(context.where).toContain("This chat is read-only in the main clone.");
    expect(context.text).toContain("start here");

    const stored = await store.get("chat", id);
    if (stored === undefined) throw new Error("no chat");
    const path = join(repo, ".operad-worktrees", `chat-${id}`);
    const branch = `work/chat-${id}`;
    await store.put("chat", id, { ...stored.data, cwd: path, worktree: { path, branch } }, "test");

    const moved = await run("run-2");
    expect(moved.result).toBe("done");
    const after = (moved.data as { context: { where: string } }).context;
    expect(after.where).toContain(`in ${path}.`);
    expect(after.where).toContain(`on the branch ${branch}.`);
    expect(after.where).not.toContain("read-only in the main clone");
  });
});
