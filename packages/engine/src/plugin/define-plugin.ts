import { OPERAD_PLUGIN_VERSION } from "./types.ts";
import type { PluginShape } from "./types.ts";

/**
 * Declares a plugin. The value is plain data; the registry checks it before
 * the plugin can be used. `operadPlugin` is the API version the kernel reads.
 */
export function definePlugin<const P extends PluginShape>(
  plugin: P,
): P & { readonly operadPlugin: typeof OPERAD_PLUGIN_VERSION } {
  return { ...plugin, operadPlugin: OPERAD_PLUGIN_VERSION };
}
