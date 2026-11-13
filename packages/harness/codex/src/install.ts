/**
 * The user's own `codex-acp` and Codex: found, never bundled
 * (docs/backlog/operad-harness.md decisions 8 and 10). `inspectCodex` is what
 * `operad plugin check` runs: `codex-acp --version`, `codex --version` and
 * `codex login status`. Credentials are the user's own Codex (ChatGPT) login;
 * operad never reads or writes them.
 */

import { readFileSync, realpathSync } from "node:fs";

/** How long one probe may take. */
const PROBE_TIMEOUT_MS = 30_000;

/** The check could not pass; the message says what to do. */
export class CodexInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexInstallError";
  }
}

/**
 * The command that starts codex-acp when the `command` setting is unset: the
 * `bun` of PATH runs the real path of the `codex-acp` of PATH. codex-acp's
 * shebang is `#!/usr/bin/env node`, which finds a node only in a shell that
 * set one up (fnm), never in the process operad runs under.
 */
export function defaultCommand(path: string | undefined = process.env.PATH): readonly string[] {
  const bun = Bun.which("bun", { PATH: path ?? "" });
  if (bun === null) throw new CodexInstallError("no `bun` was found on PATH; codex-acp is started with it");
  const acp = Bun.which("codex-acp", { PATH: path ?? "" });
  if (acp === null) {
    throw new CodexInstallError(
      "no `codex-acp` was found on PATH; install it (bun add -g @agentclientprotocol/codex-acp) or set the command setting",
    );
  }
  return [bun, realpathSync(acp)];
}

/** The argv of the `command` setting, or the default one. */
export function commandOf(setting: unknown, path: string | undefined = process.env.PATH): readonly string[] {
  if (setting === undefined) return defaultCommand(path);
  if (!Array.isArray(setting) || setting.length === 0 || !setting.every((word) => typeof word === "string" && word.length > 0)) {
    throw new CodexInstallError("settings.command: must be a non-empty list of strings: the program and its arguments");
  }
  return setting.filter((word): word is string => typeof word === "string");
}

interface Ran {
  readonly exitCode: number | null;
  readonly stdout: string;
}

function run(argv: readonly string[], args: readonly string[]): Ran {
  try {
    const ran = Bun.spawnSync([...argv, ...args], {
      stdin: "ignore",
      env: { ...process.env },
      stdout: "pipe",
      stderr: "ignore",
      timeout: PROBE_TIMEOUT_MS,
    });
    return { exitCode: ran.exitCode, stdout: ran.stdout.toString("utf8") };
  } catch {
    return { exitCode: null, stdout: "" };
  }
}

/** The Codex command: its script run by the same bun when its shebang names node. */
export function codexCommand(bun: string, path: string | undefined = process.env.PATH): readonly string[] | undefined {
  const found = Bun.which("codex", { PATH: path ?? "" });
  if (found === null) return undefined;
  const real = realpathSync(found);
  try {
    const head = readFileSync(real, "utf8").slice(0, 120).split("\n")[0] ?? "";
    if (head.startsWith("#!") && head.includes("node")) return [bun, real];
  } catch {
    // A native binary is not text.
  }
  return [real];
}

/** The last word-like token of a version line: `codex-cli 0.166.0` gives `0.166.0`. */
function versionOf(stdout: string): string | undefined {
  const line = stdout.split("\n").find((text) => text.trim().length > 0)?.trim();
  if (line === undefined) return undefined;
  const found = /\d+\.\d+\.\d+\S*/.exec(line);
  return found?.[0];
}

/** The login kind from `codex login status`: only the kind, never an account or a key. */
function loginKind(stdout: string): string {
  const found = /^Logged in using ([A-Za-z0-9 ]{1,30}?)(?:\s+-|\s*$)/m.exec(stdout.trim());
  return found?.[1] ?? "unknown login";
}

/** What `operad plugin check` learns about the install. */
export interface CodexInstall {
  readonly acpVersion: string;
  readonly codexVersion: string | undefined;
  /** The login kind, such as `ChatGPT`; undefined when Codex could not be asked. */
  readonly login: string | undefined;
}

/**
 * Starts codex-acp with `--version` and asks Codex about the login. Throws
 * `CodexInstallError` with what to do when codex-acp cannot start or Codex is
 * not logged in. A Codex that cannot be asked is reported as unknown.
 */
export function inspectCodex(command: readonly string[], codex: readonly string[] | undefined): CodexInstall {
  const acp = run(command, ["--version"]);
  if (acp.exitCode !== 0) {
    throw new CodexInstallError(`\`${command.join(" ")} --version\` did not run; codex-acp cannot start`);
  }
  const acpVersion = versionOf(acp.stdout) ?? "unknown";
  if (codex === undefined) return { acpVersion, codexVersion: undefined, login: undefined };
  const version = run(codex, ["--version"]);
  const codexVersion = version.exitCode === 0 ? versionOf(version.stdout) : undefined;
  const status = run(codex, ["login", "status"]);
  if (status.exitCode === null) return { acpVersion, codexVersion, login: undefined };
  if (status.exitCode !== 0) {
    throw new CodexInstallError("Codex is not logged in; run `codex login` first");
  }
  return { acpVersion, codexVersion, login: loginKind(status.stdout) };
}
