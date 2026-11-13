/**
 * Packages that are not part of the CLI's own dependencies are installed into
 * one Bun project under the operad home when the person enables them
 * (docs/backlog/operad-plugins.md decision 11). The project keeps its own
 * `package.json` and lockfile; nothing is installed into the CLI's tree.
 *
 * The claude harness needs `@anthropic-ai/claude-agent-sdk`, whose optional
 * per-platform packages carry a Claude Code binary operad does not use, so the
 * install skips optional dependencies.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isRecord } from "../util.ts";

/** The directory under the operad home that holds the Bun project. */
export const PLUGIN_PROJECT_DIRECTORY = "plugins";

/** The package name the generated project manifests use. */
const PROJECT_NAME = "operad-plugins";

/** The plugins whose package is installed into the home rather than shipped with the CLI. */
export const INSTALL_ON_ENABLE: readonly string[] = ["claude"];

/** Where the home's plugin project lives. */
export function pluginProjectPath(home: string): string {
  return join(home, PLUGIN_PROJECT_DIRECTORY);
}

/** The project manifest, when the home has one. */
export function pluginProjectManifestPath(home: string): string {
  return join(pluginProjectPath(home), "package.json");
}

/**
 * True in a checkout of the operad workspace, where packages load from the
 * workspace links instead of the home project.
 */
export function runningFromWorkspace(): boolean {
  // This file is under src/plugin; walk to the package that holds it.
  let packageDirectory = import.meta.dir;
  for (;;) {
    const parent = dirname(packageDirectory);
    if (parent === packageDirectory) return false;
    try {
      const manifest: unknown = JSON.parse(readFileSync(join(parent, "package.json"), "utf8"));
      if (isRecord(manifest) && manifest.name === "@operad-io/engine") {
        packageDirectory = parent;
        break;
      }
    } catch {
      // Not a package directory; keep walking.
    }
    packageDirectory = parent;
  }
  if (basename(packageDirectory) !== "engine") return false;
  const packagesDirectory = dirname(packageDirectory);
  if (basename(packagesDirectory) !== "packages") return false;
  const root = dirname(packagesDirectory);
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return isRecord(manifest) && manifest.name === "operad-workspace" && Array.isArray(manifest.workspaces);
  } catch {
    return false;
  }
}

/** The package name of a specifier: `@scope/name` or `name`. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

/** The subpath of a specifier below its package name; empty for the package itself. */
function subpathOf(specifier: string): string {
  return specifier.slice(packageNameOf(specifier).length).replace(/^\//, "");
}

/** The file an `exports` target names, following the conditions Bun imports first. */
function targetFile(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = targetFile(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const key of ["import", "bun", "default"]) {
      if (key in value) {
        const found = targetFile(value[key]);
        if (found !== undefined) return found;
      }
    }
  }
  return undefined;
}

/**
 * The file a specifier names in an installed package, read from the package's
 * own `exports`. This is deliberately not `Bun.resolveSync`: Bun caches the
 * miss from the check before the install, so the same process would not see the
 * package it has just installed.
 */
function packageEntry(packageDirectory: string, subpath: string): string | undefined {
  let manifest: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
    if (!isRecord(value)) return undefined;
    manifest = value;
  } catch {
    return undefined;
  }
  const key = subpath === "" ? "." : `./${subpath}`;
  const exportsField = manifest.exports;
  let relative: string | undefined;
  if (typeof exportsField === "string" || Array.isArray(exportsField)) {
    if (subpath === "") relative = targetFile(exportsField);
  } else if (isRecord(exportsField)) {
    if (key in exportsField) relative = targetFile(exportsField[key]);
    else if (subpath === "" && !Object.keys(exportsField).some((name) => name.startsWith("."))) {
      relative = targetFile(exportsField);
    }
  } else if (subpath === "") {
    relative = typeof manifest.main === "string" ? manifest.main : "index.js";
  }
  if (relative === undefined) return undefined;
  const file = join(packageDirectory, relative);
  return existsSync(file) ? file : undefined;
}

/**
 * The file a specifier resolves to in the home's plugin project, or undefined
 * when the project does not hold it.
 */
