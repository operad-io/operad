import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { realGitFinderHost } from "@operad-io/engine/platform";
import {
  DEFAULT_GITIGNORE,
  FIRST_COMMIT_FILE_LIMIT,
  applySetupGit,
  firstCommitList,
  gitignoreProblem,
  refuseUnsafeFolder,
  registerRequested,
  registerRequestsDirectory,
  registerStanding,
} from "../src/index.ts";
import { storeAt } from "./support.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "setup-git-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function folder(files: Record<string, string> = {}): string {
  const dir = join(scratch, `f${counter++}`);
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

/** An environment whose git configuration is only what the test writes. */
function envWith(config: string): NodeJS.ProcessEnv {
  const file = join(scratch, `config-${counter++}`);
  writeFileSync(file, config);
  return { PATH: process.env.PATH, HOME: scratch, GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: "1" };
}
const NO_IDENTITY = envWith("[init]\n\tdefaultBranch = master\n");
const WITH_IDENTITY = envWith("[user]\n\tname = Ada\n\temail = ada@example.com\n");

const ME = { name: "Grace", email: "grace@example.com" };
const lockHome = join(scratch, "lock-home");
const options = { env: NO_IDENTITY, home: join(scratch, "not-a-folder-home"), lock: { home: lockHome } };

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args], env: NO_IDENTITY, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

