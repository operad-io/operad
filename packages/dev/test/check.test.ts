import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { PluginRegistry } from "@operad-io/engine";
import { createDevPlugin } from "../src/index.ts";
import { addRepository, listRepositories } from "../src/service.ts";
import { cleanupTempRoots, storeAt, tempRoot } from "./support.ts";
import { silentGit } from "./git-support.ts";

afterAll(cleanupTempRoots);

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

interface Fixture {
  readonly root: string;
  readonly remote: string;
  readonly repositoryPath: string;
}

interface FixtureOptions {
  /** Whether the work tree already pushed its main branch to the remote. */
  readonly pushMain?: boolean;
}

/** A bare remote and a work tree with one commit. */
async function setup(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await tempRoot();
  const remote = join(root, "origin.git");
  git(root, ["init", "--bare", "-q", remote]);
  const repositoryPath = join(root, "repository");
  git(root, ["init", "-q", "-b", "main", repositoryPath]);
  writeFileSync(join(repositoryPath, "README.md"), "# test\n");
  git(repositoryPath, ["add", "README.md"]);
  git(repositoryPath, [
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-qm",
    "start",
  ]);
  git(repositoryPath, ["remote", "add", "origin", remote]);
  if (options.pushMain !== false) {
    git(repositoryPath, ["push", "-q", "-u", "origin", "main"]);
  }
  return { root, remote, repositoryPath };
}

/** The full ref list of a remote, with each ref's commit, for a before/after. */
function refs(remote: string): string {
  return git(remote, ["for-each-ref", "--format=%(refname) %(objectname)"]);
}

