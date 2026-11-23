/**
 * Finding the git program without running it where running it could open a
 * dialog. On macOS `/usr/bin/git` is a stub that exists on every Mac; without
 * the command line tools it opens Apple's install dialog. So it is trusted only
 * when `xcode-select -p` names a developer directory that holds a git.
 *
 * The answer is an absolute path, because a PATH that changed after the process
 * started (a `winget install`, a Homebrew install under a GUI-started serve) is
 * not seen by a spawn of the word `git`. Nothing is cached: "not installed" must
 * be looked up again on every call, and a lookup is a few file checks.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** What the finder needs from the machine; a test injects each part. */
export interface GitFinderHost {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Resolves a command through PATH without running it. */
  which(command: string, path: string | undefined): string | null;
  /** True when a file exists. */
  exists(path: string): boolean;
  /** Runs a program with no shell; returns its exit code and output. */
  run(cmd: readonly string[], env: Readonly<Record<string, string | undefined>>): {
    readonly code: number;
    readonly out: string;
  };
}

/** The message every caller shows when no git program is found. */
export const GIT_NOT_INSTALLED = "git is not installed";

const MACOS_STUB = "/usr/bin/git";

function defaultRun(
  cmd: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): { readonly code: number; readonly out: string } {
  try {
    const result = Bun.spawnSync({
      cmd: [...cmd],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...env },
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    return { code: result.exitCode ?? 1, out: result.stdout.toString().trim() };
  } catch {
    return { code: 1, out: "" };
  }
}

/** The machine this process runs on. */
export function realGitFinderHost(): GitFinderHost {
  return {
    platform: process.platform,
    env: process.env,
    which: (command, path) => Bun.which(command, path === undefined ? {} : { PATH: path }),
    exists: existsSync,
    run: defaultRun,
  };
}

/** True when the selected developer directory on a Mac holds a git. */
function macToolsInstalled(host: GitFinderHost): boolean {
  const selected = host.run(["/usr/bin/xcode-select", "-p"], host.env);
  if (selected.code !== 0 || selected.out.length === 0) return false;
  return host.exists(join(selected.out, "usr", "bin", "git"));
}

function windowsCandidates(env: GitFinderHost["env"]): string[] {
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"]].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  const found = roots.map((root) => join(root, "Git", "cmd", "git.exe"));
  const local = env.LOCALAPPDATA;
  if (local !== undefined && local.length > 0) {
    found.push(join(local, "Programs", "Git", "cmd", "git.exe"));
  }
  return found;
}

/**
 * The absolute path of a git program that can be run, or undefined when there
 * is none. It never runs git itself and never opens an installer.
 */
export function findGit(host: GitFinderHost = realGitFinderHost()): string | undefined {
  const onPath = host.which("git", host.env.PATH);
  if (host.platform === "darwin") {
    if (onPath !== null && onPath !== MACOS_STUB) return onPath;
    // A GUI-started process has a short PATH: look where Homebrew installs.
    for (const candidate of ["/opt/homebrew/bin/git", "/usr/local/bin/git"]) {
      if (host.exists(candidate)) return candidate;
    }
    // Only the stub is left: it is real only when the tools are selected.
    return (onPath === MACOS_STUB || host.exists(MACOS_STUB)) && macToolsInstalled(host)
      ? MACOS_STUB
      : undefined;
  }
  if (onPath !== null) return onPath;
  if (host.platform === "win32") {
    return windowsCandidates(host.env).find((path) => host.exists(path));
  }
  return undefined;
}
