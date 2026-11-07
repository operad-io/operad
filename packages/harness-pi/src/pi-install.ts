/**
 * Finds the user's installed pi (docs/backlog/operad-harness-pi.md decision 9).
 * The `pi` command on PATH (or the `command` setting) is resolved to its real
 * path; walking up from there reaches the package directory whose
 * `package.json` is `@earendil-works/pi-coding-agent`, and the file its
 * `exports["."]` names is the library. Nothing here installs or bundles pi.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** The package the worker uses. */
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

interface Semver {
  readonly core: readonly [number, number, number];
  readonly pre: readonly string[];
}

function parseSemver(version: string): Semver | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim());
  if (match === null) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split("."),
  };
}

/** Negative, zero or positive as `a` is below, equal to or above `b`. */
export function compareVersions(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (left === undefined || right === undefined) {
    throw new PiInstallError(`not a version: ${left === undefined ? a : b}`);
  }
  for (let at = 0; at < 3; at += 1) {
    const diff = (left.core[at] ?? 0) - (right.core[at] ?? 0);
    if (diff !== 0) return diff;
  }
  // A prerelease is below its release.
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  for (let at = 0; at < Math.max(left.pre.length, right.pre.length); at += 1) {
    const l = left.pre[at];
    const r = right.pre[at];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) {
      const diff = Number(l) - Number(r);
      if (diff !== 0) return diff;
    } else if (ln !== rn) {
      return ln ? -1 : 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

/** Finds the installed pi and checks its version against the floor. */
export function findPi(command: string = DEFAULT_PI_COMMAND, options: FindPiOptions = {}): PiInstall {
  const floor = options.floor ?? PI_FLOOR;
  const located = locate(command, options);
  if (located === undefined) {
    throw new PiInstallError(
      `no ${command === DEFAULT_PI_COMMAND ? "pi command" : `"${command}"`} was found on PATH; ` +
        `harness-pi needs ${PI_PACKAGE} ${floor} or newer installed (bun add -g ${PI_PACKAGE}, or npm i -g ${PI_PACKAGE})`,
    );
  }
  let real: string;
  try {
    real = realpathSync(located);
  } catch (error) {
    throw new PiInstallError(`${located}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let dir = dirname(real);
  let packageDir: string | undefined;
  let manifest: Record<string, unknown> | undefined;
  for (;;) {
    const candidate = readJson(join(dir, "package.json"));
    if (candidate !== undefined && candidate.name === PI_PACKAGE) {
      packageDir = dir;
      manifest = candidate;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (packageDir === undefined || manifest === undefined) {
    throw new PiInstallError(
      `${command} resolves to ${real}, which is not inside a ${PI_PACKAGE} package ` +
        `(a shell wrapper cannot be followed); set the harness-pi "command" setting to the package's bin`,
    );
  }

  const version = manifest.version;
  if (typeof version !== "string" || parseSemver(version) === undefined) {
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
  return { command, realPath: real, dir: packageDir, version, entry };
}

/** The library's own module type, for the call sites. */
export type PiLibrary = typeof import("@earendil-works/pi-coding-agent");

/** Loads the library file of an install with a dynamic import. */
export async function loadPi(install: PiInstall): Promise<PiLibrary> {
  return (await import(pathToFileURL(install.entry).href)) as PiLibrary;
}
