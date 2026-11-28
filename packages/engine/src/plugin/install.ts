/**
 * Packages that are not part of the CLI's own dependencies are installed into
 * one Bun project under the operad home when the person enables them
 * (ADR 0012 D4). The project keeps its own
 * `package.json` and lockfile; nothing is installed into the CLI's tree.
 *
 * The claude harness needs `@anthropic-ai/claude-agent-sdk`, whose optional
 * per-platform packages carry a Claude Code binary operad does not use, so the
 * install skips optional dependencies.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { withLockFile } from "../platform/file-lock.ts";
import { waitForChange } from "../platform/watch.ts";
import { isMissingFile, isRecord } from "../util.ts";

/** The directory under the operad home that holds the Bun project. */
export const PLUGIN_PROJECT_DIRECTORY = "plugins";

/** The package name the generated project manifests use. */
const PROJECT_NAME = "operad-plugins";

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

/** True when `name` is in a `node_modules` that a module in `directory` looks in. */
function dependencyFrom(directory: string, name: string): boolean {
  for (let at = directory; ; at = dirname(at)) {
    if (existsSync(join(at, "node_modules", name, "package.json"))) return true;
    if (dirname(at) === at) return false;
  }
}

/**
 * True when each dependency the package names is there, apart from the optional
 * ones: an install that was left part done has the package and not all of them.
 */
function dependenciesPresent(packageDirectory: string): boolean {
  const manifest = packageManifest(packageDirectory);
  const optional = manifest?.optionalDependencies;
  const names = Object.keys(dependenciesOf(manifest)).filter(
    (name) => !(isRecord(optional) && Object.hasOwn(optional, name)),
  );
  if (names.length === 0) return true;
  // An isolated layout links the package; its dependencies are beside the target.
  const real = realpathSync(packageDirectory);
  return names.every((name) => dependencyFrom(real, name));
}

/**
 * The file a specifier resolves to in the home's plugin project, or undefined
 * when the project does not hold it, or holds it without its dependencies.
 */
export function installedPackageFile(home: string, specifier: string): string | undefined {
  const manifest = pluginProjectManifestPath(home);
  if (!existsSync(manifest)) return undefined;
  const packageDirectory = join(pluginProjectPath(home), "node_modules", packageNameOf(specifier));
  const entry = packageEntry(packageDirectory, subpathOf(specifier));
  return entry !== undefined && dependenciesPresent(packageDirectory) ? entry : undefined;
}