function writeSettings(
  repositoryPath: string,
  value: Readonly<Record<string, unknown>>,
): void {
  mkdirSync(join(repositoryPath, ".operad"), { recursive: true });
  writeFileSync(
    join(repositoryPath, ".operad", "dev.json"),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function registryAt(
  root: string,
  store: ReturnType<typeof storeAt>,
  repositoryPath: string,
): PluginRegistry {
  return new PluginRegistry([createDevPlugin()], {
    home: root,
    cwd: repositoryPath,
    store,
  });
}

/**
 * A `git` first on PATH that records its arguments and then runs the real one.
 * It proves which form the check invoked: the remote name or a raw URL.
 */
function recordGit(root: string): {
  readonly calls: string;
  restore(): void;
} {
  const real = Bun.which("git");
  if (real === undefined) throw new Error("git is not on PATH");
  const bin = join(root, "git-bin");
  mkdirSync(bin, { recursive: true });
  const calls = join(root, "git-calls");
  const wrapper = join(bin, "git");
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${calls}'`,
      `exec '${real}' "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(wrapper, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previous ?? ""}`;
  return {
    calls,
    restore() {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    },
  };
}

describe("dev init check", () => {
  test("a repository with a reachable remote and its main branch passes", async () => {
    const { root, repositoryPath } = await setup();
    const store = storeAt(root);
    await addRepository(store, { path: repositoryPath });

    const checks = await registryAt(root, store, repositoryPath).checks();
    expect(checks).toEqual([
      { plugin: "dev", ok: true, message: "1 repositories checked" },
    ]);
  });

  test("an unknown remote name is a failed check that names it", async () => {
    const { root, repositoryPath } = await setup();
    const store = storeAt(root);
    await addRepository(store, { path: repositoryPath });
    writeSettings(repositoryPath, { remote: "upstream" });

    const [check] = await registryAt(root, store, repositoryPath).checks();
    expect(check?.plugin).toBe("dev");
    expect(check?.ok).toBe(false);
    expect(check?.message).toContain('remote "upstream" does not exist');
  });

  test("an unreachable remote is a failed check with git's message", async () => {
    const { root, repositoryPath } = await setup();
    const store = storeAt(root);
    await addRepository(store, { path: repositoryPath });
    git(repositoryPath, [
      "remote",
      "set-url",
      "origin",
      join(root, "missing.git"),
    ]);

    const [check] = await registryAt(root, store, repositoryPath).checks();
    expect(check?.ok).toBe(false);
    expect(check?.message).toContain('cannot reach remote "origin"');
    expect(check?.message).toContain("missing.git");
    expect(await listRepositories(store)).toHaveLength(1);
  });

  test("an unreachable remote keeps every line of git's stderr", async () => {
    const { root, repositoryPath } = await setup();
    const store = storeAt(root);
    await addRepository(store, { path: repositoryPath });
    // A remote helper that explains its failure on more than one line.
    const bin = join(root, "helper-bin");
    mkdirSync(bin, { recursive: true });
    const helper = join(bin, "git-remote-boom");
    writeFileSync(
      helper,
      [
        "#!/bin/sh",
        "echo 'boom: the helper cannot open the tunnel' >&2",
        "echo 'boom: ask the operator to rotate the key' >&2",
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(helper, 0o755);
    git(repositoryPath, ["remote", "set-url", "origin", "boom::example"]);

    const previous = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${previous ?? ""}`;
    try {
      const [check] = await registryAt(root, store, repositoryPath).checks();
      expect(check?.ok).toBe(false);
      expect(check?.message).toContain('cannot reach remote "origin"');
      expect(check?.message).toContain("the helper cannot open the tunnel");
      // The second line is git's too; reporting only the first hides it.
      expect(check?.message).toContain("ask the operator to rotate the key");
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  });

  test("a reachable remote without the main branch is a failed check that writes nothing", async () => {
    const { root, remote, repositoryPath } = await setup({ pushMain: false });
    const store = storeAt(root);
    await addRepository(store, { path: repositoryPath });
    // The remote answers and holds a branch, just not the configured main one.
    git(repositoryPath, ["push", "-q", "origin", "HEAD:refs/heads/other"]);
    const before = refs(remote);

    const [check] = await registryAt(root, store, repositoryPath).checks();
    expect(check?.ok).toBe(false);
    expect(check?.message).toContain('remote "origin" has no branch "main"');
    expect(refs(remote)).toBe(before);
  });

  test("an empty answer from the remote query is asked again", async () => {
    const { root, repositoryPath } = await setup();
    const store = storeAt(root);
    await addRepository(store, { path: repositoryPath });
    const stub = silentGit(root, "ls-remote --heads", 2);
    try {
      const [check] = await registryAt(root, store, repositoryPath).checks();
      expect(check?.ok).toBe(true);
      expect(stub.calls()).toBe(3);
    } finally {
      stub.restore();
    }
  });

  test("the check asks through the remote name, not its URL", async () => {
    const { root, repositoryPath } = await setup();
    const store = storeAt(root);
    await addRepository(store, { path: repositoryPath });
    // A push would go elsewhere. A read-only check must reach the fetch URL
    // through the name, exactly as any other command would.
    const pushUrl = join(root, "push-only.git");
    git(repositoryPath, ["remote", "set-url", "--push", "origin", pushUrl]);

    const recorded = recordGit(root);
    try {
      const checks = await registryAt(root, store, repositoryPath).checks();
      expect(checks).toEqual([
        { plugin: "dev", ok: true, message: "1 repositories checked" },
      ]);
    } finally {
      recorded.restore();
    }

    const calls = readFileSync(recorded.calls, "utf8");
    expect(calls).toContain("ls-remote --heads origin main");
    expect(calls).not.toContain(pushUrl);
  });

  test("no registered repository passes with a note", async () => {
    const { root, repositoryPath } = await setup();
    const registry = new PluginRegistry([createDevPlugin()], {
      home: root,
      cwd: repositoryPath,
      store: storeAt(root),
    });

    const checks = await registry.checks();
    expect(checks).toEqual([
      { plugin: "dev", ok: true, message: "no repositories registered" },
    ]);
  });
});
