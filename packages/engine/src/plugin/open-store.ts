/** Opening the plugin store a configured home uses. */

import { join } from "node:path";
import type { SubscriptionWatchOptions } from "../platform/index.ts";
import { SqlitePluginStore } from "./sqlite-store.ts";
import type { PluginStore } from "./types.ts";

export type PluginStoreBackend = "sqlite";

export interface OpenPluginStoreOptions extends SubscriptionWatchOptions {
  readonly backend: PluginStoreBackend;
  /** The home's store directory. */
  readonly root: string;
  readonly clock?: (() => number) | undefined;
}

/**
 * Opens the object store for a home. It writes `<root>/plugins.sqlite`; the
 * format is not user-visible.
 */
export function openPluginStore(options: OpenPluginStoreOptions): PluginStore {
  return new SqlitePluginStore({
    root: options.root,
    file: join(options.root, "plugins.sqlite"),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.follow === undefined ? {} : { follow: options.follow }),
    ...(options.readonly === undefined ? {} : { readonly: options.readonly }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options.oneShot === undefined ? {} : { oneShot: options.oneShot }),
    ...(options.repeat === undefined ? {} : { repeat: options.repeat }),
  });
}