export function installedPackageFile(home: string, specifier: string): string | undefined {
  const manifest = pluginProjectManifestPath(home);
  if (!existsSync(manifest)) return undefined;
  const packageDirectory = join(pluginProjectPath(home), "node_modules", packageNameOf(specifier));
  return packageEntry(packageDirectory, subpathOf(specifier));
}

/** What a command a test replaces returned. */
export interface InstallRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one command; a test replaces the real Bun process. */
export type InstallRunner = (cwd: string, args: readonly string[]) => InstallRun;

function runWithBun(cwd: string, args: readonly string[]): InstallRun {
  const ran = Bun.spawnSync({
    cmd: [process.execPath, ...args],
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: ran.exitCode,
    stdout: ran.stdout.toString(),
    stderr: ran.stderr.toString(),
  };
}

function readManifest(path: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path}: invalid JSON: ${String(error)}`, { cause: error });
  }
  if (!isRecord(value)) throw new Error(`${path}: must be a JSON object`);
  return value;
}

/** A short spelling of what a failed install printed, for the refusal. */
function outputTail(run: InstallRun): string {
  const text = `${run.stdout}\n${run.stderr}`.trim();
  if (text.length === 0) return "it printed nothing";
  const lines = text.split("\n").slice(-8).join("\n");
  return lines.length > 2000 ? lines.slice(-2000) : lines;
}

/** Options for installing one package into the home project. */
export interface EnsureInstalledOptions {
  readonly home: string;
  /** The package to install, such as `@operad-io/harness-claude`. */
  readonly specifier: string;
  /** The version the CLI was published as. */
  readonly version: string;
  /** Where the CLI itself lives; used to recognise the workspace checkout. */
  readonly from?: string | undefined;
  /** Skip optional dependencies; the claude SDK's platform binaries are optional. */
  readonly omitOptional?: boolean | undefined;
  /** A test replaces the command; defaults to Bun. */
  readonly run?: InstallRunner | undefined;
}

/**
 * Makes sure `specifier` is available from the home project and returns its
 * file. In a workspace checkout, where the package already resolves from the
 * CLI, it returns undefined and installs nothing.
 */
export async function ensureInstalledPackage(options: EnsureInstalledOptions): Promise<string | undefined> {
  const { home, specifier, version } = options;
  if (runningFromWorkspace() && options.from !== undefined) {
    try {
      Bun.resolveSync(specifier, join(options.from, "package.json"));
      return undefined;
    } catch {
      // Not linked in this checkout: fall through to the home project.
    }
  }

  const directory = pluginProjectPath(home);
  const path = join(directory, "package.json");
  const manifest = readManifest(path) ?? {
    name: PROJECT_NAME,
    private: true,
    type: "module",
  };
  const rawDependencies = manifest.dependencies;
  if (rawDependencies !== undefined && !isRecord(rawDependencies)) {
    throw new Error(`${path}: dependencies must be an object`);
  }
  const dependencies: Record<string, unknown> = { ...(rawDependencies ?? {}) };
  const existing = dependencies[specifier];
  // A test (or a person pinning a local build) may name a tarball; keep it.
  const wanted =
    typeof existing === "string" && (existing === version || existing.startsWith("file:"))
      ? existing
      : version;
  const found = installedPackageFile(home, specifier);
  if (existing === wanted && found !== undefined) return found;

  dependencies[specifier] = wanted;
  manifest.dependencies = dependencies;
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);

  const args = ["install", ...(options.omitOptional === true ? ["--omit=optional"] : []), "--no-summary"];
  const run = (options.run ?? runWithBun)(directory, args);
  if (run.exitCode !== 0) {
    throw new Error(
      `${specifier}: \`bun ${args.join(" ")}\` in ${directory} failed with exit code ${String(run.exitCode)}; ${outputTail(run)}`,
    );
  }
  const installed = installedPackageFile(home, specifier);
  if (installed === undefined) {
    throw new Error(`${specifier}: was installed into ${directory}, but its entry does not resolve`);
  }
  return installed;
}
