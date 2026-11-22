/**
 * Finds the installed pi (ADR 0023 D9).
 * The `pi` command on PATH (or the `command` setting) is resolved to its real
 * path; walking up from there reaches the package directory whose
 * `package.json` is `@earendil-works/pi-coding-agent`, and the file its
 * `exports["."]` names is the library. When there is no such command, the pi
 * operad installed in the home's plugin project is used instead. Nothing here
 * installs or bundles pi; the CLI installs it when the plugin is enabled.
 */

import { messageOf, readVersionText } from "@operad-io/engine";
import { strictVersionCompare } from "@operad-io/harness-process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@operad-io/engine";

/** The package the worker uses. */
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** The version operad installs into the home; it moves with an operad release (ADR 0023 D9). */
export const PI_VERSION = "1.6.0";

/** The oldest pi the worker's calls are written for. */
export const PI_FLOOR = "1.5.0";

/** The command looked up on PATH when the `command` setting is unset. */
export const DEFAULT_PI_COMMAND = "pi";

/** pi could not be found, or is not one the worker can use; the message says why. */
export class PiInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiInstallError";
  }
}

/** Where a pi lives and what it is. */
export interface PiInstall {
  /** The command as given. */
  readonly command: string;
  /** The real path the command resolved to. */
  readonly realPath: string;
  /** The package directory. */
  readonly dir: string;
  /** The version in the package's `package.json`. */
  readonly version: string;
  /** The absolute path of the file `exports["."]` names. */
  readonly entry: string;
}