describe("the file list for the first commit", () => {
  test("is made without writing anything into the folder, honours the text, and lists nested repositories apart", () => {
    const dir = folder({ "a.txt": "a", "src/b.ts": "b", "node_modules/x/y.js": "y", ".env": "SECRET=1", ".operad-worktrees/t/f": "w", ".radian-sandbox/g": "g" });
    Bun.spawnSync({ cmd: ["git", "init", "-q", join(dir, "vendored")] });
    writeFileSync(join(dir, "vendored", "f"), "f");
    const before = readdirSync(dir).sort();
    const list = firstCommitList(dir, DEFAULT_GITIGNORE, options);
    expect(list.files).toEqual([".gitignore", "a.txt", "src/b.ts"]);
    expect(list.nested).toEqual(["vendored/"]);
    expect(list.large).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(before);
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  test("above the limit it says to check the .gitignore", () => {
    const dir = folder();
    mkdirSync(join(dir, "many"));
    for (let i = 0; i <= FIRST_COMMIT_FILE_LIMIT; i++) writeFileSync(join(dir, "many", `f${i}`), "");
    const list = firstCommitList(dir, DEFAULT_GITIGNORE, options);
    expect(list.large).toBe(true);
    expect(list.note).toContain("Check the .gitignore");
    const small = firstCommitList(folder({ "a": "a" }), DEFAULT_GITIGNORE, options);
    expect(small.note).toBeUndefined();
  });

  test("the home folder and a disk root are refused", () => {
    expect(() => firstCommitList(scratch, DEFAULT_GITIGNORE, { ...options, home: scratch })).toThrow("home folder");
    expect(() => refuseUnsafeFolder(parse(scratch).root, "/nowhere")).toThrow("top of a disk");
  });
});

describe("the .gitignore text check", () => {
  test("accepts the defaults and refuses text that lets a secret in, a null byte or a huge text", () => {
    expect(gitignoreProblem(DEFAULT_GITIGNORE, options)).toBeUndefined();
    expect(gitignoreProblem("node_modules/\n", options)).toContain(".env");
    expect(gitignoreProblem(`${DEFAULT_GITIGNORE}!.env\n`, options)).toContain(".env");
    expect(gitignoreProblem("a\0b", options)).toContain("null byte");
    expect(gitignoreProblem("x".repeat(200_000), options)).toContain("longer");
  });
});

describe("applySetupGit", () => {
  test("makes a branch-mode repository without a remote, committing only the approved paths", async () => {
    const dir = folder({ "a.txt": "a", "src/b.ts": "b", ".operad/dev.json": JSON.stringify({ name: "x", remote: "origin", workIn: "worktree" }) });
    const list = firstCommitList(dir, DEFAULT_GITIGNORE, options);
    // Written after the list was shown: not approved, so not committed.
    writeFileSync(join(dir, "later.txt"), "late");
    const result = await applySetupGit({ path: dir, gitignore: DEFAULT_GITIGNORE, paths: list.files, identity: ME }, options);
    expect(result.outcome).toBe("set up");
    expect(result.branch).toBe("main");
    expect(git(dir, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD").split("\n")).toEqual([".gitignore", ".operad/dev.json", "a.txt", "src/b.ts"]);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(DEFAULT_GITIGNORE);
    expect(git(dir, "config", "--local", "user.name")).toBe("Grace");
    expect(git(dir, "log", "-1", "--format=%ae")).toBe("grace@example.com");
    expect(git(dir, "remote")).toBe("");
    const settings = JSON.parse(readFileSync(join(dir, ".operad", "dev.json"), "utf8")) as Record<string, unknown>;
    expect(settings.workIn).toBe("branch");
    expect(settings.remote).toBeUndefined();
    expect(readFileSync(join(dir, ".git", "info", "exclude"), "utf8")).toContain(".operad-worktrees/");
    expect(git(dir, "status", "--porcelain")).toBe("?? later.txt");
  });

  test("again after it ended does nothing more", async () => {
    const dir = folder({ "a.txt": "a" });
    const request = { path: dir, gitignore: DEFAULT_GITIGNORE, paths: ["a.txt"], identity: ME };
    await applySetupGit(request, options);
    const head = git(dir, "rev-parse", "HEAD");
    const again = await applySetupGit(request, options);
    expect(again.outcome).toBe("already");
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("1");
  });

  test("an unborn branch with another name is kept and becomes mainBranch", async () => {
    const dir = folder({ "a.txt": "a" });
    git(dir, "init", "-q");
    git(dir, "symbolic-ref", "HEAD", "refs/heads/trunk");
    await applySetupGit({ path: dir, gitignore: DEFAULT_GITIGNORE, paths: ["a.txt"], identity: ME }, options);
    expect(git(dir, "symbolic-ref", "--short", "HEAD")).toBe("trunk");
    const settings = JSON.parse(readFileSync(join(dir, ".operad", "dev.json"), "utf8")) as Record<string, unknown>;
    expect(settings.mainBranch).toBe("trunk");
  });

  test("what was staged before is not in the commit", async () => {
    const dir = folder({ "a.txt": "a", "secret.txt": "s" });
    git(dir, "init", "-q");
    git(dir, "add", "secret.txt");
    await applySetupGit({ path: dir, gitignore: DEFAULT_GITIGNORE, paths: ["a.txt"], identity: ME }, options);
    expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("secret.txt");
  });

  test("without a name and email anywhere it refuses and leaves no repository", async () => {
    const dir = folder({ "a.txt": "a" });
    await expect(applySetupGit({ path: dir, gitignore: DEFAULT_GITIGNORE, paths: ["a.txt"] }, options)).rejects.toThrow("no name and email");
    expect(existsSync(join(dir, ".git"))).toBe(false);
    // The identity git already has is used when the request gives none.
    await applySetupGit({ path: dir, gitignore: DEFAULT_GITIGNORE, paths: ["a.txt"] }, { ...options, env: WITH_IDENTITY });
    expect(git(dir, "log", "-1", "--format=%an")).toBe("Ada");
  });

  test("refuses the home folder, a subfolder (naming the root), a bad .gitignore and a machine without git", async () => {
    const dir = folder({ "a.txt": "a" });
    const request = { path: dir, gitignore: DEFAULT_GITIGNORE, paths: ["a.txt"], identity: ME };
    await expect(applySetupGit(request, { ...options, home: dir })).rejects.toThrow("home folder");
    await expect(applySetupGit({ ...request, gitignore: "" }, options)).rejects.toThrow(".env");
    await expect(
      applySetupGit(request, { ...options, state: { finder: { ...realGitFinderHost(), platform: "linux", env: { PATH: "" }, which: () => null } } }),
    ).rejects.toThrow("not installed");
    const root = folder({ "a.txt": "a" });
    await applySetupGit({ ...request, path: root }, options);
    mkdirSync(join(root, "sub"));
    await expect(applySetupGit({ ...request, path: join(root, "sub") }, options)).rejects.toThrow(root);
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  test("paths outside the folder are refused", async () => {
    const dir = folder({ "a.txt": "a" });
    const request = { path: dir, gitignore: DEFAULT_GITIGNORE, identity: ME };
    await expect(applySetupGit({ ...request, paths: ["../x"] }, options)).rejects.toThrow("not a path");
    await expect(applySetupGit({ ...request, paths: [".git/config"] }, options)).rejects.toThrow("not a path");
  });

  test("a process killed after git init and before the commit is finished by the next run", async () => {
    const dir = folder({ "a.txt": "a", "b.txt": "b" });
    const request = { path: dir, gitignore: DEFAULT_GITIGNORE, paths: ["a.txt", "b.txt"], identity: ME };
    const child = Bun.spawn({
      cmd: [process.execPath, join(import.meta.dir, "fixtures", "setup-git-child.ts"), dir, options.home, lockHome, JSON.stringify(request)],
      env: NO_IDENTITY,
      stdout: "ignore",
      stderr: "pipe",
    });
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    // It died with a repository and no commit.
    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(Bun.spawnSync({ cmd: ["git", "-C", dir, "rev-parse", "--verify", "-q", "HEAD"], env: NO_IDENTITY }).exitCode).not.toBe(0);

    const result = await applySetupGit(request, options);
    expect(result.outcome).toBe("set up");
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD").split("\n")).toEqual([".gitignore", ".operad/dev.json", "a.txt", "b.txt"]);
  });
});

describe("a request to set up git, carried by the request file", () => {
  async function rig() {
    const root = realpathSync(mkdtempSync(join(scratch, "req-")));
    const home = join(root, "home");
    mkdirSync(registerRequestsDirectory(home), { recursive: true });
    return { root, home, ctx: { home, cwd: root, store: storeAt(root) } };
  }

  test("is applied on a tick and its file is removed", async () => {
    const r = await rig();
    const dir = folder({ "a.txt": "a" });
    writeFileSync(
      join(registerRequestsDirectory(r.home), "g.json"),
      JSON.stringify({ kind: "setup-git", path: dir, gitignore: DEFAULT_GITIGNORE, paths: ["a.txt"], identity: ME }),
    );
    await registerRequested(r.ctx);
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("1");
    expect(readdirSync(registerRequestsDirectory(r.home))).toEqual([]);
  });

  test("one that fails stays whole with its reason and is a pending item", async () => {
    const r = await rig();
    const dir = folder({ "a.txt": "a" });
    // Not a folder git can use: its path is a file.
    const file = join(dir, "a.txt");
    const body = { kind: "setup-git", path: file, gitignore: DEFAULT_GITIGNORE, paths: ["a.txt"] };
    writeFileSync(join(registerRequestsDirectory(r.home), "g.json"), JSON.stringify(body));
    await registerRequested(r.ctx);
    const kept = JSON.parse(readFileSync(join(registerRequestsDirectory(r.home), "g.json"), "utf8")) as Record<string, unknown>;
    expect(kept.kind).toBe("setup-git");
    expect(kept.paths).toEqual(["a.txt"]);
    expect(typeof kept.error).toBe("string");
    const items = registerStanding(r.home);
    expect(items).toHaveLength(1);
    expect(items[0]?.prompt).toContain("git could not be set up");
    expect(items[0]?.prompt).toContain(file);
  });
});

describe("a folder that already has a .gitignore", () => {
  const custom = "*.log\nprivate-dir/\n";

  test("the list returns its text, and a proposal that keeps every line commits and keeps the line", async () => {
    const dir = folder({ "a.txt": "a", ".gitignore": custom, "x.log": "l", "private-dir/s": "s" });
    const text = `${custom}${DEFAULT_GITIGNORE}`;
    const list = firstCommitList(dir, text, options);
    expect(list.existingGitignore).toBe(custom);
    // The folder's own rules still apply: the ignored files are not listed.
    expect(list.files).toEqual([".gitignore", "a.txt"]);
    await applySetupGit({ path: dir, gitignore: text, paths: list.files, identity: ME }, options);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("private-dir/");
    expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD").split("\n")).toEqual([".gitignore", ".operad/dev.json", "a.txt"]);
    expect(firstCommitList(folder({ a: "a" }), DEFAULT_GITIGNORE, options).existingGitignore).toBeUndefined();
  });

  test("a text that drops a line is refused and nothing in the folder changes", async () => {
    const dir = folder({ "a.txt": "a", ".gitignore": custom });
    const before = readdirSync(dir).sort();
    expect(() => firstCommitList(dir, DEFAULT_GITIGNORE, options)).toThrow("private-dir/");
    await expect(
      applySetupGit({ path: dir, gitignore: DEFAULT_GITIGNORE, paths: ["a.txt"], identity: ME }, options),
    ).rejects.toThrow("would drop these lines: *.log, private-dir/");
    expect(readdirSync(dir).sort()).toEqual(before);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(custom);
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(existsSync(join(dir, ".operad"))).toBe(false);
  });
});