/** What a command a test replaces returned. */
export interface InstallRun {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Receives one line a package command printed while it ran. */
export type InstallProgress = (line: string) => void;

/** Runs one command; a test replaces the real Bun process. */
export type InstallRunner = (
  cwd: string,
  args: readonly string[],
  onProgress?: InstallProgress,
  signal?: AbortSignal,
) => InstallRun | Promise<InstallRun>;

/** The most characters of one progress line kept for a client. */
const PROGRESS_LINE_MAX = 200;

function reportLine(text: string, onProgress: InstallProgress | undefined): void {
  if (onProgress === undefined) return;
  const line = text.replace(/\x1b\[[0-9;]*m/g, "").trim();
  if (line.length > 0) onProgress(line.slice(0, PROGRESS_LINE_MAX));
}

/** Reads a child's stream into `out`, reporting whole lines as they arrive. */
async function readReported(
  stream: ReadableStream<Uint8Array> | undefined,
  out: string[],
  onProgress: InstallProgress | undefined,
): Promise<void> {
  if (stream === undefined) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const text = decoder.decode(chunk.value, { stream: true });
    out.push(text);
    pending += text;
    const parts = pending.split(/[\r\n]+/);
    pending = parts.pop() ?? "";
    for (const part of parts) reportLine(part, onProgress);
  }
  const last = decoder.decode();
  out.push(last);
  pending += last;
  for (const part of pending.split(/[\r\n]+/)) reportLine(part, onProgress);
}

async function runWithBun(
  cwd: string,
  args: readonly string[],
  onProgress?: InstallProgress,
  signal?: AbortSignal,
): Promise<InstallRun> {
  const child = Bun.spawn({
    cmd: [process.execPath, ...args],
    cwd,
    ...(signal === undefined ? {} : { signal }),
    // Without this Bun gives a child the environment the process started with,
    // so a cache or registry set since then would not reach the install.
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  await Promise.all([
    readReported(child.stdout, stdout, onProgress),
    readReported(child.stderr, stderr, onProgress),
  ]);
  return {
    exitCode: await child.exited,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
  };
}

function readManifest(path: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
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

/** True when the output says the package could not be downloaded. */
function looksLikeNetworkFailure(text: string): boolean {
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|getaddrinfo|fetch failed|network is unreachable|could not resolve/i.test(
    text,
  );
}

/** The refusal of a failed install, with how to retry a download that did not happen. */
function failedInstall(
  specifier: string,
  args: readonly string[],
  directory: string,
  run: InstallRun,
): Error {
  const text = `${run.stdout}\n${run.stderr}`;
  const retry = looksLikeNetworkFailure(text)
    ? "; the package could not be downloaded, so check the network and run the command again"
    : "; run the command again to retry";
  return new Error(
    `${specifier}: \`bun ${args.join(" ")}\` in ${directory} failed with exit code ${String(run.exitCode)}; ${outputTail(run)}${retry}`,
  );
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
  /** Receives each line the install prints while it runs. */
  readonly onProgress?: InstallProgress | undefined;
  /** A test replaces the command; defaults to Bun. */
  readonly run?: InstallRunner | undefined;
  /** Ends the install command when aborted. */
  readonly signal?: AbortSignal | undefined;
  /** Called when something has to be installed, before the command runs. */
  readonly onInstall?: (() => void) | undefined;
  /**
   * A failed install puts the project's manifest back as it was for this
   * package, so a later install in the project does not fetch it.
   */
  readonly forgetOnFailure?: boolean | undefined;
}

/** How long an install waits for another one in the same home to end. */
const INSTALL_LOCK_TIMEOUT_MS = 15 * 60_000;

/** What a waiting install reports, once. */
export const INSTALL_WAITING_LINE = "waiting for another install in this home to end";

/**
 * Runs `work` as the only change to the home's plugin project, in this process
 * and any other. An aborted signal ends the wait.
 */
async function changingProject<T>(
  home: string,
  work: () => Promise<T>,
  options: { readonly onProgress?: InstallProgress | undefined; readonly signal?: AbortSignal | undefined } = {},
): Promise<T> {
  const lock = join(pluginProjectPath(home), ".install.lock");
  let told = false;
  return await withLockFile(lock, work, {
    label: "plugin install",
    timeoutMs: INSTALL_LOCK_TIMEOUT_MS,
    wait: async (ms) => {
      options.signal?.throwIfAborted();
      if (!told) {
        told = true;
        options.onProgress?.(INSTALL_WAITING_LINE);
      }
      await waitForChange(dirname(lock), lock, ms);
      options.signal?.throwIfAborted();
    },
  });
}

/** True when the installed package is the one `wanted` names; a tarball names no version to compare. */
function holdsWanted(home: string, specifier: string, wanted: string): boolean {
  if (wanted.startsWith("file:")) return true;
  const directory = join(pluginProjectPath(home), "node_modules", packageNameOf(specifier));
  return packageManifest(directory)?.version === wanted;
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

  // What is already there is answered without waiting for another install.
  const ready = installedAs(home, specifier, version).file;
  if (ready !== undefined) return ready;
  return await changingProject(home, () => installPackage(options), options);
}

/** The dependency to name for `specifier`, and its file when nothing has to be installed. */
function installedAs(
  home: string,
  specifier: string,
  version: string,
): { readonly wanted: string; readonly file: string | undefined } {
  const existing = dependenciesOf(readManifest(pluginProjectManifestPath(home)))[specifier];
  // A test (or a person pinning a local build) may name a tarball; keep it.
  const wanted =
    typeof existing === "string" && (existing === version || existing.startsWith("file:"))
      ? existing
      : version;
  // The manifest names the new version before the install runs, so after a
  // failed upgrade only the installed package says what the home holds.
  const installed = existing === wanted && holdsWanted(home, specifier, wanted);
  return { wanted, file: installed ? installedPackageFile(home, specifier) : undefined };
}

/** Puts back the dependency the project named for `specifier` before an install. */
function restoreDependency(path: string, specifier: string, previous: unknown): void {
  const manifest = readManifest(path);
  if (manifest === undefined) return;
  const dependencies = { ...dependenciesOf(manifest) };
  if (previous === undefined) delete dependencies[specifier];
  else dependencies[specifier] = previous;
  manifest.dependencies = dependencies;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Writes the dependency and runs the install; the caller holds the project. */
async function installPackage(options: EnsureInstalledOptions): Promise<string> {
  const { home, specifier, version } = options;
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
  // Another install may have brought it while this one waited.
  const { wanted, file } = installedAs(home, specifier, version);
  if (file !== undefined) return file;

  dependencies[specifier] = wanted;
  manifest.dependencies = dependencies;
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);

  const args = ["install", ...(options.omitOptional === true ? ["--omit=optional"] : []), "--no-summary"];
  options.onInstall?.();
  try {
    const run = await (options.run ?? runWithBun)(directory, args, options.onProgress, options.signal);
    if (run.exitCode !== 0) {
      throw failedInstall(specifier, args, directory, run);
    }
    const installed = installedPackageFile(home, specifier);
    if (installed === undefined) {
      throw new Error(
        `${specifier}: was installed into ${directory}, but its entry does not resolve or a dependency is missing`,
      );
    }
    // `serve` reloads after an install, so one that changed nothing must not count.
    if (!holdsWanted(home, specifier, wanted)) {
      throw new Error(`${specifier}: was installed into ${directory}, but it is not version ${wanted}`);
    }
    return installed;
  } catch (error) {
    if (options.forgetOnFailure === true) restoreDependency(path, specifier, existing);
    throw error;
  }
}


/** The lifecycle scripts a package needs before it can be imported. */
const INSTALL_SCRIPT_NAMES = ["preinstall", "install", "postinstall"] as const;

function packageManifest(packageDirectory: string): Record<string, unknown> | undefined {
  try {
    return readManifest(join(packageDirectory, "package.json"));
  } catch {
    return undefined;
  }
}

/** True when the package's manifest declares a lifecycle script. */
function declaresInstallScript(manifest: Record<string, unknown> | undefined): boolean {
  const scripts = manifest?.scripts;
  if (!isRecord(scripts)) return false;
  return INSTALL_SCRIPT_NAMES.some((name) => typeof scripts[name] === "string");
}

function installScriptHint(packageDirectory: string): string {
  return declaresInstallScript(packageManifest(packageDirectory))
    ? "; its package declares an install script, and installing runs no package scripts, so a package that needs one cannot be added"
    : "";
}

function dependenciesOf(manifest: Record<string, unknown> | undefined): Record<string, unknown> {
  if (manifest === undefined) return {};
  const dependencies = manifest.dependencies;
  return isRecord(dependencies) ? dependencies : {};
}

/** The dependency name `bun add` wrote for a package, including a local tarball. */
function addedDependencyName(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  wanted: string | undefined,
): string | undefined {
  if (wanted !== undefined) return wanted;
  const previous = dependenciesOf(before);
  const next = dependenciesOf(after);
  const changed = Object.keys(next).filter((name) => previous[name] !== next[name]);
  if (changed.length === 1) return changed[0];
  const named = Object.entries(next).find(
    ([, value]) => typeof value === "string" && value.includes("file:"),
  );
  return named?.[0];
}

/** Options for adding one package to the home project. */
export interface AddPackageOptions {
  readonly home: string;
  /** A package name, or a local tarball a test installs without a registry. */
  readonly specifier: string;
  /** An exact version; absent asks Bun for the latest. */
  readonly version?: string | undefined;
  /** Receives each line the install prints while it runs. */
  readonly onProgress?: InstallProgress | undefined;
  /** A test replaces the command; defaults to Bun. */
  readonly run?: InstallRunner | undefined;
}

/** Options for removing one package from the home project. */
export interface RemovePackageOptions {
  readonly home: string;
  /** The package name `addPackage` returned. */
  readonly name: string;
  /**
   * The dependency spec the project had before the add; when present, put it
   * back instead of removing the package the project already needed.
   */
  readonly previous?: string | undefined;
  /** A test replaces the command; defaults to Bun. */
  readonly run?: InstallRunner | undefined;
}

/** What adding a package installed. */
export interface AddedPackage {
  readonly name: string;
  readonly version: string;
  readonly file: string;
  /** True when the package declares a lifecycle script Bun was told not to run. */
  readonly hasInstallScript: boolean;
  /** The dependency spec the project named before the add, when it named one. */
  readonly previousVersion?: string | undefined;
}

/**
 * Installs one package into the home's Bun project with install scripts off.
 * The package may be a name with an exact version, a name with no version
 * (the latest), or a local tarball a test names. Unlike
 * `ensureInstalledPackage`, this always asks Bun for the package, so a person
 * adding it gets the version they named.
 */
export async function addPackage(options: AddPackageOptions): Promise<AddedPackage> {
  return await changingProject(options.home, () => addToProject(options), options);
}

async function addToProject(options: AddPackageOptions): Promise<AddedPackage> {
  const directory = pluginProjectPath(options.home);
  const path = join(directory, "package.json");
  const before = readManifest(path);
  mkdirSync(directory, { recursive: true });
  if (before === undefined) {
    writeFileSync(
      path,
      `${JSON.stringify({ name: PROJECT_NAME, private: true, type: "module" }, null, 2)}\n`,
    );
  }
  const target =
    options.version === undefined ? options.specifier : `${options.specifier}@${options.version}`;
  const args = ["add", target, "--exact", "--ignore-scripts", "--no-summary"];
  const run = await (options.run ?? runWithBun)(directory, args, options.onProgress);
  if (run.exitCode !== 0) {
    throw failedInstall(options.specifier, args, directory, run);
  }
  const after = readManifest(path);
  if (after === undefined) {
    throw new Error(`${options.specifier}: \`bun ${args.join(" ")}\` in ${directory} wrote no package.json`);
  }
  const wanted =
    options.specifier.startsWith("file:") || options.specifier.startsWith(".") || options.specifier.startsWith("/")
      ? undefined
      : options.specifier;
  const name = addedDependencyName(before ?? {}, after, wanted);
  if (name === undefined) {
    throw new Error(`${options.specifier}: was installed into ${directory}, but the project does not name it`);
  }
  const packageDirectory = join(directory, "node_modules", packageNameOf(name));
  const manifest = packageManifest(packageDirectory);
  if (manifest === undefined) {
    throw new Error(`${options.specifier}: was installed into ${directory}, but its package.json is missing`);
  }
  const version = manifest.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`${options.specifier}: its installed package has no version`);
  }
  const file = installedPackageFile(options.home, name);
  if (file === undefined) {
    throw new Error(
      `${options.specifier}: was installed into ${directory}, but its entry does not resolve${installScriptHint(packageDirectory)}`,
    );
  }
  const previous = before === undefined ? undefined : dependenciesOf(before)[name];
  return {
    name,
    version,
    file,
    hasInstallScript: declaresInstallScript(manifest),
    previousVersion: typeof previous === "string" ? previous : undefined,
  };
}

/**
 * Takes a package out of the home's Bun project again, dependency, files and
 * lockfile entry alike. A refusal after `addPackage` calls this so a package
 * operad refused does not stay installed; the project already naming it means
 * it was not this add's to take away, so `previous` puts that dependency back.
 * A package the project does not name is left alone.
 */
export async function removePackage(options: RemovePackageOptions): Promise<void> {
  // A home with no project has nothing to take out, and gets no lock file.
  if (!existsSync(pluginProjectManifestPath(options.home))) return;
  await changingProject(options.home, () => removeFromProject(options));
}

async function removeFromProject(options: RemovePackageOptions): Promise<void> {
  const directory = pluginProjectPath(options.home);
  const path = join(directory, "package.json");
  const manifest = readManifest(path);
  if (manifest === undefined) return;
  let args: string[];
  if (options.previous !== undefined) {
    const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : {};
    dependencies[options.name] = options.previous;
    manifest.dependencies = dependencies;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    args = ["install", "--ignore-scripts", "--no-summary"];
  } else {
    const dependencies = manifest.dependencies;
    if (!isRecord(dependencies) || !Object.hasOwn(dependencies, options.name)) return;
    args = ["remove", options.name, "--ignore-scripts", "--no-summary"];
  }
  const run = await (options.run ?? runWithBun)(directory, args);
  if (run.exitCode !== 0) {
    throw failedInstall(options.name, args, directory, run);
  }
}
