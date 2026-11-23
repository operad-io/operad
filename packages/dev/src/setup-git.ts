/**
 * Dev's side of "Set up git here" (ADR 0039 D8). The bot proposes: a
 * `.gitignore` text, the list of files the first commit would hold, and the
 * person's name and email when git has none. On approval the bot leaves a
 * request file (`register-requests.ts`) and dev, which owns the git runs and the
 * repository lock, does the work here.
 *
 * The list is made before anything exists: a scratch git directory outside the
 * folder and the proposed `.gitignore` as an exclude file, so nothing is written
 * into the folder until the person approves. Applying commits exactly the
 * approved paths, never `git add -A`, so what a chat wrote after the list was
 * shown is not in the commit.
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isRecord } from "@operad-io/engine";
import { git, type GitOptions } from "./git.ts";
import { gitStateOf, type GitStateOptions } from "./git-state.ts";
import { withRepositoryLock, type RepositoryLockOptions } from "./lock.ts";
import { DevRefusal } from "./model.ts";
import { ensureExcludes, writeSettings } from "./service.ts";
import { DEFAULT_DEV_SETTINGS } from "./settings.ts";

/** Above this many files the person is asked to check the `.gitignore` first. */
export const FIRST_COMMIT_FILE_LIMIT = 5000;

/** What git is asked to leave out of the first commit by default. */
export const DEFAULT_GITIGNORE = [
  "# Dependencies",
  "node_modules/",
  ".venv/",
  "target/",
  "vendor/",
  "",
  "# Build output",
  "dist/",
  "build/",
  ".next/",
  "",
  "# Secrets",
  ".env*",
  "*.pem",
  "*.key",
  "id_rsa*",
  "",
  "# System files",
  ".DS_Store",
  "",
].join("\n");

/** Names that must stay ignored whatever else the text says; the text check probes them. */
const SECRET_PROBES: readonly string[] = [".env", ".env.local", "server.pem", "api.key", "id_rsa", "id_rsa.pub"];

/** The folders dev makes itself; never part of a first commit. */
const OWN_FOLDERS: readonly string[] = [".operad-worktrees/", ".radian-sandbox/"];

const GITIGNORE_MAX_BYTES = 100_000;

export interface SetupGitOptions {
  /** The environment of every git run; the default is this process's. */
  readonly env?: NodeJS.ProcessEnv;
  /** The machine the git program is looked up on; a test injects one. */
  readonly state?: GitStateOptions;
  /** The home folder that is refused; the default is the computer account's. */
  readonly home?: string;
  /** Where the repository lock is kept. */
  readonly lock?: RepositoryLockOptions;
}

export interface FirstCommitList {
  /** The folder's own `.gitignore` text, when it has one: a proposal builds on it and must keep every line. */
  readonly existingGitignore: string | undefined;
  /** Files `git add` would take, relative to the folder, sorted; `.gitignore` is the first when the text is not empty. */
  readonly files: readonly string[];
  /** Folders that are git repositories of their own; they are not committed. */
  readonly nested: readonly string[];
  readonly count: number;
  /** True above `FIRST_COMMIT_FILE_LIMIT`. */
  readonly large: boolean;
  /** The sentence that asks the person to check the `.gitignore`, when `large`. */
  readonly note: string | undefined;
}

export interface SetupGitRequest {
  readonly path: string;
  /** The text of the `.gitignore` to write. */
  readonly gitignore: string;
  /** The files to commit, as the person approved them. */
  readonly paths: readonly string[];
  /** Written to the repository's own git configuration, for this commit and later ones. */
  readonly identity?: { readonly name: string; readonly email: string };
}

export interface SetupGitResult {
  /** `already` when the folder had a commit and only the repository setup was completed. */
  readonly outcome: "set up" | "already";
  readonly branch: string;
  readonly committed: number;
}

/** Test-only: runs between `git init` and the commit, so a test can stop the process there. */
export const setupGitTestHooks: { beforeCommit?: (() => void) | undefined } = {};

