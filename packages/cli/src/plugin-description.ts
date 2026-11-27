/** The one line a plugin's package says about what the plugin gives. */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installedPackageFile } from "@operad-io/engine";

/**
 * The descriptions of shipped plugins whose package the CLI does not carry
 * (`INSTALL_ON_ENABLE`): before such a plugin is installed there is no
 * `package.json` to read. Each is the package's own `description`.
 */
export const UNINSTALLED_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "@operad-io/harness-claude": "chats and tasks run by Claude Code",
};

function manifestIn(directory: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    return typeof value === "object" && value !== null ? { ...value } : undefined;
  } catch {
    return undefined;
  }
}

/** The manifest named `name` in the directory of `file` or above it. */
function manifestNamed(name: string, file: string): Record<string, unknown> | undefined {
  for (let directory = dirname(file); ; directory = dirname(directory)) {
    const manifest = manifestIn(directory);
    if (manifest?.name === name) return manifest;
    if (dirname(directory) === directory) return undefined;
  }
}

/**
 * The manifest of a plugin listed as a path: the one beside its file, or above
 * its `src` directory. A manifest further up belongs to something else, such as
 * the repository the file sits in.
 */
function manifestOfPath(module: string, home: string): Record<string, unknown> | undefined {
  const file = module.startsWith("file:")
    ? fileURLToPath(module)
    : resolve(home, module.startsWith("~") ? join(homedir(), module.slice(1)) : module);
  const directory = dirname(file);
  return manifestIn(directory) ?? (basename(directory) === "src" ? manifestIn(dirname(directory)) : undefined);
}

/** The file a package name loads from: the home's plugin project, then the CLI's own packages. */
function packageFile(module: string, home: string, from: string): string | undefined {
  const installed = installedPackageFile(home, module);
  if (installed !== undefined) return installed;
  try {
    return Bun.resolveSync(module, from);
  } catch {
    return undefined;
  }
}

/** The name of the package a specifier is in: `@scope/name` or `name`. */
function packageName(specifier: string): string {
  return specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
}

/**
 * The `description` in the `package.json` of the plugin `config.json` names as
 * `module`, on one line. It reads the file and does not import the plugin.
 * `from` is where the CLI's own packages resolve.
 */
export function pluginDescription(module: string, home: string, from: string = import.meta.dir): string | undefined {
  let manifest: Record<string, unknown> | undefined;
  if (/^(?:file:|[./~])/.test(module)) {
    manifest = manifestOfPath(module, home);
  } else {
    const file = packageFile(module, home, from);
    manifest = file === undefined ? undefined : manifestNamed(packageName(module), file);
  }
  const text = manifest === undefined ? UNINSTALLED_DESCRIPTIONS[module] : manifest.description;
  if (typeof text !== "string") return undefined;
  const line = text.replace(/\s+/g, " ").trim();
  return line.length === 0 ? undefined : line;
}
