/** The operad home config: JSON, read by the kernel, never by a plugin kind. */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { defaultOperadHome } from "../plugin/home.ts";
import { MAX_ASK_GRACE_SECS } from "../plugin/types.ts";
import {
  openLog,
  type LogBackend,
  type LogBackendName,
  type LogBackendOptions,
} from "../log/index.ts";

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

/** The HTTP interface `serve` exposes, if it is enabled. */
export interface HttpConfig {
  readonly enabled: boolean;
  readonly port: number;
  /** IP literals to listen on; defaults to loopback only. */
  readonly listen: readonly string[];
}

/** The HTTP defaults: on, port 7480, loopback only. */
export const DEFAULT_HTTP: HttpConfig = {
  enabled: true,
  port: 7480,
  listen: ["127.0.0.1"],
};

/** What can start a notification. */
export type NotifyTrigger = "waiting";

/** The command `serve` runs when something waits for a person. */
export interface NotifyConfig {
  /** A shell line, or null for no notifications. */
  readonly command: string | null;
  readonly on: readonly NotifyTrigger[];
}

/** The notify defaults: no command, and the one trigger there is. */
export const DEFAULT_NOTIFY: NotifyConfig = {
  command: null,
  on: ["waiting"],
};

/** What the MCP channel sends a block for. */
export type ChannelNotifyKind = "waiting" | "ended" | "loop" | "changes";

/** The kinds `mcp.channel.notify` accepts. */
export const CHANNEL_NOTIFY_KINDS: readonly ChannelNotifyKind[] = [
  "waiting",
  "ended",
  "loop",
  "changes",
];

/** When the MCP channel sends a block. */
export interface McpChannelConfig {
  /** `changes` sends every state change, as well as what else is listed. */
  readonly notify: readonly ChannelNotifyKind[];
  /** How many times in a row an object reaches one state before a loop block. */
  readonly loopAfter: number;
}

/** The channel defaults: waits, ends and loops of three. */
export const DEFAULT_MCP_CHANNEL: McpChannelConfig = {
  notify: ["waiting", "ended", "loop"],
  loopAfter: 3,
};

/** The actions the MCP server may run for a lead. */
export interface McpConfig {
  /** When the channel sends a block. */
  readonly channel: McpChannelConfig;
  /** Actions named `<plugin>:<action>`; every other action is the owner's. */
  readonly actions: readonly string[];
  /** Allowed actions that also need this extra confirmation to run. */
  readonly confirmActions: readonly string[];
}

/** The MCP defaults: the dev plugin's lead actions, and no confirm actions. */
export const DEFAULT_MCP: McpConfig = {
  channel: DEFAULT_MCP_CHANNEL,
  actions: ["dev:rework", "dev:reverify", "dev:reject", "dev:priority", "dev:concurrency"],
  confirmActions: [],
};

/** How long `ctx.ask` waits for an answer unless something narrower says. */
export interface AskConfig {
  readonly graceSecs: number;
}

/** The ask defaults: ten minutes. */
export const DEFAULT_ASK: AskConfig = { graceSecs: 600 };

/** The keys of `$OPERAD_HOME/config.json` the kernel reads. */
export interface OperadConfig {
  readonly plugins: readonly PluginConfigEntry[];
  readonly store: StoreConfig;
  readonly http: HttpConfig;
  readonly notify: NotifyConfig;
  readonly mcp: McpConfig;
  readonly ask: AskConfig;
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
  "radian",
  "chat",
  "dev",
];

/**
 * Plugins shipped with operad that `operad init` does not install. They are
 * not in the default config; `plugin enable <name>` adds them.
 */
export const OPTIONAL_PLUGINS: readonly string[] = ["pi", "claude", "pool", "assistant"];

/** Harness plugins are named after their agent; their npm packages are `harness-<agent>`. */
const HARNESS_PLUGINS: readonly string[] = ["claude", "pi", "radian"];

