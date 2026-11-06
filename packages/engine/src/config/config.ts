/** The operad home config: JSON, read by the kernel, never by a plugin kind. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { defaultOperadHome } from "../plugin/home.ts";
import { openLog, type LogBackend, type LogBackendName } from "../log/index.ts";

/** The storage backend the log uses. */
export type StoreBackend = LogBackendName;

/** Where the log lives: a directory for `jsonl`, a file for `sqlite`. */
export interface StoreConfig {
  readonly backend: StoreBackend;
  readonly path: string;
}

/** One plugin listed in `config.json`, with its options. */
export interface PluginConfigEntry {
  /** The name the config keyed the plugin by, when it keyed one. */
  readonly name: string | undefined;
  /** The module name or path to import. */
  readonly module: string;
  readonly enabled: boolean;
  /** The raw section handed to the plugin's settings schema. */
  readonly settings: unknown;
}

/** The keys of `$OPERAD_HOME/config.json` the kernel reads. */
export interface OperadConfig {
  readonly plugins: readonly PluginConfigEntry[];
  readonly store: StoreConfig;
}

/** A config file is not usable; the message names the file and the field. */
export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}

/** The plugins `operad init` installs, in load order. */
export const DEFAULT_PLUGINS: readonly string[] = [
  "shell",
  "harness-radian",
  "dev",
];

/** The package name of a plugin shipped with operad. */
export function defaultPluginModule(name: string): string {
  return `@operad-io/${name}`;
}

export function configPath(home: string): string {
  return join(home, "config.json");
}

/** The default config for a home: jsonl at `<home>/store` and the base plugins. */
export function defaultConfig(home: string): OperadConfig {
  return {
    plugins: DEFAULT_PLUGINS.map((name) => ({
      name,
      module: defaultPluginModule(name),
      enabled: true,
      settings: {},
    })),
    store: { backend: "jsonl", path: join(home, "store") },
  };
}

/** The directory a backend keeps its files in. */
export function storeRootOf(config: OperadConfig): string {
  return config.store.backend === "jsonl"
    ? config.store.path
    : dirname(config.store.path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPlugins(value: unknown, file: string): readonly PluginConfigEntry[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    if (
      !value.every(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      )
    ) {
      throw new ConfigError(
        `${file}: plugins: must be an object of plugin options or an array of module names`,
      );
    }
    return value.map((module) => ({
      name: undefined,
      module,
      enabled: true,
      settings: {},
    }));
  }
  if (!isRecord(value)) {
    throw new ConfigError(
      `${file}: plugins: must be an object of plugin options or an array of module names`,
    );
  }

  const entries: PluginConfigEntry[] = [];
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      if (raw.trim().length === 0) {
        throw new ConfigError(`${file}: plugins.${name}: must be a non-empty module name or path`);
      }
      entries.push({ name, module: raw, enabled: true, settings: {} });
      continue;
    }
    if (!isRecord(raw)) {
      throw new ConfigError(
        `${file}: plugins.${name}: must be a module name or an object of options`,
      );
    }
    const module = raw.module;
    if (
      module !== undefined &&
      (typeof module !== "string" || module.trim().length === 0)
    ) {
      throw new ConfigError(`${file}: plugins.${name}.module: must be a non-empty string`);
    }
    const enabled = raw.enabled;
    if (enabled !== undefined && typeof enabled !== "boolean") {
      throw new ConfigError(`${file}: plugins.${name}.enabled: must be a boolean`);
    }
    entries.push({
      name,
      module: module ?? name,
      enabled: enabled !== false,
      settings: raw.settings === undefined ? {} : raw.settings,
    });
  }
  return entries;
}

function readStore(value: unknown, file: string, home: string): StoreConfig {
  if (value === undefined) return defaultConfig(home).store;
  if (!isRecord(value)) {
    throw new ConfigError(`${file}: store: must be an object`);
  }

  const backend = value.backend;
  if (backend !== undefined && backend !== "jsonl" && backend !== "sqlite") {
    throw new ConfigError(
      `${file}: store.backend: must be "jsonl" or "sqlite"`,
    );
  }

  const path = value.path;
  if (
    path !== undefined &&
    (typeof path !== "string" || path.length === 0)
  ) {
    throw new ConfigError(`${file}: store.path: must be a non-empty string`);
  }

  const selected: StoreBackend = backend === "sqlite" ? "sqlite" : "jsonl";
  const defaultPath =
    selected === "sqlite"
      ? join(home, "store", "log.sqlite")
      : join(home, "store");
  return { backend: selected, path: path ?? defaultPath };
}

