/** The plugin list and switch a client of `serve` reaches; the home's plugin loading is the kernel's. */

import type { Actor, HarnessModels, MissingItem } from "../plugin/types.ts";

/**
 * Where a plugin comes from: `builtin` is a package operad ships, `home` is
 * anything else the home's `config.json` names (a path or another package).
 * Plugins of a project are not loaded yet, so there is no `project`.
 */
export type PluginOrigin = "builtin" | "home";

/**
 * One plugin: the facts `operad plugin list` prints, plus where it comes from.
 * The list also carries each shipped optional plugin the home's `config.json`
 * does not name, as one that is off.
 */
export interface PluginInfo {
  readonly name: string;
  /**
   * The version the loaded plugin declares; `null` for a configured plugin that
   * is off or did not load. A shipped plugin the file does not name carries the
   * shipped version.
   */
  readonly version: string | null;
  readonly enabled: boolean;
  readonly origin: PluginOrigin;
  /**
   * A loaded harness plugin's answer about its agent's login: `true` or
   * `false`, absent when it cannot tell. Only the answer is exposed.
   */
  readonly signedIn?: boolean | undefined;
  /**
   * A loaded harness plugin's models, with what it knows about each one. A
   * client that reads only `list` keeps working.
   */
  readonly models?: HarnessModels | undefined;
  /** A loaded harness plugin's access levels it can carry, by id; empty when it carries none. */
  readonly accessLevels?: readonly string[] | undefined;
  /** The latest line the package install printed, while this plugin is being installed. */
  readonly progress?: string | undefined;
  /** True when the plugin ships a setup guide (ADR 0010 D7): a client offers "Setup <name>". */
  readonly guide?: true | undefined;
  /** One line saying what the plugin gives, from its package; absent when its package says none. */
  readonly description?: string | undefined;
}

/** What is missing from one plugin's setup; never the guide's text (ADR 0010 D7). */
export interface PluginSetup {
  readonly plugin: string;
  readonly enabled: boolean;
  readonly missing: readonly MissingItem[];
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
  /** Installs `<package>[@version]` and adds it turned off; it needs the confirmation. */
  install(specifier: string, options: PluginSwitchOptions): Promise<PluginInfo>;
  /** Writes `plugins.<name>.enabled` in `config.json`; it takes effect at the next load. */
  set(name: string, enabled: boolean, options: PluginSwitchOptions): Promise<PluginInfo>;
  /** What one plugin's setup is missing; undefined when the plugin has no guide. */
  setup?(name: string): Promise<PluginSetup | undefined>;
}