/** The package name of a plugin shipped with operad. */
export function defaultPluginModule(name: string): string {
  return HARNESS_PLUGINS.includes(name) ? `@operad-io/harness-${name}` : `@operad-io/${name}`;
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
    http: DEFAULT_HTTP,
    notify: DEFAULT_NOTIFY,
    mcp: DEFAULT_MCP,
    ask: DEFAULT_ASK,
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

/** Module names an older version wrote that moved; a config keeps working. */
const MOVED_MODULES: Readonly<Record<string, string>> = {
  "@operad-io/engine/shell": "@operad-io/shell",
};

function currentModule(module: string): string {
  return MOVED_MODULES[module] ?? module;
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
      module: currentModule(module),
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
      entries.push({ name, module: currentModule(raw), enabled: true, settings: {} });
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
      module: currentModule(module ?? name),
      enabled: enabled !== false,
      settings: raw.settings === undefined ? {} : raw.settings,
    });
  }
  return entries;
}

function readHttp(value: unknown, file: string): HttpConfig {
  if (value === undefined) return DEFAULT_HTTP;
  if (!isRecord(value)) {
    throw new ConfigError(`${file}: http: must be an object`);
  }

  const enabled = value.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new ConfigError(`${file}: http.enabled: must be a boolean`);
  }

  const port = value.port;
  if (
    port !== undefined &&
    (typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 0 ||
      port > 65_535)
  ) {
    throw new ConfigError(`${file}: http.port: must be an integer from 0 to 65535`);
  }

  const listen = value.listen;
  if (listen !== undefined) {
    if (
      !Array.isArray(listen) ||
      !listen.every(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      )
    ) {
      throw new ConfigError(`${file}: http.listen: must be an array of IP addresses`);
    }
  }

  return {
    enabled: enabled === undefined ? DEFAULT_HTTP.enabled : enabled,
    port: port === undefined ? DEFAULT_HTTP.port : port,
    listen: listen === undefined ? DEFAULT_HTTP.listen : listen,
  };
}

function readAsk(value: unknown, file: string): AskConfig {
  if (value === undefined) return DEFAULT_ASK;
  if (!isRecord(value)) {
    throw new ConfigError(`${file}: ask: must be an object`);
  }
  const graceSecs = value.graceSecs;
  if (
    graceSecs !== undefined &&
    (typeof graceSecs !== "number" ||
      !Number.isFinite(graceSecs) ||
      graceSecs < 0 ||
      graceSecs > MAX_ASK_GRACE_SECS)
  ) {
    throw new ConfigError(
      `${file}: ask.graceSecs: must be a number of seconds from 0 to ${MAX_ASK_GRACE_SECS}`,
    );
  }
  return { graceSecs: graceSecs ?? DEFAULT_ASK.graceSecs };
}

function readNotify(value: unknown, file: string): NotifyConfig {
  if (value === undefined) return DEFAULT_NOTIFY;
  if (!isRecord(value)) {
    throw new ConfigError(`${file}: notify: must be an object`);
  }
  const command = value.command;
  if (
    command !== undefined &&
    command !== null &&
    (typeof command !== "string" || command.trim().length === 0)
  ) {
    throw new ConfigError(
      `${file}: notify.command: must be a non-empty string or null`,
    );
  }
  const on = value.on;
  if (
    on !== undefined &&
    (!Array.isArray(on) || !on.every((entry) => entry === "waiting"))
  ) {
    throw new ConfigError(`${file}: notify.on: must be an array of "waiting"`);
  }
  return {
    command: command ?? null,
    on: on === undefined ? DEFAULT_NOTIFY.on : [...new Set(on as NotifyTrigger[])],
  };
}