/**
 * Reads `$OPERAD_HOME/config.json`; a missing file means the default config.
 * Relative store paths are resolved against the home, so the current
 * directory never changes what a command reads.
 */
export async function readConfig(
  home = defaultOperadHome(),
  file = configPath(home),
): Promise<OperadConfig> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return defaultConfig(home);
    }
    throw new ConfigError(`${file}: ${String(error)}`, { cause: error });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${file}: invalid JSON: ${String(error)}`, {
      cause: error,
    });
  }
  if (!isRecord(raw)) {
    throw new ConfigError(`${file}: must be a JSON object`);
  }

  const store = readStore(raw.store, file, home);
  const configured = store.path;
  return {
    plugins: readPlugins(raw.plugins, file),
    store: {
      backend: store.backend,
      path: configured.startsWith("/") ? configured : resolve(home, configured),
    },
  };
}

/** The JSON form of a config, with `plugins` as an object keyed by name. */
export function configJson(config: OperadConfig): Record<string, unknown> {
  const plugins: Record<string, unknown> = {};
  for (const entry of config.plugins) {
    if (entry.name === undefined) {
      // A legacy array entry has no name to key it by.
      plugins[entry.module] = { module: entry.module, enabled: entry.enabled };
      continue;
    }
    plugins[entry.name] = {
      module: entry.module,
      enabled: entry.enabled,
      ...(isRecord(entry.settings) && Object.keys(entry.settings).length > 0
        ? { settings: entry.settings }
        : {}),
    };
  }
  return { plugins, store: config.store };
}

/** Writes a config file, replacing it atomically enough for one command. */
export async function writeConfig(
  home: string,
  config: OperadConfig,
): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(
    configPath(home),
    `${JSON.stringify(configJson(config), null, 2)}\n`,
  );
}

/** Writes the default config when the home has none. Idempotent. */
export async function ensureConfig(home: string): Promise<{
  readonly created: boolean;
  readonly path: string;
  readonly config: OperadConfig;
}> {
  await mkdir(home, { recursive: true });
  const file = configPath(home);
  const config = defaultConfig(home);
  try {
    await writeFile(file, `${JSON.stringify(configJson(config), null, 2)}\n`, {
      flag: "wx",
    });
    return { created: true, path: file, config };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      return { created: false, path: file, config: await readConfig(home) };
    }
    throw error;
  }
}

/**
 * Turns one configured plugin on or off, preserving the rest of the file.
 * The change takes effect at the next command or `serve` reload.
 */
export async function setPluginEnabled(
  home: string,
  name: string,
  enabled: boolean,
): Promise<void> {
  const file = configPath(home);
  let raw: Record<string, unknown> = {};
  try {
    const text = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new ConfigError(`${file}: must be a JSON object`);
    raw = parsed;
  } catch (error) {
    if (!(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      if (error instanceof ConfigError) throw error;
      throw new ConfigError(`${file}: invalid JSON: ${String(error)}`, {
        cause: error,
      });
    }
    raw = configJson(defaultConfig(home));
  }

  const plugins = raw.plugins;
  if (!isRecord(plugins)) {
    throw new ConfigError(
      `${file}: plugins: must be an object keyed by plugin name to change it`,
    );
  }
  const entry = plugins[name];
  if (entry === undefined) {
    throw new ConfigError(`${file}: plugins.${name}: no such plugin`);
  }
  if (typeof entry === "string") {
    plugins[name] = { module: entry, enabled };
  } else if (isRecord(entry)) {
    entry.enabled = enabled;
  } else {
    throw new ConfigError(`${file}: plugins.${name}: must be a module name or an object`);
  }
  await mkdir(home, { recursive: true });
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
}

/** Opens the log the config selects. */
export function openConfigLog(config: OperadConfig): LogBackend {
  return openLog({ backend: config.store.backend, path: config.store.path });
}
