/** Git scratch repositories for the worktree and work tests. */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

export interface GitResult {
  readonly ok: boolean;
  readonly out: string;
  readonly err: string;
}

export function git(cwd: string, args: readonly string[]): GitResult {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    ok: result.exitCode === 0,
    out: result.stdout.toString().trim(),
    err: result.stderr.toString().trim(),
  };
}

export function gitOrThrow(cwd: string, args: readonly string[]): string {
  const result = git(cwd, args);
  if (!result.ok) {
    throw new Error(`git ${args.join(" ")}: ${result.err || result.out}`);
  }
  return result.out;
}

const IDENTITY = [
  "-c",
  "user.name=test",
  "-c",
  "user.email=test@example.com",
];

export interface RemoteSetup {
  /** The bare repository the working repository calls `origin`. */
  readonly origin: string;
  /** A clone used to move `main` forward. */
  readonly seed: string;
  /** The repository a task is registered against. */
  readonly repository: string;
}

/** A bare origin with one commit on `main` and a clone registered as a repo. */
export async function makeRemote(root: string): Promise<RemoteSetup> {
  const origin = join(root, "origin.git");
  await mkdir(origin, { recursive: true });
  gitOrThrow(origin, ["init", "--bare", "--initial-branch=main"]);
  const seed = join(root, "seed");
  gitOrThrow(root, ["clone", origin, seed]);
  await writeFile(join(seed, "README.md"), "# test\n");
  gitOrThrow(seed, ["add", "README.md"]);
  gitOrThrow(seed, [...IDENTITY, "commit", "-qm", "start"]);
  gitOrThrow(seed, ["push", "origin", "main"]);

  const repository = join(root, "repository");
  gitOrThrow(root, ["clone", origin, repository]);
  return { origin, seed, repository };
}

/** Commits a file on `main` in the seed clone and pushes it to origin. */
export async function advanceMain(
  setup: RemoteSetup,
  file: string,
  text: string,
  message = "main moves",
): Promise<void> {
  await mkdir(dirname(join(setup.seed, file)), { recursive: true });
  await writeFile(join(setup.seed, file), text);
  gitOrThrow(setup.seed, ["add", file]);
  gitOrThrow(setup.seed, [...IDENTITY, "commit", "-qm", message]);
  gitOrThrow(setup.seed, ["push", "origin", "main"]);
}

/** Commits a file inside a worktree, for a branch conflict. */
export async function commitIn(
  worktree: string,
  file: string,
  text: string,
  message: string,
): Promise<void> {
  await mkdir(dirname(join(worktree, file)), { recursive: true });
  await writeFile(join(worktree, file), text);
  gitOrThrow(worktree, ["add", file]);
  gitOrThrow(worktree, [...IDENTITY, "commit", "-qm", message]);
}

/**
 * A `git` first on PATH that logs each call whose arguments contain `match`
 * and answers the first `times` of them with exit 0 and no output; every other
 * call, and the later ones, run the real git.
 */
export function silentGit(
  root: string,
  match: string,
  times: number,
): { calls(): number; restore(): void } {
  const real = Bun.which("git");
  if (real === undefined) throw new Error("git is not on PATH");
  const bin = join(root, `silent-git-${Math.random().toString(36).slice(2)}`);
  mkdirSync(bin, { recursive: true });
  const log = join(bin, "log");
  const left = join(bin, "left");
  writeFileSync(left, String(times));
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "git"),
    [
      "#!/bin/sh",
      `case "$*" in *'${match}'*)`,
      `  echo x >> '${log}'`,
      `  n=$(cat '${left}')`,
      `  if [ "$n" -gt 0 ]; then echo $((n-1)) > '${left}'; exit 0; fi;;`,
      "esac",
      `exec '${real}' "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "git"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previous ?? ""}`;
  return {
    calls: () => readFileSync(log, "utf8").split("\n").filter((line) => line !== "").length,
    restore() {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    },
  };
}
