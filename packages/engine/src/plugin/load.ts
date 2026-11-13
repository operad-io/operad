import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readConfig, type PluginConfigEntry } from "../config/config.ts";
import { messageOf, PluginError } from "./errors.ts";
import { defaultOperadHome } from "./home.ts";
import { INSTALL_ON_ENABLE, installedPackageFile, runningFromWorkspace } from "./install.ts";
import { keysPathFor, readKeysFile } from "./keys.ts";
import { PluginRegistry } from "./registry.ts";
import type { PluginRegistryOptions } from "./registry.ts";

/** Options for loading the registry from the operad home. */
export interface LoadPluginRegistryOptions extends PluginRegistryOptions {
  /** Defaults to `<home>/config.json`. */
  readonly configPath?: string | undefined;
  /** Defaults to `<home>/keys.json`. */
  readonly keysPath?: string | undefined;
}

let loadCount = 0;

/**
 * A plugin listed as a path is resolved against the operad home; anything else
 * is a module name. `file:` URLs pass through unchanged.
 */
function resolvePluginSpecifier(specifier: string, baseDir: string): string {
  if (specifier.startsWith("file:")) return specifier;
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("~")
  ) {
    const path = specifier.startsWith("~")
      ? join(homedir(), specifier.slice(1))
      : specifier;
    return pathToFileURL(resolve(baseDir, path)).href;
  }
  return specifier;
}

/** Imports a module file with a fresh instance, as a reload expects. */
async function importPluginFile(file: string): Promise<Record<string, unknown>> {
  loadCount += 1;
  const url = new URL(pathToFileURL(file).href);
  url.searchParams.set("operad-plugin-load", String(loadCount));
  return (await import(url.href)) as Record<string, unknown>;
}

/**
 * Imports a plugin module and returns its default export. The module name is
 * named in every import error. A path gets a fresh module instance so a later
 * reload does not reuse the old value.
 *
 * `installed` is the package's file in the home's Bun project (decision 11).
 * The workspace link is tried first, so a checkout keeps loading its own code;
 * when there is no such link, the home package is imported by path.
 */
export async function loadPlugin(
  specifier: string,
  baseDir: string,
  installed?: string | undefined,
): Promise<unknown> {
  const resolved = resolvePluginSpecifier(specifier, baseDir);
  const isFile = resolved.startsWith("file:");
  let url = resolved;
  if (isFile) {
    loadCount += 1;
    const parsed = new URL(resolved);
    parsed.searchParams.set("operad-plugin-load", String(loadCount));
    url = parsed.href;
  }

  let module: Record<string, unknown>;
  try {
    module = (await import(url)) as Record<string, unknown>;
  } catch (error) {
    if (installed === undefined) {
      throw new PluginError(
        `plugin "${specifier}": import failed: ${messageOf(error)}`,
        { cause: error },
      );
    }
    try {
      module = await importPluginFile(installed);
    } catch (installedError) {
      throw new PluginError(
        `plugin "${specifier}": import failed: ${messageOf(error)}; the package in the home also failed: ${messageOf(installedError)}`,
        { cause: installedError },
      );
    }
  }

  if (module.default === undefined) {
    throw new PluginError(`plugin "${specifier}": no default export`);
  }
  return module.default;
}

/** One configured plugin and the definition it resolved to, if any. */
export interface ConfiguredPlugin {
  readonly entry: PluginConfigEntry;
  readonly definition?: unknown;
  readonly error?: string | undefined;
}

/** What reading the plugins list produced, before the registry validates them. */
export interface ConfiguredPlugins {
  readonly entries: readonly PluginConfigEntry[];
  /** The entries that loaded, in config order. */
  readonly loaded: readonly DefinitelyLoadedPlugin[];
  /** The names that are switched off in the config. */
  readonly disabled: readonly string[];
  /** Everything that did not load, one line each. */
  readonly errors: readonly string[];
}

export interface DefinitelyLoadedPlugin {
  readonly entry: PluginConfigEntry;
  readonly definition: unknown;
}

function definitionName(value: unknown): string | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof (value as { name?: unknown }).name === "string"
  ) {
    return (value as { name: string }).name;
  }
  return undefined;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * False only when the config file does not exist. Any other access error means
 * the file may exist but cannot be read, so `readConfig` gets to report it
 * instead of the load quietly returning an empty configuration.
 */
async function configFileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    return !isMissingFileError(error);
  }
}

/**
 * Imports every enabled plugin in the config. A module that fails to import is
 * reported and skipped, so one broken plugin does not keep the rest from
 * loading. Disabled entries are returned by name and never imported.
 */
export async function loadConfiguredPlugins(
  options: LoadPluginRegistryOptions = {},
): Promise<ConfiguredPlugins> {
  const home = options.home ?? defaultOperadHome();
  const configFile = options.configPath ?? join(home, "config.json");
  if (!(await configFileExists(configFile))) {
    return { entries: [], loaded: [], disabled: [], errors: [] };
  }
  const config = await readConfig(home, configFile);
  const loaded: DefinitelyLoadedPlugin[] = [];
  const disabled: string[] = [];
  const errors: string[] = [];

  for (const entry of config.plugins) {
    if (!entry.enabled) {
      if (entry.name !== undefined) disabled.push(entry.name);
      continue;
    }
    const installed = installedPackageFile(home, entry.module);
    // Outside a workspace checkout the home project is the copy to run, even
    // when another install of the same package happens to resolve.
    const source = installed !== undefined && !runningFromWorkspace() ? installed : entry.module;
    let definition: unknown;
    try {
      definition = await loadPlugin(source, home, installed);
    } catch (error) {
      if (
        entry.name !== undefined &&
        INSTALL_ON_ENABLE.includes(entry.name) &&
        installed === undefined &&
        !runningFromWorkspace()
      ) {
        errors.push(
          `plugin "${entry.name}": not installed; run \`operad plugin enable ${entry.name}\` to install it`,
        );
      } else {
        errors.push(messageOf(error));
      }
      continue;
    }
    if (entry.name !== undefined) {
      const declared = definitionName(definition);
      if (declared !== undefined && declared !== entry.name && entry.module !== entry.name) {
        errors.push(
          `plugin "${entry.name}": unknown plugin; the module "${entry.module}" provides "${declared}"`,
        );
        continue;
      }
    }
    loaded.push({ entry, definition });
  }

  return { entries: config.plugins, loaded, disabled, errors };
}

/**
 * Loads the plugins listed in `$OPERAD_HOME/config.json` (default
 * `~/.operad/config.json`) and validates them together.
 */
export async function loadPluginRegistry(
  options: LoadPluginRegistryOptions = {},
): Promise<PluginRegistry> {
  const home = options.home ?? defaultOperadHome();
  const onLog = options.onLog ?? ((message: string) => console.error(message));
  const config = await loadConfiguredPlugins({ ...options, home, onLog });

  for (const error of config.errors) onLog(error);

  const definitions: unknown[] = [];
  const sources: string[] = [];
  const settings: Record<string, unknown> = {};
  for (const { entry, definition } of config.loaded) {
    definitions.push(definition);
    sources.push(entry.module);
    const name = definitionName(definition) ?? entry.name;
    if (name !== undefined) settings[name] = entry.settings;
  }

  const keys = await readKeysFile(options.keysPath ?? keysPathFor(home));
  return new PluginRegistry(definitions, {
    ...options,
    home,
    keys: options.keys ?? keys,
    sources,
    settings: options.settings ?? settings,
    disabled: options.disabled ?? config.disabled,
  });
}
