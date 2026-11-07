/**
 * The user's own `claude`: found, never bundled
 * (docs/backlog/operad-harness-claude.md decisions 2 and 10). `inspectClaude`
 * is what `operad plugin check` runs: `claude --version` and
 * `claude auth status`.
 */

import { realpathSync } from "node:fs";

/** The oldest Claude Code the worker is written for. */
export const CLAUDE_FLOOR = "2.1.319";

/** The command looked up on PATH when the `command` setting is unset. */
export const DEFAULT_CLAUDE_COMMAND = "claude";

/** How long `claude --version` or `claude auth status` may take. */
const PROBE_TIMEOUT_MS = 30_000;

/** The check could not pass; the message says what to do. */
export class ClaudeInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeInstallError";
  }
}

export class ClaudeNotFoundError extends ClaudeInstallError {
  constructor(command: string) {
    super(
      `no \`${command}\` command was found; install Claude Code first (https://code.claude.com) or set the command setting to its path`,
    );
    this.name = "ClaudeNotFoundError";
  }
}

/**
 * The real path of the claude command: a name looked up on `path`, or a path.
 * Throws `ClaudeNotFoundError` when there is none.
 */
export function findClaude(command: string | undefined, path: string | undefined = process.env.PATH): string {
  const wanted = command ?? DEFAULT_CLAUDE_COMMAND;
  const found = wanted.includes("/") ? Bun.which(wanted) : Bun.which(wanted, { PATH: path ?? "" });
  if (found === null) throw new ClaudeNotFoundError(wanted);
  return realpathSync(found);
}

/** Negative, zero or positive as version `a` is below, equal to or above `b`. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string): number[] => version.split(".").map((part) => Number(part));
  const left = parts(a);
  const right = parts(b);
  for (let at = 0; at < 3; at += 1) {
    const diff = (left[at] ?? 0) - (right[at] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** What `operad plugin check` learns about the install. */
export interface ClaudeInstall {
  readonly path: string;
  readonly version: string;
  /** The login kind, such as `claude.ai (max)`; never an account detail. */
  readonly login: string;
}

export interface InspectOptions {
  /** The PATH to search; defaults to the process's own. */
  readonly path?: string | undefined;
  /** The floor to compare with; defaults to `CLAUDE_FLOOR`. */
  readonly floor?: string | undefined;
}

interface Ran {
  readonly exitCode: number | null;
  readonly stdout: string;
}

function runClaude(path: string, args: readonly string[]): Ran {
  const ran = Bun.spawnSync([path, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: PROBE_TIMEOUT_MS,
  });
  return { exitCode: ran.exitCode, stdout: ran.stdout.toString("utf8") };
}

/** A login field that is safe to print: a short word, not free text. */
function word(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_. -]{1,40}$/.test(value) ? value : undefined;
}

/**
 * The login kind from `claude auth status`. Only the kind is read: the e-mail,
 * the organisation and everything else in that output are left alone.
 */
function loginKind(stdout: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new ClaudeInstallError("`claude auth status` printed something this check cannot read");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ClaudeInstallError("`claude auth status` printed something this check cannot read");
  }
  if (Reflect.get(value, "loggedIn") !== true) return undefined;
  const method = word(Reflect.get(value, "authMethod")) ?? "unknown login";
  const plan = word(Reflect.get(value, "subscriptionType"));
  const provider = word(Reflect.get(value, "apiProvider"));
  const extra = [plan, provider !== undefined && provider !== "firstParty" ? provider : undefined].filter(
    (part): part is string => part !== undefined,
  );
  return extra.length === 0 ? method : `${method} (${extra.join(", ")})`;
}

/**
 * Finds the installed claude and checks it: the version is at or above the
 * floor and the login works. Throws `ClaudeInstallError` with what to do.
 */
export function inspectClaude(
  command: string | undefined,
  options: InspectOptions = {},
): ClaudeInstall {
  const floor = options.floor ?? CLAUDE_FLOOR;
  const path = findClaude(command, options.path);

  const versionRun = runClaude(path, ["--version"]);
  const match = /^\s*(\d+\.\d+\.\d+)\b/.exec(versionRun.stdout);
  if (versionRun.exitCode !== 0 || match === null || match[1] === undefined) {
    const seen = versionRun.stdout.trim().split("\n")[0]?.slice(0, 80) ?? "";
    throw new ClaudeInstallError(
      `\`${path} --version\` did not print a version this check can read${seen.length === 0 ? "" : ` (it printed "${seen}")`}`,
    );
  }
  const version = match[1];
  if (compareVersions(version, floor) < 0) {
    throw new ClaudeInstallError(
      `claude ${version} at ${path} is older than the floor ${floor}; update Claude Code (claude update)`,
    );
  }

  const status = runClaude(path, ["auth", "status"]);
  const login = loginKind(status.stdout);
  if (login === undefined || status.exitCode !== 0) {
    throw new ClaudeInstallError("claude is not logged in; run `claude auth login`, then check again");
  }
  return { path, version, login };
}

/** The version of the Agent SDK this package imports, or undefined if it cannot be read. */
export async function sdkVersion(): Promise<string | undefined> {
  try {
    const entry = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", import.meta.dir);
    let dir = entry;
    for (let step = 0; step < 6; step += 1) {
      dir = dir.slice(0, dir.lastIndexOf("/"));
      const file = Bun.file(`${dir}/package.json`);
      if (!(await file.exists())) continue;
      const manifest: unknown = await file.json();
      if (
        typeof manifest === "object" &&
        manifest !== null &&
        Reflect.get(manifest, "name") === "@anthropic-ai/claude-agent-sdk"
      ) {
        const version: unknown = Reflect.get(manifest, "version");
        return typeof version === "string" ? version : undefined;
      }
    }
  } catch {
    // The SDK is only reported, never required here.
  }
  return undefined;
}
