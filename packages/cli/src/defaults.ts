/** The distribution's defaults: what `operad init` writes into a new home. */

import {
  DEFAULT_MCP_CHANNEL,
  defaultConfig,
  type OperadConfig,
  type PluginOffer,
} from "@operad-io/engine";

/**
 * Plugins shipped with operad that `plugin enable <name>` can add, including
 * those a new home leaves off (`shell`, `dev`, `pool`) and those a home made
 * before the current defaults may still need (`bot`, `memory`, the harnesses).
 */
export const OPTIONAL_PLUGINS: readonly string[] = ["shell", "pi", "claude", "codex", "pool", "bot", "telegram", "memory", "dev"];

/** The shipped plugins a plugin needs; enabling it enables these first (ADR 0012 D2). */
export const PLUGIN_NEEDS: Readonly<Record<string, readonly string[]>> = {
  dev: ["pool", "shell"],
};

/** The plugins whose package is installed into the home rather than shipped with the CLI. */
export const INSTALL_ON_ENABLE: readonly string[] = ["claude"];

/** The pi library operad installs into the home when no agent is on `PATH` (ADR 0023 D9). */
export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

/** The exact pi version operad installs; it moves with an operad release. */
export const PI_CODING_AGENT_VERSION = "1.6.0";

/** The agent commands `operad init` looks for, in this order. */
export const INIT_HARNESS_PLUGINS: readonly string[] = ["radian", "claude", "pi"];

/** Harness plugins are named after their agent; their npm packages are `harness-<agent>`. */
const HARNESS_PLUGINS: readonly string[] = ["claude", "codex", "pi", "radian"];

/** The package name of a plugin shipped with operad. */
export function defaultPluginModule(name: string): string {
  return HARNESS_PLUGINS.includes(name) ? `@operad-io/harness-${name}` : `@operad-io/${name}`;
}

/** The actions `operad init` lets a lead run: only actions of the plugins a new home enables. */
export const DEFAULT_LEAD_ACTIONS: readonly string[] = ["chat:close"];

/** The allowed actions that also need the confirmation. */
export const DEFAULT_CONFIRM_ACTIONS: readonly string[] = ["chat:close"];

/** The plugins of a new home: the assistant's fixed ones plus its harnesses. */
export function defaultPluginsFor(harnesses: readonly string[]): readonly string[] {
  return ["chat", "bot", "memory", ...harnesses];
}

/** The config a new home starts with, with the harness plugins passed in place of the fallback. */
export function distributionConfig(
  home: string,
  harnesses: readonly string[] = ["radian"],
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
