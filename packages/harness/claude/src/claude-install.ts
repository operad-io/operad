/**
 * The user's own `claude`: found, never bundled
 * (ADR 0024 D2, D10). `inspectClaude`
 * is what `operad plugin check` runs: `claude --version` and
 * `claude auth status`.
 */

import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { compareVersions } from "@operad-io/harness-process";

export { compareVersions };

/** The oldest Claude Code the worker is written for. */
export const CLAUDE_FLOOR = "2.1.319";

/** The command looked up on PATH when the `command` setting is unset. */
export const DEFAULT_CLAUDE_COMMAND = "claude";

/** How long `claude --version` or `claude auth status` may take. */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * How many times a probe that must print is run in all: its answer, and one
 * more ask when that answer is an empty success. A spawned command can exit 0
 * with nothing on its output, which is not an answer; one more ask is enough,
 * and it is not five waits for a probe that genuinely prints nothing.
 */
export const PROBE_EMPTY_ATTEMPTS = 2;

/** How long `claude auth status` may take when a client asks for the login state. */
export const SIGNED_IN_PROBE_TIMEOUT_MS = 10_000;

/** The check could not pass; the message says what to do. */
export class ClaudeInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeInstallError";
  }
}

/** The claude is there, and the person has to update it or log in first. */
export class ClaudeNotReadyError extends ClaudeInstallError {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeNotReadyError";
  }
}

export class ClaudeNotFoundError extends ClaudeInstallError {
  constructor(command: string) {
    super(
      `no \`${command}\` command was found; install claude first (https://code.claude.com) or set the command setting to its path`,
    );
    this.name = "ClaudeNotFoundError";
  }
}

/** The command on `path`, before its real path is resolved. */
function whichClaude(command: string | undefined, path: string | undefined): string {
  const wanted = command ?? DEFAULT_CLAUDE_COMMAND;
  const found = wanted.includes("/") ? Bun.which(wanted) : Bun.which(wanted, { PATH: path ?? "" });
  if (found === null) throw new ClaudeNotFoundError(wanted);
  return found;
}

/**
 * The real path of the claude command: a name looked up on `path`, or a path.
 * Throws `ClaudeNotFoundError` when there is none.
 */
export function findClaude(command: string | undefined, path: string | undefined = process.env.PATH): string {
  return realpathSync(whichClaude(command, path));
}

/** As `findClaude`, but resolving the real path without blocking the event loop. */
export async function findClaudeAsync(
  command: string | undefined,
  path: string | undefined = process.env.PATH,
): Promise<string> {
  return await realpath(whichClaude(command, path));
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

function runClaudeOnce(path: string, args: readonly string[]): Ran {
  const ran = Bun.spawnSync([path, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: PROBE_TIMEOUT_MS,
  });
  return { exitCode: ran.exitCode, stdout: ran.stdout.toString("utf8") };
}

/** Both probes must print on success, so an empty success is asked again. */
function runClaude(path: string, args: readonly string[]): Ran {
  let ran = runClaudeOnce(path, args);
  for (
    let attempt = 1;
    attempt < PROBE_EMPTY_ATTEMPTS && ran.exitCode === 0 && ran.stdout.trim().length === 0;
    attempt += 1
  ) {
    ran = runClaudeOnce(path, args);
  }
  return ran;
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
 * The `loggedIn` answer of `claude auth status`, when the output carries a
 * boolean; undefined when it cannot be read. Only this field is read.
 */
function loggedInOf(stdout: string): boolean | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const answer = Reflect.get(value, "loggedIn");
  return typeof answer === "boolean" ? answer : undefined;
}

interface AsyncRan {
  readonly exitCode: number | null;
  readonly stdout: string;
}

/** Runs `claude` without blocking the event loop, and gives up after the timeout. */
async function runClaudeAsync(path: string, args: readonly string[]): Promise<AsyncRan | undefined> {
  const signal = AbortSignal.timeout(SIGNED_IN_PROBE_TIMEOUT_MS);
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([path, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      signal,
    });
  } catch {
    return undefined;
  }
  try {
    const stream = child.stdout;
    if (!(stream instanceof ReadableStream)) return undefined;
    const [stdout, exitCode] = await Promise.all([
      new Response(stream).text(),
      child.exited,
    ]);
    return signal.aborted ? undefined : { exitCode, stdout };
  } catch {
    return undefined;
  }
}

/**
 * Whether the user's claude is signed in, from `claude auth status`: true or
 * false when that answer can be read, undefined when there is no claude or the
 * answer is not usable. It never blocks the event loop and reads no account
 * detail, only `loggedIn`.
 */
export async function claudeSignedIn(command: string | undefined): Promise<boolean | undefined> {
  let path: string;
  try {
    path = await findClaudeAsync(command);
  } catch {
    return undefined;
  }
  const ran = await runClaudeAsync(path, ["auth", "status"]);
  if (ran === undefined) return undefined;
  const loggedIn = loggedInOf(ran.stdout);
  if (loggedIn === undefined) return undefined;
  // A failing exit with `loggedIn: true` contradicts itself; do not guess.
  if (ran.exitCode !== 0 && loggedIn) return undefined;
  return loggedIn;
}

/**
 * Finds the installed claude and checks it: the version is at or above the
 * floor and the login works. Throws `ClaudeInstallError` with what to do; it is
 * a `ClaudeNotReadyError` for an old claude or one that is not logged in.
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
    throw new ClaudeNotReadyError(
      `claude ${version} at ${path} is older than the floor ${floor}; update claude (claude update)`,
    );
  }

  const status = runClaude(path, ["auth", "status"]);
  const login = loginKind(status.stdout);
  if (login === undefined || status.exitCode !== 0) {
    throw new ClaudeNotReadyError("claude is not logged in; run `claude auth login`, then check again");
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
