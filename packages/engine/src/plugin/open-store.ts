/** Opening the plugin store a configured home uses. */

import { join } from "node:path";
import type { SubscriptionWatchOptions } from "../platform/index.ts";
import { FilePluginStore } from "./file-store.ts";
import { SqlitePluginStore } from "./sqlite-store.ts";
import type { PluginStore } from "./types.ts";

export type PluginStoreBackend = "jsonl" | "sqlite";

export interface OpenPluginStoreOptions extends SubscriptionWatchOptions {
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
        ...(options.follow === undefined ? {} : { follow: options.follow }),
        ...(options.readonly === undefined ? {} : { readonly: options.readonly }),
        ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
        ...(options.oneShot === undefined ? {} : { oneShot: options.oneShot }),
        ...(options.repeat === undefined ? {} : { repeat: options.repeat }),
      })
    : new FilePluginStore({
        root: join(options.root, "plugins"),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.follow === undefined ? {} : { follow: options.follow }),
        ...(options.readonly === undefined ? {} : { readonly: options.readonly }),
        ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
        ...(options.oneShot === undefined ? {} : { oneShot: options.oneShot }),
        ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
        ...(options.repeat === undefined ? {} : { repeat: options.repeat }),
        ...(options.watch === undefined ? {} : { watch: options.watch }),
      });
}
