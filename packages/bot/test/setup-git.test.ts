import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createViews } from "@operad-io/engine";
import { DEFAULT_GITIGNORE, registerRequested } from "@operad-io/dev";
import type { GitFinderHost } from "@operad-io/engine/platform";
import {
  PROPOSAL_TYPE,
  SETUP_GIT_INSTRUCTION,
  accountIdentity,
  gitReview,
  proposalData,
  proposeGit,
  scheduledChatContext,
  titleLanguage,
} from "../src/index.ts";
import { cleanupRoots, rig } from "./support.ts";

// No identity anywhere: the computer's own git settings must not leak into a test.
const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await cleanupRoots();
});

type Rig = Awaited<ReturnType<typeof rig>>;

// No identity anywhere: the computer's own git settings must not leak into a test.
const NO_IDENTITY: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: "/nonexistent-home",
};

function folder(r: Rig, name = "plain"): string {
  const path = join(r.root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "main.txt"), "hello\n");
  mkdirSync(join(path, "node_modules"));
  writeFileSync(join(path, "node_modules", "dep.js"), "x\n");
  writeFileSync(join(path, ".env"), "SECRET=1\n");
  return path;
}

async function proposalId(r: Rig): Promise<string> {
  const id = (await r.registry.standing())[0]?.object?.id;
  if (id === undefined) throw new Error("no proposal item");
  return id;
}

async function reviewOf(r: Rig, id: string): Promise<string> {
  const views = createViews({ registry: r.registry, store: r.store, onLog: () => undefined });
  try {
    return (await views.section(`${PROPOSAL_TYPE}:${id}`, "review", undefined, { full: true })).markdown;
  } finally {
    views.close();
  }
}

