/**
 * The object types a client may list: their display names, their plugin, their
 * filters and where the client puts them. `GET /v1/types` and the MCP `types`
 * tool serve this one listing.
 */

import { typeFilters, type TypeFilter } from "../plugin/filters.ts";
import type { PluginRegistry } from "../plugin/registry.ts";

/** One object type as a client sees it. */
export interface ViewTypeInfo {
  readonly type: string;
  readonly title: string;
  /** The plugin the type belongs to; a client groups types by it. */
  readonly plugin: string;
  /**
   * True when the plugin's objects belong under a client's settings view
   * instead of a tab of their own. Present only when it holds.
   */
  readonly settings?: true | undefined;
  /** The type's filters in display order; absent when it declares none. */
  readonly filters?: readonly TypeFilter[] | undefined;
  /** The filter a list opens on; present with `filters`. */
  readonly defaultFilter?: string | undefined;
  /** The object types an action that creates this type works on; absent when none does. */
  readonly parents?: readonly string[] | undefined;
}

/** The name a type shows in a client: `task` becomes `Task`. */
export function displayNameOf(type: string): string {
  const words = type
    .split(/[-_\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`);
  return words.length === 0 ? type : words.join(" ");
}

/**
 * Every object type a loaded plugin shows, once, in load order: the types of
 * the plugins that have views, with the filters and the where-to-create list a
 * client reads.
 */
export function listTypes(registry: PluginRegistry): readonly ViewTypeInfo[] {
  const seen = new Set<string>();
  const types: ViewTypeInfo[] = [];
  for (const entry of registry.objectTypes()) {
    if (seen.has(entry.type)) continue;
    if (registry.viewsFor(entry.type) === undefined) continue;
    seen.add(entry.type);
    const filters = typeFilters(entry.definition);
    // The types an action that creates this one works on: where a client offers a new one.
    const parents = [
      ...new Set(
        registry
          .actions()
          .filter((action) => action.creates === entry.type)
          .map((action) => action.on),
      ),
    ];
    types.push({
      ...(parents.length === 0 ? {} : { parents }),
      type: entry.type,
      title: displayNameOf(entry.type),
      plugin: entry.plugin,
      ...(registry.objectsUnderSettings(entry.plugin) ? { settings: true } : {}),
      ...(filters === undefined
        ? {}
        : { filters: filters.filters, defaultFilter: filters.default }),
    });
  }
  return types;
}
