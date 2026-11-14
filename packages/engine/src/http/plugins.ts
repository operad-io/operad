/** The plugin list and switch a client of `serve` reaches; the home's plugin loading is the kernel's. */

import type { Actor } from "../plugin/types.ts";

/**
 * Where a plugin comes from: `builtin` is a package operad ships, `home` is
 * anything else the home's `config.json` names (a path or another package).
 * Plugins of a project are not loaded yet, so there is no `project`.
 */
export type PluginOrigin = "builtin" | "home";

/** One configured plugin: the facts `operad plugin list` prints, plus where it comes from. */
export interface PluginInfo {
  readonly name: string;
  /** The version the loaded plugin declares; `null` for a plugin that is off or did not load. */
  readonly version: string | null;
  readonly enabled: boolean;
  readonly origin: PluginOrigin;
}

export interface PluginSwitchOptions {
  /** The client confirmed turning a plugin off. */
  readonly confirmed: boolean;
  /** Who asked. */
  readonly actor: Actor;
}

/**
 * What the HTTP interface calls to list and switch plugins. The caller that
 * owns the home supplies it, so the answers and refusals are the command
 * line's. A refusal is a `ViewError`.
 */
export interface PluginAdmin {
  list(): Promise<readonly PluginInfo[]>;
  /** Writes `plugins.<name>.enabled` in `config.json`; it takes effect at the next load. */
  set(name: string, enabled: boolean, options: PluginSwitchOptions): Promise<PluginInfo>;
}