describe("Set up git here, the bot's side", () => {
  test("with no input the command answers the steps: install per system, each an approved item, git never raised early", async () => {
    const r = await rig();
    const path = folder(r);
    const steps = String(await r.command("bot", "setup-git", ["default", path]));
    expect(steps).toContain(path);
    expect(steps).toContain("verb `setup-git`");
    expect(steps).toContain("xcode-select --install");
    expect(steps).toContain("winget install Git.Git");
    expect(steps).toContain("apt-get install -y git");
    expect(steps).toContain("approval I see in Pending");
    expect(steps).toContain("never raise git before that");
    expect(await r.registry.standing()).toEqual([]);
    expect(existsSync(join(path, ".git"))).toBe(false);
  });

  test("a bot chat starts with the line that says when the proposal is made and that git is not asked about before", async () => {
    expect(scheduledChatContext("C-1").text).toContain(SETUP_GIT_INSTRUCTION);
    expect(SETUP_GIT_INSTRUCTION).toContain("verb `setup-git`");
    expect(SETUP_GIT_INSTRUCTION).toContain("Never ask me about git before that");
    const r = await rig();
    const chat = await r.open("default");
    await r.say(chat, "hello");
    await r.reply(chat);
    expect(String(r.calls[0]?.params.prompt ?? "")).toContain("verb `setup-git`");
  });

  test("a proposal is a pending item titled Set up git here; the folder is untouched and the review shows the lists", async () => {
    const r = await rig();
    const path = folder(r);
    const said = String(await r.command("bot", "setup-git", ["default", path], "{}"));
    expect(said).toContain("proposed Set up git here");
    expect(existsSync(join(path, ".git"))).toBe(false);
    expect(existsSync(join(path, ".gitignore"))).toBe(false);
    expect(existsSync(join(r.home, "dev-register"))).toBe(false);

    const item = (await r.registry.standing())[0];
    expect(item?.prompt).toContain("Set up git here");
    expect(item?.prompt).toContain("proposed by bot default");
    const id = await proposalId(r);
    const stored = await r.store.get(PROPOSAL_TYPE, id);
    if (stored === undefined) throw new Error("no proposal");
    expect(proposalData(stored).kind).toBe("git");
    expect(proposalData(stored).title).toBe("Set up git here");

    const review = await reviewOf(r, id);
    expect(review).toContain("### .gitignore (new)");
    expect(review).toContain("node_modules/");
    expect(review).toContain("### Files in the first commit (2)");
    expect(review).toContain("main.txt");
    expect(review).not.toContain("dep.js");
    expect(review).not.toContain("SECRET");
    expect(review).toContain("Nothing is pushed");
  });

  test("approve leaves the request with the approved paths and the identity; reject leaves nothing", async () => {
    const r = await rig();
    const path = folder(r);
    await r.command("bot", "setup-git", ["default", path], JSON.stringify({ identity: { name: "Ada Lovelace", email: "ada@example.com" } }));
    const id = await proposalId(r);
    const review = await reviewOf(r, id);
    expect(review).toContain("- name: Ada Lovelace");
    await r.act(PROPOSAL_TYPE, id, "approve");
    const requests = readdirSync(join(r.home, "dev-register"));
    expect(requests).toHaveLength(1);
    const body = JSON.parse(readFileSync(join(r.home, "dev-register", requests[0] ?? ""), "utf8")) as Record<string, unknown>;
    expect(body.kind).toBe("setup-git");
    expect(body.path).toBe(realpathSync(path));
    expect(body.paths).toEqual([".gitignore", "main.txt"]);
    expect(String(body.gitignore)).toContain(".env*");
    expect(existsSync(join(path, ".git"))).toBe(false);

    const other = await rig();
    const otherPath = folder(other);
    await other.command("bot", "setup-git", ["default", otherPath], "{}");
    await other.act(PROPOSAL_TYPE, await proposalId(other), "reject");
    expect(existsSync(join(other.home, "dev-register"))).toBe(false);
    expect(existsSync(join(otherPath, ".git"))).toBe(false);
  });

  test("the identity: prefilled from the account when git has none, the person's own kept, a bad one refused", async () => {
    const r = await rig();
    const path = folder(r);
    const account = { username: () => "ada", hostname: () => "lab" };
    const prefilled = proposeGit(r.home, "default", path, "{}", r.root, { env: NO_IDENTITY, account });
    expect(prefilled.identity).toEqual({ name: "ada", email: "ada@lab" });
    const own = proposeGit(
      r.home,
      "default",
      path,
      JSON.stringify({ identity: { name: " Ada Lovelace ", email: "ada@example.com" } }),
      r.root,
      { env: NO_IDENTITY, account },
    );
    expect(own.identity).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
    expect(gitReview("default", own)).toContain("- email: ada@example.com");
    expect(gitReview("default", prefilled)).toContain("- name: ada");
    expect(() => proposeGit(r.home, "default", path, JSON.stringify({ identity: { name: "", email: "x@y.z" } }), r.root, { env: NO_IDENTITY })).toThrow(
      "identity needs a name",
    );
    expect(() => proposeGit(r.home, "default", path, JSON.stringify({ identity: { name: "A", email: "nope" } }), r.root, { env: NO_IDENTITY })).toThrow(
      "identity needs a name",
    );
    expect(() => proposeGit(r.home, "default", path, JSON.stringify({ identity: "Ada" }), r.root, { env: NO_IDENTITY })).toThrow(
      "name and an email",
    );
  });

  test("when git has an identity the proposal carries none and says so", async () => {
    const r = await rig();
    const path = folder(r);
    const config = join(r.root, "gitconfig");
    writeFileSync(config, "[user]\n\tname = Has One\n\temail = has@example.com\n");
    const change = proposeGit(r.home, "default", path, "{}", r.root, {
      env: { ...NO_IDENTITY, GIT_CONFIG_GLOBAL: config },
    });
    expect(change.identity).toBeNull();
    expect(gitReview("default", change)).toContain("Git already has them");
  });

  test("the title is Chinese when the computer's language is", async () => {
    expect(titleLanguage({ LANG: "zh_CN.UTF-8" })).toBe("zh");
    expect(titleLanguage({ LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" })).toBe("en");
    expect(titleLanguage({})).toBe("en");
    const r = await rig();
    const path = folder(r);
    const change = proposeGit(r.home, "default", path, "{}", r.root, { env: { ...NO_IDENTITY, LANG: "zh_CN.UTF-8" } });
    expect(change.language).toBe("zh");
    expect(gitReview("default", change)).toContain("## 在这里设置 git: ");
  });

  test("a folder's own .gitignore is kept and built on; a text that drops a line or lets a secret in is refused", async () => {
    const r = await rig();
    const path = folder(r);
    writeFileSync(join(path, ".gitignore"), "mine/\n*.log\n");
    mkdirSync(join(path, "mine"));
    writeFileSync(join(path, "mine", "x.txt"), "x\n");
    const change = proposeGit(r.home, "default", path, "{}", r.root, { env: NO_IDENTITY });
    expect(change.before).toBe("mine/\n*.log\n");
    expect(change.gitignore.startsWith("mine/\n*.log\n")).toBe(true);
    expect(change.gitignore).toContain(".env*");
    expect(change.files).not.toContain("mine/x.txt");
    expect(gitReview("default", change)).toContain("(yours, with additions)");
    expect(() => proposeGit(r.home, "default", path, JSON.stringify({ gitignore: DEFAULT_GITIGNORE }), r.root, { env: NO_IDENTITY })).toThrow(
      "would drop",
    );
    expect(() => proposeGit(r.home, "default", path, JSON.stringify({ gitignore: "mine/\n*.log\n" }), r.root, { env: NO_IDENTITY })).toThrow(
      "secret files must stay ignored",
    );
  });

  test("a large folder carries the note that asks to check the .gitignore, in the review", async () => {
    const r = await rig();
    const path = join(r.root, "big");
    mkdirSync(path);
    const names: string[] = [];
    for (let i = 0; i < 5001; i += 1) names.push(`f${i}`);
    for (const name of names) writeFileSync(join(path, name), "");
    const change = proposeGit(r.home, "default", path, "{}", r.root, { env: NO_IDENTITY });
    expect(change.note).toContain("more than 5000");
    const review = gitReview("default", change);
    expect(review).toContain("**This folder has 5002 files");
    expect(review).toContain("... and ");
    expect(change.files).toHaveLength(5002);
  });

  test("it refuses a subfolder naming the root, a folder that has its first commit, the home folder, and a machine without git", async () => {
    const r = await rig();
    const root = folder(r, "project");
    execFileSync("git", ["-C", root, "init", "-q"], { stdio: "ignore" });
    mkdirSync(join(root, "sub"));
    await expect(r.command("bot", "setup-git", ["default", join(root, "sub")], "{}")).rejects.toThrow(
      `inside the git repository at "${realpathSync(root)}"`,
    );
    // An unborn repository is proposed with its first commit and no `git init`.
    const unborn = proposeGit(r.home, "default", root, "{}", r.root, { env: NO_IDENTITY });
    expect(unborn.init).toBe(false);
    const fresh = proposeGit(r.home, "default", folder(r, "fresh"), "{}", r.root, { env: NO_IDENTITY });
    expect(fresh.init).toBe(true);
    execFileSync("git", ["-C", root, "-c", "user.name=a", "-c", "user.email=a@b.c", "commit", "-q", "--allow-empty", "-m", "x"], { stdio: "ignore" });
    await expect(r.command("bot", "setup-git", ["default", root], "{}")).rejects.toThrow("already has git and a first commit");

    const home = folder(r, "home-folder");
    expect(() => proposeGit(r.home, "default", home, "{}", r.root, { env: NO_IDENTITY, homeFolder: home })).toThrow("your home folder");

    const nowhere: GitFinderHost = {
      platform: "linux",
      env: {},
      which: () => null,
      exists: () => false,
      run: () => ({ code: 1, out: "" }),
    };
    expect(() => proposeGit(r.home, "default", folder(r, "nogit"), "{}", r.root, { env: NO_IDENTITY, finder: nowhere })).toThrow(
      "git is not installed",
    );
    await expect(r.command("bot", "setup-git", ["default", join(r.root, "missing")], "{}")).rejects.toThrow("there is no directory");
    await expect(r.command("bot", "setup-git", ["nobody", root], "{}")).rejects.toThrow('there is no bot "nobody"');
    await expect(r.command("bot", "setup-git", ["default", root], "[1]")).rejects.toThrow("must be a JSON object");
    await expect(r.command("bot", "setup-git", ["default", root], "not json")).rejects.toThrow("not JSON");
    await expect(r.command("bot", "setup-git", ["default"], "")).rejects.toThrow("usage: operad bot setup-git");
  });

  test("approval and dev together: the first commit holds exactly the approved paths, with the identity stored in the folder", async () => {
    const r = await rig();
    const path = folder(r);
    await r.command("bot", "setup-git", ["default", path], JSON.stringify({ identity: { name: "Ada", email: "ada@example.com" } }));
    const id = await proposalId(r);
    await r.act(PROPOSAL_TYPE, id, "approve");
    // A file a chat wrote after the review is not part of the commit.
    writeFileSync(join(path, "later.txt"), "later\n");
    await registerRequested({ home: r.home, cwd: r.root, store: r.store });
    const tracked = execFileSync("git", ["-C", path, "ls-files"], { encoding: "utf8" }).split("\n").filter((line) => line !== "");
    expect(tracked).toContain("main.txt");
    expect(tracked).toContain(".gitignore");
    expect(tracked).not.toContain("later.txt");
    expect(tracked).not.toContain(".env");
    expect(execFileSync("git", ["-C", path, "config", "--local", "user.email"], { encoding: "utf8" }).trim()).toBe("ada@example.com");
    expect(existsSync(join(r.home, "dev-register", readdirSync(join(r.home, "dev-register"))[0] ?? "none"))).toBe(false);
  });
});
