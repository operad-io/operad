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

/** The keys of `$OPERAD_HOME/config.json` the kernel reads. */
export interface OperadConfig {
  readonly plugins: readonly string[];
  readonly store: StoreConfig;
}

/** A config file is not usable; the message names the file and the field. */
export class ConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigError";
  }
}

/** The plugins installed by `operad init`. */
export const DEFAULT_PLUGINS: readonly string[] = [];

export function configPath(home: string): string {
  return join(home, "config.json");
}

/** The default config for a home: jsonl at `<home>/store`, no plugins yet. */
export function defaultConfig(home: string): OperadConfig {
  return {
    plugins: DEFAULT_PLUGINS,
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

function readPlugins(value: unknown, file: string): readonly string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    )
  ) {
    throw new ConfigError(
      `${file}: plugins: must be an array of module names or paths`,
    );
  }
  return value;
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
export async function readConfig(home = defaultOperadHome()): Promise<OperadConfig> {
  const file = configPath(home);
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
    await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, {
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

/** Opens the log the config selects. */
export function openConfigLog(config: OperadConfig): LogBackend {
  return openLog({ backend: config.store.backend, path: config.store.path });
}
