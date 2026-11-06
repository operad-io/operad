import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { messageOf, PluginError } from "./errors.ts";
import { defaultOperadHome } from "./home.ts";
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

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

/**
 * Imports a plugin module and returns its default export. The module name is
 * named in every import error. A path gets a fresh module instance so a later
 * reload does not reuse the old value.
 */
export async function loadPlugin(
  specifier: string,
  baseDir: string,
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
    throw new PluginError(
      `plugin "${specifier}": import failed: ${messageOf(error)}`,
      { cause: error },
    );
  }

  if (module.default === undefined) {
    throw new PluginError(`plugin "${specifier}": no default export`);
  }
  return module.default;
}

/**
 * Reads only the `plugins` key of the home config. A missing file means no
 * plugins; other keys belong to later parts of the kernel.
 */
async function readPluginSpecifiers(
  configPath: string,
): Promise<readonly string[]> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (isMissing(error)) return [];
    throw new PluginError(
      `plugin config "${configPath}": ${messageOf(error)}`,
      { cause: error },
    );
  }

  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new PluginError(
      `plugin config "${configPath}": invalid JSON: ${messageOf(error)}`,
      { cause: error },
    );
  }
  if (!isRecord(config)) {
    throw new PluginError(
      `plugin config "${configPath}": must be a JSON object`,
    );
  }

  const plugins = config.plugins;
  if (plugins === undefined) return [];
  if (
    !Array.isArray(plugins) ||
    !plugins.every(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    )
  ) {
    throw new PluginError(
      `plugin config "${configPath}": plugins: must be an array of module names or paths`,
    );
  }
  return plugins;
}

/**
 * Loads the plugins listed in `$OPERAD_HOME/config.json` (default
 * `~/.operad/config.json`) and validates them together.
 */
export async function loadPluginRegistry(
  options: LoadPluginRegistryOptions = {},
): Promise<PluginRegistry> {
  const home = options.home ?? defaultOperadHome();
  const configPath = options.configPath ?? join(home, "config.json");
  const specifiers = await readPluginSpecifiers(configPath);
  const keys = await readKeysFile(options.keysPath ?? keysPathFor(home));
  const definitions: unknown[] = [];
  for (const specifier of specifiers) {
    definitions.push(await loadPlugin(specifier, home));
  }
  return new PluginRegistry(definitions, {
    ...options,
    home,
    keys: options.keys ?? keys,
    sources: specifiers,
  });
}
