/** A plugin cannot be loaded or used; the message names the plugin and field. */
export class PluginError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PluginError";
  }
}

/** A run's access profile asks for a field no step of its flow applies. */
export class AccessError extends PluginError {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "AccessError";
    this.field = field;
  }
}

/** The message of an unknown thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
