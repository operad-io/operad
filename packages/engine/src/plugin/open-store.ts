/** Opening the plugin store a configured home uses. */

import { join } from "node:path";
import { FilePluginStore } from "./file-store.ts";
import { SqlitePluginStore } from "./sqlite-store.ts";
import type { PluginStore } from "./types.ts";

export type PluginStoreBackend = "jsonl" | "sqlite";

export interface OpenPluginStoreOptions {
  readonly backend: PluginStoreBackend;
  /** The home's store directory; `jsonl` keeps files below it. */
  readonly root: string;
  readonly clock?: (() => number) | undefined;
}

/**
 * Opens the object store for a home. `jsonl` writes `<root>/plugins/facts.jsonl`;
 * `sqlite` writes `<root>/plugins.sqlite`. Neither format is user-visible.
 */
export function openPluginStore(options: OpenPluginStoreOptions): PluginStore {
  return options.backend === "sqlite"
    ? new SqlitePluginStore({
        root: options.root,
        file: join(options.root, "plugins.sqlite"),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      })
    : new FilePluginStore({
        root: join(options.root, "plugins"),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      });
}
