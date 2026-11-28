/** The distribution's defaults: what `operad init` writes into a new home. */

import {
  DEFAULT_MCP_CHANNEL,
  defaultConfig,
  type OperadConfig,
  type PluginOffer,
} from "@operad-io/engine";
import { join } from "node:path";

/**
 * Plugins shipped with operad that `plugin enable <name>` can add: the one a
 * new home may leave off (`claude`, with no `claude` on `PATH`) and those a
 * home made before the current defaults may still need.
 */
export const OPTIONAL_PLUGINS: readonly string[] = ["shell", "cron", "pi", "claude", "codex", "pool", "bot", "telegram", "memory", "dev", "terminal"];

/** The shipped plugins a plugin needs; enabling it enables these first (ADR 0012 D2). */
export const PLUGIN_NEEDS: Readonly<Record<string, readonly string[]>> = {
  dev: ["pool", "shell"],
};

/** The plugins whose package is installed into the home rather than shipped with the CLI. */
export const INSTALL_ON_ENABLE: readonly string[] = ["claude", "terminal"];

/**
 * The installed plugins no start waits for (ADR 0012 D4): `operad init` leaves
 * them, and `operad serve` installs them once it is serving.
 */
export const INSTALL_AFTER_START: readonly string[] = ["terminal"];

/**
 * What stands in for each of those packages until it is installed, by module
 * name: a plugin for `terminal`, and for `claude` its setup guide alone, a copy
 * of the package's own.
 */
export function standInPlugins(): Readonly<Record<string, string>> {
  return {
    "@operad-io/terminal": join(import.meta.dir, "stand-in", "terminal", "plugin.ts"),
    "@operad-io/harness-claude": join(import.meta.dir, "stand-in", "claude", "SKILL.md"),
  };
}

/** The pi library operad installs into the home when no agent is on `PATH` (ADR 0023 D9). */
export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

/** The exact pi version operad installs; it moves with an operad release. */
export const PI_CODING_AGENT_VERSION = "1.6.0";

/**
 * The agent commands `operad init` looks for, in this order. The first one is
 * a new chat's default agent, so agents that carry every access level come
 * before radian, which cannot carry `plan` or `ask` (ADR 0028 D2).
 */
export const INIT_HARNESS_PLUGINS: readonly string[] = ["claude", "pi", "radian"];

/** Harness plugins are named after their agent; their npm packages are `harness-<agent>`. */
const HARNESS_PLUGINS: readonly string[] = ["claude", "codex", "pi", "radian"];

/** The package name of a plugin shipped with operad. */
export function defaultPluginModule(name: string): string {
  if (name === "cron") return "@operad-io/source-cron";
  return HARNESS_PLUGINS.includes(name) ? `@operad-io/harness-${name}` : `@operad-io/${name}`;
}

/** The actions `operad init` lets a lead run; any other is added by hand. */
export const DEFAULT_LEAD_ACTIONS: readonly string[] = ["chat:close"];

/** The allowed actions that also need the confirmation. */
export const DEFAULT_CONFIRM_ACTIONS: readonly string[] = ["chat:close"];

/** The plugins of every new home; a plugin comes after the ones it needs. */
const NEW_HOME_PLUGINS: readonly string[] = [
  "chat",
  "bot",
  "memory",
  "cron",
  "shell",
  "pool",
  "dev",
  "telegram",
  "terminal",
];

/**
 * The harnesses every new home turns on: each loads without its agent. `claude`
 * is not one: without a `claude` on the machine its download would serve nothing
 * (ADR 0012 D2).
 */
const NEW_HOME_HARNESSES: readonly string[] = ["pi", "codex", "radian"];

/**
 * The plugins of a new home. `found` names the agents on this machine: their
 * harnesses come first, so a new chat's default agent is one that is there.
 */
export function defaultPluginsFor(found: readonly string[]): readonly string[] {
  return [...NEW_HOME_PLUGINS, ...new Set([...found, ...NEW_HOME_HARNESSES])];
}

/** The config a new home starts with; `found` names the agents on this machine. */
export function distributionConfig(
  home: string,
  found: readonly string[] = [],
): OperadConfig {
  return {
    ...defaultConfig(home),
    plugins: defaultPluginsFor(found).map((name) => ({
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
