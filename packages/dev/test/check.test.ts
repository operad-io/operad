import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PluginRegistry } from "@operad-io/engine";
import { createDevPlugin } from "../src/index.ts";
import { addRepository, listRepositories } from "../src/service.ts";
import {
  cleanupTempRoots,
  storeAt,
  tempRoot,
} from "./support.ts";

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

/** A bare remote and a work tree that has pushed its one commit to it. */
async function setup(): Promise<Fixture> {
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
  git(repositoryPath, ["push", "-q", "-u", "origin", "main"]);
  return { root, remote, repositoryPath };
}

function scratchRefs(remote: string): string {
  return git(remote, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/operad",
  ]);
}

/** A remote hook that refuses the deletion of a scratch ref. */
function refuseScratchDeletes(remote: string, existingOnly: boolean): void {
  const condition = existingOnly
    ? '[ "$new" = "$zero" ] && [ "$old" != "$zero" ]'
    : '[ "$new" = "$zero" ]';
  const hook = join(remote, "hooks", "pre-receive");
  writeFileSync(
    hook,
    [
      "#!/bin/sh",
      'zero="0000000000000000000000000000000000000000"',
      "while read -r old new ref; do",
      `  if ${condition}; then`,
      '    case "$ref" in',
      "      refs/operad/*) echo 'scratch deletes are refused'; exit 1 ;;",
      "    esac",
      "  fi",
      "done",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(hook, 0o755);
}

/** A stand-in for ssh that runs the git command it is handed on this machine. */
function fakeSsh(root: string): string {
  const path = join(root, "fake-ssh");
  writeFileSync(path, '#!/bin/sh\nfor last do :; done\nexec sh -c "$last"\n');
  chmodSync(path, 0o755);
  return path;
}

describe("dev init check", () => {
  test("a repository with a reachable remote passes and leaves no scratch ref", async () => {
    const { root, remote, repositoryPath } = await setup();
    const store = storeAt(root);
    await addRepository(store, { path: repositoryPath });
    const registry = new PluginRegistry([createDevPlugin()], {
      home: root,
      cwd: root,
      store,
    });

    const checks = await registry.checks();
    expect(checks).toEqual([
      { plugin: "dev", ok: true, message: "1 repositories checked" },
    ]);
    expect(scratchRefs(remote)).toBe("");
  });

  test("an unreachable remote is a failed check that names it", async () => {
    const { root, remote, repositoryPath } = await setup();
    const store = storeAt(root);
    await addRepository(store, { path: repositoryPath });
    git(repositoryPath, [
      "remote",
      "set-url",
      "origin",
      join(root, "missing.git"),
    ]);
    const registry = new PluginRegistry([createDevPlugin()], {
      home: root,
      cwd: root,
      store,
    });

    const [check] = await registry.checks();
    expect(check?.plugin).toBe("dev");
    expect(check?.ok).toBe(false);
    expect(check?.message).toContain('cannot reach remote "origin"');
    expect(scratchRefs(remote)).toBe("");
    expect(await listRepositories(store)).toHaveLength(1);
  });

  test("a remote that refuses the delete is a failed check that leaves no scratch ref", async () => {
    const { root, remote, repositoryPath } = await setup();
    refuseScratchDeletes(remote, false);
    const store = storeAt(root);
    await addRepository(store, { path: repositoryPath });
    const registry = new PluginRegistry([createDevPlugin()], {
      home: root,
      cwd: root,
      store,
    });

    const [check] = await registry.checks();
    expect(check?.ok).toBe(false);
    expect(check?.message).toContain("refused to delete the scratch ref");
    // The check asked the remote to delete a ref that does not exist, so the
    // refused probe wrote nothing and there is no ref to clean up.
    expect(scratchRefs(remote)).toBe("");
  });

  test("a URL remote that refuses the delete is a failed check that leaves no scratch ref", async () => {
    const { root, remote, repositoryPath } = await setup();
    refuseScratchDeletes(remote, false);
    git(repositoryPath, ["config", "core.sshCommand", fakeSsh(root)]);
    git(repositoryPath, [
      "remote",
      "set-url",
      "origin",
      `ssh://operad-test${remote}`,
    ]);
    const store = storeAt(root);
    await addRepository(store, { path: repositoryPath });
    const registry = new PluginRegistry([createDevPlugin()], {
      home: root,
      cwd: root,
      store,
    });

    const [check] = await registry.checks();
    expect(check?.ok).toBe(false);
    expect(check?.message).toContain("refused to delete the scratch ref");
    // The remote is reachable only over the wire, so only the probe protects it
    // from a leftover ref: it runs before the scratch ref is pushed.
    expect(scratchRefs(remote)).toBe("");
  });

  test("a local remote that refuses only an existing delete is cleaned directly", async () => {
    const { root, remote, repositoryPath } = await setup();
    refuseScratchDeletes(remote, true);
    const store = storeAt(root);
    await addRepository(store, { path: repositoryPath });
    const registry = new PluginRegistry([createDevPlugin()], {
      home: root,
      cwd: root,
      store,
    });

    const [check] = await registry.checks();
    expect(check?.ok).toBe(false);
    expect(check?.message).toContain(
      "accepted a push but refused to delete the scratch ref",
    );
    // The probe passed and the pushed ref was refused by the second delete, so
    // the check removes it from the local repository directly.
    expect(scratchRefs(remote)).toBe("");
  });

  test("no registered repository passes with a note", async () => {
    const { root } = await setup();
    const registry = new PluginRegistry([createDevPlugin()], {
      home: root,
      cwd: root,
      store: storeAt(root),
    });

    const checks = await registry.checks();
    expect(checks).toEqual([
      { plugin: "dev", ok: true, message: "no repositories registered" },
    ]);
  });
});