export interface FindPiOptions {
  /** The PATH to search; defaults to the process's own. */
  readonly path?: string | undefined;
  readonly cwd?: string | undefined;
  /** The floor to compare with; defaults to `PI_FLOOR`. */
  readonly floor?: string | undefined;
  /**
   * The operad home: when the default `pi` command is not on PATH, the pi
   * operad installed into the home's plugin project is used (ADR 0023 D9).
   */
  readonly home?: string | undefined;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The file of a command: a path as given, or the first match on PATH. */
function locate(command: string, options: FindPiOptions): string | undefined {
  if (command.includes("/") || command.includes(sep)) {
    const path = isAbsolute(command) ? command : resolve(options.cwd ?? process.cwd(), command);
    return existsSync(path) ? path : undefined;
  }
  const found = Bun.which(command, {
    PATH: options.path ?? process.env.PATH ?? "",
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  return found ?? undefined;
}

/** `exports["."]` as a file path relative to the package; undefined if none. */
export function entryOf(exportsField: unknown): string | undefined {
  const pick = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = pick(item);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (isRecord(value)) {
      // Conditions, in the order a Bun import follows them.
      for (const key of ["import", "bun", "default"]) {
        if (key in value) {
          const found = pick(value[key]);
          if (found !== undefined) return found;
        }
      }
    }
    return undefined;
  };
  if (typeof exportsField === "string" || Array.isArray(exportsField)) return pick(exportsField);
  if (isRecord(exportsField)) {
    if ("." in exportsField) return pick(exportsField["."]);
    // A conditions object stands for ".".
    return pick(exportsField);
  }
  return undefined;
}

/** Negative, zero or positive as `a` is below, equal to or above `b`. */
export const compareVersions = strictVersionCompare((version) => new PiInstallError(`not a version: ${version}`));

/** The home's Bun project, where operad installs a plugin's package (ADR 0012 D4). */
const HOME_PLUGIN_PROJECT = "plugins";

/** The package directory operad installs into the home's Bun project. */
export function homePiPackageDir(home: string): string {
  return join(home, HOME_PLUGIN_PROJECT, "node_modules", PI_PACKAGE);
}

/** The `pi` command of an installed package, for `pi --list-models`. */
function packageCommand(packageDir: string, manifest: Record<string, unknown>): string {
  const bin = join(dirname(dirname(packageDir)), ".bin", "pi");
  if (existsSync(bin)) return bin;
  const declared = manifest.bin;
  const relative = typeof declared === "string" ? declared : isRecord(declared) ? declared.pi : undefined;
  return typeof relative === "string" ? join(packageDir, relative) : packageDir;
}

/** Checks a package directory and describes it. */
function installAt(packageDir: string, command: string, realPath: string, floor: string): PiInstall {
  const manifest = readJson(join(packageDir, "package.json"));
  if (manifest === undefined || manifest.name !== PI_PACKAGE) {
    throw new PiInstallError(`${packageDir} is not a ${PI_PACKAGE} package`);
  }
  const version = manifest.version;
  if (typeof version !== "string" || readVersionText(version) === undefined) {
    throw new PiInstallError(`${join(packageDir, "package.json")}: version is missing or not a version`);
  }
  if (compareVersions(version, floor) < 0) {
    throw new PiInstallError(
      `pi ${version} at ${packageDir} is older than the floor ${floor}; upgrade pi (${PI_PACKAGE} ${floor} or newer)`,
    );
  }

  const relative = entryOf(manifest.exports);
  if (relative === undefined) {
    throw new PiInstallError(`${join(packageDir, "package.json")}: exports["."] names no file`);
  }
  const entry = resolve(packageDir, relative);
  if (!entry.startsWith(packageDir + sep) || !existsSync(entry)) {
    throw new PiInstallError(`${join(packageDir, "package.json")}: exports["."] names ${relative}, which is not a file in the package`);
  }
  return { command, realPath, dir: packageDir, version, entry };
}

/** Finds the installed pi and checks its version against the floor. */
export function findPi(command: string = DEFAULT_PI_COMMAND, options: FindPiOptions = {}): PiInstall {
  const floor = options.floor ?? PI_FLOOR;
  const located = locate(command, options);
  if (located === undefined) {
    if (command === DEFAULT_PI_COMMAND && options.home !== undefined) {
      const install = findHomePi(options.home, floor);
      if (install !== undefined) return install;
    }
    throw new PiInstallError(
      `no ${command === DEFAULT_PI_COMMAND ? "pi command" : `"${command}"`} was found on PATH` +
        (options.home === undefined ? "" : " and the home has no pi installed") +
        `; pi needs ${PI_PACKAGE} ${floor} or newer installed (bun add -g ${PI_PACKAGE}, or npm i -g ${PI_PACKAGE}), ` +
        "or run `operad plugin enable pi` to install operad's own",
    );
  }
  let real: string;
  try {
    real = realpathSync(located);
  } catch (error) {
    throw new PiInstallError(`${located}: ${messageOf(error)}`);
  }

  let dir = dirname(real);
  let packageDir: string | undefined;
  for (;;) {
    const candidate = readJson(join(dir, "package.json"));
    if (candidate !== undefined && candidate.name === PI_PACKAGE) {
      packageDir = dir;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (packageDir === undefined) {
    throw new PiInstallError(
      `${command} resolves to ${real}, which is not inside a ${PI_PACKAGE} package ` +
        `(a shell wrapper cannot be followed); set the pi "command" setting to the package's bin`,
    );
  }
  return installAt(packageDir, command, real, floor);
}

/** The pi operad installed in the home, or undefined when the home has none. */
export function findHomePi(home: string, floor: string = PI_FLOOR): PiInstall | undefined {
  const dir = homePiPackageDir(home);
  const manifest = readJson(join(dir, "package.json"));
  if (manifest === undefined || manifest.name !== PI_PACKAGE) return undefined;
  return installAt(dir, packageCommand(dir, manifest), dir, floor);
}

/** The arguments of pi's own ChatGPT login, the `openai-codex` provider. */
const CHATGPT_LOGIN_ARGS = "auth login openai-codex";

/** A command as a shell takes it: quoted only when it has a character a shell splits on. */
function shellWord(word: string): string {
  return /^[A-Za-z0-9_.:@%+=,\/-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * The command a person runs to log in to their ChatGPT plan with pi itself:
 * `pi auth login openai-codex` when `pi` is on PATH (or the `command` setting
 * names a command), else the full command of the pi operad installed in the
 * home. operad never starts that login (ADR 0023 D11); it only reads pi's
 * auth file afterwards.
 */
export function chatgptLoginCommand(command: string = DEFAULT_PI_COMMAND, options: FindPiOptions = {}): string {
  if (locate(command, options) === undefined && command === DEFAULT_PI_COMMAND && options.home !== undefined) {
    try {
      const own = findHomePi(options.home);
      if (own !== undefined) return `${shellWord(own.command)} ${CHATGPT_LOGIN_ARGS}`;
    } catch {
      // A home pi that cannot be used is not one to name.
    }
  }
  return `${shellWord(command)} ${CHATGPT_LOGIN_ARGS}`;
}

/** The library's own module type, for the call sites. */
export type PiLibrary = typeof import("@earendil-works/pi-coding-agent");

/** Loads the library file of an install with a dynamic import. */
export async function loadPi(install: PiInstall): Promise<PiLibrary> {
  return (await import(pathToFileURL(install.entry).href)) as PiLibrary;
}
