/** A plugin cannot be loaded or used; the message names the plugin and field. */
export class PluginError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PluginError";
  }
}

/** The message of an unknown thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
