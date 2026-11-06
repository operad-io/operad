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
    const hook = join(remote, "hooks", "pre-receive");
    writeFileSync(
      hook,
      [
        "#!/bin/sh",
        'zero="0000000000000000000000000000000000000000"',
        "while read -r old new ref; do",
        '  if [ "$new" = "$zero" ]; then',
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
    // The wire delete was refused, so the check removes the ref directly.
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
