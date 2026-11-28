import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realGitFinderHost } from "@operad-io/engine/platform";
import { GitStateError, gitStateOf, taskRefusalOf } from "../src/git-state.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "git-state-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function folder(): string {
  const dir = join(scratch, `f${counter++}`);
  mkdirSync(dir);
  return dir;
}

/** An environment whose git configuration is only what the test writes. */
function envWith(config: string): NodeJS.ProcessEnv {
  const file = join(scratch, `config-${counter++}`);
  writeFileSync(file, config);
  return {
    PATH: process.env.PATH,
    HOME: scratch,
    GIT_CONFIG_GLOBAL: file,
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

const WITH_IDENTITY = envWith("[user]\n\tname = Ada\n\temail = ada@example.com\n");
const NO_IDENTITY = envWith("");

function run(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    env: WITH_IDENTITY,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

function commit(cwd: string): void {
  writeFileSync(join(cwd, "a.txt"), "a");
  run(cwd, "add", "a.txt");
  run(cwd, "commit", "-m", "first");
}

const state = (dir: string, env: NodeJS.ProcessEnv = WITH_IDENTITY) => gitStateOf(dir, { env });

describe("gitStateOf", () => {
  test("no program: nothing is spawned and no git fact is given", () => {
    const result = gitStateOf(folder(), {
      env: WITH_IDENTITY,
      finder: { ...realGitFinderHost(), platform: "linux", env: { PATH: "" }, which: () => null },
    });
    expect(result).toEqual({ state: "no program" });
  });

  test("a folder that does not exist or is a file is an error, not a state", () => {
    expect(() => state(join(scratch, "missing"))).toThrow("not a folder");
    const file = join(scratch, "plain-file");
    writeFileSync(file, "x");
    expect(() => state(file)).toThrow("not a folder");
  });

  test("a folder git refuses is an error with git's message, not no repository", () => {
    const dir = folder();
    const bin = join(scratch, `refusing-${Math.random().toString(36).slice(2)}`);
    mkdirSync(bin);
    const real = Bun.which("git");
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in *"rev-parse --show-toplevel"*) echo 'fatal: detected dubious ownership in repository at /x' >&2; exit 128;; esac\nexec '${real}' "$@"\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const env = { ...WITH_IDENTITY, PATH: `${bin}:${WITH_IDENTITY.PATH ?? ""}` };
    expect(() => state(dir, env)).toThrow(/dubious ownership/);
    expect(() => state(dir, env)).toThrow(GitStateError);
  });

  test("no repository", () => {
    expect(state(folder()).state).toBe("no repository");
  });

  test("no commit: an unborn branch is named as git names it", () => {
    const dir = folder();
    run(dir, "init");
    run(dir, "symbolic-ref", "HEAD", "refs/heads/trunk");
    expect(state(dir)).toMatchObject({ state: "no commit", branch: "trunk" });
  });

  test("no commit: a staged file does not make it ready", () => {
    const dir = folder();
    run(dir, "init");
    writeFileSync(join(dir, "x.txt"), "x");
    run(dir, "add", "x.txt");
    expect(state(dir).state).toBe("no commit");
  });

  test("ready, with the current branch", () => {
    const dir = folder();
    run(dir, "init");
    run(dir, "symbolic-ref", "HEAD", "refs/heads/main");
    commit(dir);
    expect(state(dir)).toMatchObject({ state: "ready", branch: "main" });
  });

  test("ready on a detached HEAD has no branch", () => {
    const dir = folder();
    run(dir, "init");
    commit(dir);
    run(dir, "checkout", "--detach");
    expect(state(dir)).toMatchObject({ state: "ready", branch: undefined });
  });

  test("subfolder names the root", () => {
    const root = folder();
    run(root, "init");
    commit(root);
    const inner = join(root, "pkg", "deep");
    mkdirSync(inner, { recursive: true });
    const result = state(inner);
    expect(result.state).toBe("subfolder");
    if (result.state === "subfolder") expect(realpathSync(result.root)).toBe(root);
  });

  test("a subfolder of a repository with no commit is still a subfolder", () => {
    const root = folder();
    run(root, "init");
    const inner = join(root, "pkg");
    mkdirSync(inner);
    expect(state(inner).state).toBe("subfolder");
  });

  test("a repository nested in another is its own root, not a subfolder", () => {
    const outer = folder();
    run(outer, "init");
    const inner = join(outer, "inner");
    mkdirSync(inner);
    run(inner, "init");
    expect(state(inner).state).toBe("no commit");
  });

  test("a folder reached through a symlink to the root is the root", () => {
    const root = folder();
    run(root, "init");
    const link = join(scratch, `link-${counter++}`);
    symlinkSync(root, link);
    expect(state(link).state).toBe("no commit");
  });

  test("identity is read from the configuration", () => {
    const dir = folder();
    expect(state(dir)).toMatchObject({
      identity: { name: "Ada", email: "ada@example.com", set: true },
    });
    expect(state(dir, NO_IDENTITY)).toMatchObject({
      identity: { name: undefined, email: undefined, set: false },
    });
  });

  test("identity needs both the name and the email", () => {
    const onlyName = envWith("[user]\n\tname = Ada\n");
    const onlyEmail = envWith("[user]\n\temail = ada@example.com\n");
    expect(state(folder(), onlyName)).toMatchObject({
      identity: { name: "Ada", email: undefined, set: false },
    });
    expect(state(folder(), onlyEmail)).toMatchObject({
      identity: { name: undefined, email: "ada@example.com", set: false },
    });
  });

  test("a repository's own configuration wins and an empty value is unset", () => {
    const dir = folder();
    run(dir, "init");
    run(dir, "config", "user.name", "Grace");
    run(dir, "config", "user.email", "");
    expect(state(dir)).toMatchObject({
      identity: { name: "Grace", email: undefined, set: false },
    });
  });
});

describe("taskRefusalOf", () => {
  // Every new plan and task asks this, so each extra git run is paid often.
  test("a ready folder costs two git runs, for the root and the commit", () => {
    const dir = folder();
    run(dir, "init");
    commit(dir);
    const bin = join(scratch, `logging-${counter++}`);
    mkdirSync(bin);
    const log = join(bin, "log");
    const real = Bun.which("git");
    writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$3 $4" >> '${log}'\nexec '${real}' "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const env = { ...WITH_IDENTITY, PATH: `${bin}:${WITH_IDENTITY.PATH ?? ""}` };

    expect(taskRefusalOf(dir, { env })).toBeUndefined();
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "rev-parse --show-toplevel",
      "rev-parse --verify",
    ]);
  });
});
