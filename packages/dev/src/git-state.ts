/**
 * What git a folder has, computed each time and never stored: the user can run
 * `git init`, install git or make a commit at any moment, so a stored answer
 * would be stale on the next tick. Chat needs none of it; creating a task needs
 * `ready`. The states and their use are in docs/research/2026-11-22-dev-without-git.md
 * section 5.
 *
 * A folder git cannot judge (it refuses with dubious ownership, `.git` is
 * unreadable, it prints nothing) is an error, `GitStateError`, never `no repository`.
 *
 * Not told apart: a bare repository and a folder inside a `.git` directory both
 * have no work tree, so they read as `no repository`.
 */

import { realpathSync, statSync } from "node:fs";
import { findGit, realGitFinderHost, type GitFinderHost } from "@operad-io/engine/platform";
import { git, type GitOptions } from "./git.ts";
import { DevRefusal } from "./model.ts";

/** The user name and email git would write into a commit, as the configuration holds them. */
export interface GitIdentity {
  /** `user.name`, or `undefined` when it is not set or empty. */
  readonly name: string | undefined;
  /** `user.email`, or `undefined` when it is not set or empty. */
  readonly email: string | undefined;
  /** True when both are set: a commit can be made. */
  readonly set: boolean;
}

export type GitState =
  /** The git program is not installed (or, on macOS, only its stub is). */
  | { readonly state: "no program" }
  /** Git is there; the folder is in no work tree. */
  | { readonly state: "no repository"; readonly identity: GitIdentity }
  /** The folder is inside the work tree whose top is `root`. */
  | { readonly state: "subfolder"; readonly root: string; readonly identity: GitIdentity }
  /** The folder is a work tree root with no commit; `branch` is the unborn branch's name. */
  | {
      readonly state: "no commit";
      readonly branch: string | undefined;
      readonly identity: GitIdentity;
    }
  /** The folder is a work tree root with a commit; `branch` is undefined on a detached HEAD. */
  | {
      readonly state: "ready";
      readonly branch: string | undefined;
      readonly identity: GitIdentity;
    };

export interface GitStateOptions {
  /** The environment of every git run; the default is this process's. */
  readonly env?: NodeJS.ProcessEnv;
  /** The machine the git program is looked up on; a test injects one without git. */
  readonly finder?: GitFinderHost;
}

/** What git says when the folder is in no work tree (a bare repository has none either). */
const NO_REPOSITORY = /not a git repository|this operation must be run in a work tree/i;

/** Git could not say whether the folder is in a repository; `reason` is git's own message. */
export class GitStateError extends Error {
  constructor(
    readonly folder: string,
    readonly reason: string,
  ) {
    super(`git cannot tell what "${folder}" is: ${reason.length > 0 ? reason : "no detail"}`);
    this.name = "GitStateError";
  }
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function identityOf(folder: string, options: GitOptions): GitIdentity {
  const read = (key: string): string | undefined => {
    const result = git(folder, ["config", "--get", key], options);
    return result.ok && result.out !== "" ? result.out : undefined;
  };
  const name = read("user.name");
  const email = read("user.email");
  return { name, email, set: name !== undefined && email !== undefined };
}

/** Test-only: the machine every state check looks for git on, when the caller gives none. */
export const gitStateTestHooks: { finder?: GitFinderHost | undefined } = {};

/** The state of `folder`, which must be an existing directory. */
export function gitStateOf(folder: string, stateOptions: GitStateOptions = {}): GitState {
  if (statSync(folder, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new Error(`"${folder}" is not a folder`);
  }
  const env = stateOptions.env ?? { ...process.env };
  const options: GitOptions = { env };
  // The finder runs nothing that could open the macOS install dialog.
  if (findGit(stateOptions.finder ?? gitStateTestHooks.finder ?? { ...realGitFinderHost(), env }) === undefined) return { state: "no program" };
  const identity = identityOf(folder, options);
  // Git's messages are forced to English for this one question, so the words
  // that say "no repository" can be told from every other refusal.
  const top = git(folder, ["rev-parse", "--show-toplevel"], {
    env: { ...env, LC_ALL: "C", LANGUAGE: "" },
  });
  if (!top.ok) {
    if (NO_REPOSITORY.test(top.err)) return { state: "no repository", identity };
    // Dubious ownership, an unreadable .git, a git that prints nothing: the
    // folder may well be a repository, so it is not taken for a plain folder.
    throw new GitStateError(folder, top.err);
  }
  if (canonical(top.out) !== canonical(folder)) {
    return { state: "subfolder", root: top.out, identity };
  }
  const branchResult = git(folder, ["symbolic-ref", "--short", "-q", "HEAD"], options);
  const branch = branchResult.ok && branchResult.out !== "" ? branchResult.out : undefined;
  const head = git(folder, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], options);
  return { state: head.ok ? "ready" : "no commit", branch, identity };
}

// Why a task cannot be created in `folder` now, in the line a person reads, or
// `undefined` when git is ready there. The bot turns the line into the person's
// language and starts the git setup; the line itself starts nothing.
export function taskRefusalOf(folder: string, stateOptions: GitStateOptions = {}): string | undefined {
  const state = gitStateOf(folder, stateOptions);
  switch (state.state) {
    case "ready":
      return undefined;
    case "no program":
      return "Creating a task needs git, and git is not installed on this machine. Ask the bot to help you install it.";
    case "no repository":
      return "This folder is not under git yet, and a task needs it. Ask the bot to set up git here: it will show you a list of the files first.";
    case "no commit":
      return "Git is set up here but has no commit yet, and a task needs one. Ask the bot to make the first commit: it will show you a list of the files first.";
    case "subfolder":
      return `This folder is inside the git repository at ${state.root}. Add ${state.root} as the project instead (operad dev repo add ${state.root}), or keep chatting here.`;
  }
}

// The same line as `taskRefusalOf`, for a folder git cannot judge too.
export function taskGitRefusal(folder: string, stateOptions: GitStateOptions = {}): string | undefined {
  try {
    return taskRefusalOf(folder, stateOptions);
  } catch (error) {
    if (!(error instanceof GitStateError)) throw error;
    return `Git cannot tell what this folder is, so a task cannot be created: ${error.reason}`;
  }
}

// Throws a refusal when a task cannot be created in `folder`.
export function assertCanCreateTask(folder: string, stateOptions: GitStateOptions = {}): void {
  const line = taskGitRefusal(folder, stateOptions);
  if (line !== undefined) throw new DevRefusal(line);
}