function readMcp(value: unknown, file: string): McpConfig {
  if (value === undefined) return DEFAULT_MCP;
  if (!isRecord(value)) {
    throw new ConfigError(`${file}: mcp: must be an object`);
  }
  const readNames = (name: "actions" | "confirmActions"): readonly string[] => {
    const raw = value[name];
    if (raw === undefined) return DEFAULT_MCP[name];
    if (
      !Array.isArray(raw) ||
      !raw.every((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    ) {
      throw new ConfigError(
        `${file}: mcp.${name}: must be an array of "<plugin>:<action>" names`,
      );
    }
    return [...raw];
  };
  return {
    channel: readChannel(value.channel, file),
    actions: readNames("actions"),
    confirmActions: readNames("confirmActions"),
  };
}

function readChannel(value: unknown, file: string): McpChannelConfig {
  if (value === undefined) return DEFAULT_MCP_CHANNEL;
  if (!isRecord(value)) {
    throw new ConfigError(`${file}: mcp.channel: must be an object`);
  }
  let notify: readonly ChannelNotifyKind[] = DEFAULT_MCP_CHANNEL.notify;
  if (value.notify !== undefined) {
    if (!Array.isArray(value.notify)) {
      throw new ConfigError(`${file}: mcp.channel.notify: must be an array`);
    }
    const kinds: ChannelNotifyKind[] = [];
    for (const entry of value.notify) {
      const kind = CHANNEL_NOTIFY_KINDS.find((known) => known === entry);
      if (kind === undefined) {
        throw new ConfigError(
          `${file}: mcp.channel.notify: unknown entry ${JSON.stringify(entry)}; use ${CHANNEL_NOTIFY_KINDS.map((known) => `"${known}"`).join(", ")}`,
        );
      }
      kinds.push(kind);
    }
    notify = kinds;
  }
  const loopAfter = value.loopAfter ?? DEFAULT_MCP_CHANNEL.loopAfter;
  if (typeof loopAfter !== "number" || !Number.isInteger(loopAfter) || loopAfter < 2) {
    throw new ConfigError(
      `${file}: mcp.channel.loopAfter: must be an integer of 2 or more`,
    );
  }
  return { notify, loopAfter };
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
    http: readHttp(raw.http, file),
    notify: readNotify(raw.notify, file),
    mcp: readMcp(raw.mcp, file),
    ask: readAsk(raw.ask, file),
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
  return {
    plugins,
    store: config.store,
    http: {
      enabled: config.http.enabled,
      port: config.http.port,
      listen: [...config.http.listen],
    },
    ...(config.notify.command === null
      ? {}
      : { notify: { command: config.notify.command, on: [...config.notify.on] } }),
    mcp: {
      channel: {
        notify: [...config.mcp.channel.notify],
        loopAfter: config.mcp.channel.loopAfter,
      },
      actions: [...config.mcp.actions],
      confirmActions: [...config.mcp.confirmActions],
    },
    ...(config.ask.graceSecs === DEFAULT_ASK.graceSecs
      ? {}
      : { ask: { graceSecs: config.ask.graceSecs } }),
  };
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

/**
 * A config that does not mention `plugins` is a config someone wrote for the
 * store only; `init` installs the default plugins into it and leaves the rest.
 */
async function addDefaultPlugins(home: string, file: string): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return; // readConfig reports an unreadable file with its own message
  }
  if (!isRecord(raw) || raw.plugins !== undefined) return;
  const plugins = configJson(defaultConfig(home)).plugins;
  // Write beside the config and rename over it, so a crash or a full disk
  // leaves the old file whole instead of a truncated one.
  const temp = `${file}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify({ ...raw, plugins }, null, 2)}\n`);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
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
      await addDefaultPlugins(home, file);
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
    if (!enabled || !OPTIONAL_PLUGINS.includes(name)) {
      throw new ConfigError(`${file}: plugins.${name}: no such plugin`);
    }
    plugins[name] = { module: defaultPluginModule(name), enabled: true };
  } else if (typeof entry === "string") {
    plugins[name] = { module: entry, enabled };
  } else if (isRecord(entry)) {
    entry.enabled = enabled;
  } else {
    throw new ConfigError(`${file}: plugins.${name}: must be a module name or an object`);
  }
  await mkdir(home, { recursive: true });
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`);
}

/** Opens the log the config selects. Options pass through to the backend. */
export function openConfigLog(
  config: OperadConfig,
  options: LogBackendOptions = {},
): LogBackend {
  return openLog({
    ...options,
    backend: config.store.backend,
    path: config.store.path,
  });
}