function realpathOr(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** Refuses a folder that must never become one repository: the home folder or a disk root. */
export function refuseUnsafeFolder(folder: string, home: string = homedir()): void {
  const real = realpathOr(folder);
  if (dirname(real) === real) {
    throw new DevRefusal(`"${folder}" is the top of a disk; git is not set up there. Choose a project folder.`);
  }
  if (real === realpathOr(home)) {
    throw new DevRefusal(
      `"${folder}" is your home folder; everything in it would go into one repository. Choose a project folder inside it.`,
    );
  }
}

function scratchGit<T>(work: (scratch: string, run: (cwd: string, args: readonly string[], options?: GitOptions) => ReturnType<typeof git>) => T): T {
  const scratch = mkdtempSync(join(tmpdir(), "operad-setup-git-"));
  try {
    return work(scratch, (cwd, args, options = {}) => git(cwd, args, options));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Why `text` is not a `.gitignore` to write, or `undefined`: it must be text,
 * not too long, and must keep the secret names (`.env*`, keys) out of the commit.
 */
export function gitignoreProblem(text: string, options: SetupGitOptions = {}): string | undefined {
  if (text.includes("\0")) return "the .gitignore text holds a null byte; it must be plain text";
  if (new TextEncoder().encode(text).length > GITIGNORE_MAX_BYTES) {
    return `the .gitignore text is longer than ${GITIGNORE_MAX_BYTES} bytes`;
  }
  return scratchGit((scratch, run) => {
    const probes = join(scratch, "probes");
    const gitDirectory = join(scratch, "git");
    const exclude = join(scratch, "exclude");
    const env = options.env ?? { ...process.env };
    run(scratch, ["init", "-q", "--bare", gitDirectory], { env });
    writeFileSync(exclude, text);
    // Each probe is a file of the secret's name in a scratch work tree.
    mkdirSync(probes);
    for (const name of SECRET_PROBES) writeFileSync(join(probes, name), "");
    const listed = run(scratch, ["--git-dir", gitDirectory, "--work-tree", probes, "ls-files", "-z", "-o", "--exclude-from", exclude], { env, raw: true });
    if (!listed.ok) return `git could not read the .gitignore text: ${listed.err}`;
    const shown = listed.out.split("\0").filter((name) => name !== "");
    if (shown.length > 0) {
      return `the .gitignore text does not keep ${shown.join(", ")} out of the commit; secret files must stay ignored`;
    }
    return undefined;
  });
}

/**
 * The files the first commit of `folder` would hold with `gitignore` as its
 * `.gitignore`, found without writing anything into the folder.
 */
export function firstCommitList(folder: string, gitignore: string, options: SetupGitOptions = {}): FirstCommitList {
  refuseUnsafeFolder(folder, options.home);
  const problem = gitignoreProblem(gitignore, options);
  if (problem !== undefined) throw new DevRefusal(problem);
  const dropped = droppedLines(folder, gitignore);
  if (dropped !== undefined) throw new DevRefusal(dropped);
  const env = options.env ?? { ...process.env };
  const listed = scratchGit((scratch, run) => {
    const gitDirectory = join(scratch, "git");
    const exclude = join(scratch, "exclude");
    run(scratch, ["init", "-q", "--bare", gitDirectory], { env });
    writeFileSync(exclude, `${gitignore}\n${OWN_FOLDERS.join("\n")}\n`);
    return run(
      scratch,
      ["--git-dir", gitDirectory, "--work-tree", resolve(folder), "ls-files", "-z", "-o", "--exclude-from", exclude, "--exclude-standard"],
      { env, raw: true, timeoutMs: 120_000 },
    );
  });
  if (!listed.ok) throw new DevRefusal(`git could not list the files in "${folder}": ${listed.err}`);
  const entries = listed.out.split("\0").filter((entry) => entry !== "");
  const nested = entries.filter((entry) => entry.endsWith("/")).sort();
  const files = new Set(entries.filter((entry) => !entry.endsWith("/")));
  if (gitignore.length > 0) files.add(".gitignore");
  const sorted = [...files].sort();
  const large = sorted.length > FIRST_COMMIT_FILE_LIMIT;
  return {
    existingGitignore: existingGitignore(folder),
    files: sorted,
    nested,
    count: sorted.length,
    large,
    note: large
      ? `This folder has ${sorted.length} files for the first commit, more than ${FIRST_COMMIT_FILE_LIMIT}. Check the .gitignore: build output and dependencies are usually not part of it.`
      : undefined,
  };
}

/** The text of the folder's own `.gitignore`, or `undefined` when it has none. */
export function existingGitignore(folder: string): string | undefined {
  try {
    return readFileSync(join(folder, ".gitignore"), "utf8");
  } catch {
    return undefined;
  }
}

const linesOf = (text: string): string[] =>
  text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** A sentence when `proposed` would drop a line of the folder's own `.gitignore`, else `undefined`. */
function droppedLines(folder: string, proposed: string): string | undefined {
  const existing = existingGitignore(folder);
  if (existing === undefined) return undefined;
  const kept = new Set(linesOf(proposed));
  const missing = linesOf(existing).filter((line) => !kept.has(line));
  if (missing.length === 0) return undefined;
  return `This folder already has a .gitignore, and the new text would drop ${missing.length === 1 ? "this line" : "these lines"}: ${missing.join(", ")}. Keep every line of the existing file and add to it.`;
}

function validPaths(folder: string, paths: readonly string[]): string[] {
  const kept: string[] = [];
  for (const path of paths) {
    if (path === "" || isAbsolute(path) || path.includes("\0")) {
      throw new DevRefusal(`"${path}" is not a path inside the folder`);
    }
    const parts = path.split(/[\\/]/);
    if (parts.includes("..") || parts[0] === ".git") {
      throw new DevRefusal(`"${path}" is not a path git may commit`);
    }
    let stat;
    try {
      stat = lstatSync(join(folder, path));
    } catch {
      continue; // gone since the list was made
    }
    if (stat.isDirectory()) continue; // a nested repository, or a folder: files are listed one by one
    kept.push(path);
  }
  return kept;
}

function updateSettings(folder: string, branch: string): void {
  const file = join(folder, ".operad", "dev.json");
  if (!existsSync(file)) {
    writeSettings(folder, basename(folder), false, true);
  }
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(parsed)) {
    throw new DevRefusal(`${file} is not a JSON object`);
  }
  const settings: Record<string, unknown> = { ...parsed };
  settings.workIn = "branch";
  settings.mainBranch = branch;
  delete settings.remote;
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

function must(result: ReturnType<typeof git>, what: string): void {
  if (!result.ok) throw new DevRefusal(`${what}: ${result.err.length > 0 ? result.err : result.out}`);
}

/**
 * Makes `request.path` a repository with its first commit: `git init` when
 * there is none, the `.gitignore`, exactly the approved paths, the commit, and
 * a repository that works in a branch and has no remote. Safe to run again
 * after it was stopped anywhere: an unborn repository goes on from where it is,
 * and a repository with a commit only has its exclude file completed.
 */
export function applySetupGit(request: SetupGitRequest, options: SetupGitOptions = {}): Promise<SetupGitResult> {
  const folder = realpathOr(resolve(request.path));
  return withRepositoryLock(folder, () => applyLocked(folder, request, options), options.lock);
}

function applyLocked(folder: string, request: SetupGitRequest, options: SetupGitOptions): SetupGitResult {
  if (!existsSync(folder)) throw new DevRefusal(`no directory "${folder}"`);
  refuseUnsafeFolder(folder, options.home);
  const env = options.env ?? { ...process.env };
  const run: GitOptions = { env };
  let state = gitStateOf(folder, { ...options.state, env });
  if (state.state === "no program") {
    throw new DevRefusal("Git is not installed on this machine, so git cannot be set up here. Ask the bot to help you install it.");
  }
  if (state.state === "subfolder") {
    throw new DevRefusal(
      `This folder is inside the git repository at ${state.root}. Add ${state.root} as the project instead (operad dev repo add ${state.root}).`,
    );
  }
  if (state.state === "ready") {
    ensureExcludes(folder);
    return { outcome: "already", branch: state.branch ?? "", committed: 0 };
  }
  const problem = gitignoreProblem(request.gitignore, options);
  if (problem !== undefined) throw new DevRefusal(problem);
  const dropped = droppedLines(folder, request.gitignore);
  if (dropped !== undefined) throw new DevRefusal(dropped);
  const identity = request.identity;
  if (identity !== undefined) {
    if (identity.name.trim() === "" || !/^\S+@\S+$/.test(identity.email.trim()) || /[\r\n]/.test(identity.name + identity.email)) {
      throw new DevRefusal("The name must not be empty and the email must look like name@host.");
    }
  } else if (!state.identity.set) {
    throw new DevRefusal("Git has no name and email for the first commit. Give them in the request: the bot asks the person.");
  }
  const paths = validPaths(folder, request.paths);

  const wanted = readMainBranch(folder);
  if (state.state === "no repository") {
    must(git(folder, ["-c", `init.defaultBranch=${wanted}`, "init", "-q"], run), "git init failed");
    // `init.defaultBranch` needs git 2.28; the symbolic ref works on every version while the branch is unborn.
    must(git(folder, ["symbolic-ref", "HEAD", `refs/heads/${wanted}`], run), "could not name the branch");
    state = gitStateOf(folder, { ...options.state, env });
  }
  const unborn = git(folder, ["symbolic-ref", "--short", "-q", "HEAD"], run);
  const branch = unborn.ok && unborn.out !== "" ? unborn.out : wanted;

  if (identity !== undefined) {
    must(git(folder, ["config", "user.name", identity.name.trim()], run), "could not store the name");
    must(git(folder, ["config", "user.email", identity.email.trim()], run), "could not store the email");
  }
  writeFileSync(join(folder, ".gitignore"), request.gitignore);
  updateSettings(folder, branch);

  // An exact index: whatever was staged before is dropped, then only the approved paths are added.
  must(git(folder, ["read-tree", "--empty"], run), "could not reset the index");
  const owned = [".gitignore", ".operad/dev.json"];
  const all = [...new Set([...owned, ...paths])].filter((path) => existsSync(join(folder, path)));
  setupGitTestHooks.beforeCommit?.();
  must(
    git(folder, ["--literal-pathspecs", "add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      env,
      input: `${all.join("\0")}\0`,
    }),
    "git add failed",
  );
  must(
    git(folder, ["commit", "-q", "--allow-empty", "--no-verify", "--no-gpg-sign", "-m", "Initial commit"], run),
    "the first commit failed",
  );
  ensureExcludes(folder);
  return { outcome: "set up", branch, committed: all.length };
}

/** The `mainBranch` of the folder's `dev.json`, or the default. */
function readMainBranch(folder: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(folder, ".operad", "dev.json"), "utf8"));
    if (isRecord(parsed) && typeof parsed.mainBranch === "string" && parsed.mainBranch !== "") {
      return parsed.mainBranch;
    }
  } catch {
    // No readable settings: the default.
  }
  return DEFAULT_DEV_SETTINGS.mainBranch;
}
