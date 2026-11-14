/** The distribution's defaults: what `operad init` writes into a new home. */

import {
  DEFAULT_MCP_CHANNEL,
  defaultConfig,
  type OperadConfig,
  type PluginOffer,
} from "@operad-io/engine";

/**
 * The plugins `operad init` installs when it finds no agent on `PATH`, in load
 * order. The harness in the middle is replaced by the ones it finds.
 */
export const DEFAULT_PLUGINS: readonly string[] = ["shell", "radian", "chat", "pool", "dev"];

/** The harness plugins `operad init` turns on when their agent command is on `PATH`, in this order. */
export const INIT_HARNESS_PLUGINS: readonly string[] = ["radian", "claude", "pi"];

/**
 * Plugins shipped with operad that `plugin enable <name>` can add. Most are not
 * in the default config; `pool` is, and stays here so a home made before init
 * installed it can still enable it.
 */
export const OPTIONAL_PLUGINS: readonly string[] = ["pi", "claude", "codex", "pool", "bot", "telegram"];

/** The plugins whose package is installed into the home rather than shipped with the CLI. */
export const INSTALL_ON_ENABLE: readonly string[] = ["claude"];

/** Harness plugins are named after their agent; their npm packages are `harness-<agent>`. */
const HARNESS_PLUGINS: readonly string[] = ["claude", "codex", "pi", "radian"];

/** The package name of a plugin shipped with operad. */
export function defaultPluginModule(name: string): string {
  return HARNESS_PLUGINS.includes(name) ? `@operad-io/harness-${name}` : `@operad-io/${name}`;
}

/** The actions `operad init` lets a lead run: the dev plugin's rework family and the chat plugin's close. */
export const DEFAULT_LEAD_ACTIONS: readonly string[] = [
  "dev:rework",
  "dev:reverify",
  "dev:reject",
  "dev:priority",
  "dev:concurrency",
  "chat:close",
];

/** The allowed actions that also need the confirmation. */
export const DEFAULT_CONFIRM_ACTIONS: readonly string[] = ["chat:close"];

/** The plugins of a new home: the fixed ones plus the harnesses found on `PATH`. */
export function defaultPluginsFor(harnesses: readonly string[]): readonly string[] {
  const agents = harnesses.length === 0 ? ["radian"] : harnesses;
  return ["shell", ...agents, "chat", "pool", "dev"];
}

/** The config a new home starts with, with the harness plugins passed in place of the fallback. */
export function distributionConfig(
  home: string,
  harnesses: readonly string[] = [],
): OperadConfig {
  return {
    ...defaultConfig(home),
    plugins: defaultPluginsFor(harnesses).map((name) => ({
      name,
      module: defaultPluginModule(name),
      enabled: true,
      settings: {},
    })),
    mcp: {
      channel: DEFAULT_MCP_CHANNEL,
      actions: DEFAULT_LEAD_ACTIONS,
      confirmActions: DEFAULT_CONFIRM_ACTIONS,
    },
  };
}

/** What `plugin enable` may add to a home: the optional shipped plugins. */
export function pluginOffer(home: string): PluginOffer {
  return {
    optional: Object.fromEntries(OPTIONAL_PLUGINS.map((name) => [name, defaultPluginModule(name)])),
    defaults: distributionConfig(home),
  };
}
