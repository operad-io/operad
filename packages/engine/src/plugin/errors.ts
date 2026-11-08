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

/**
 * A step was called that no loaded plugin declares: its plugin is disabled or
 * failed to load. `kind` lets a caller tell this from a step's own failure
 * without reading the message.
 */
export class StepNotLoadedError extends PluginError {
  readonly kind = "step_not_loaded";
  readonly use: string;

  constructor(use: string) {
    super(`step "${use}": no loaded plugin declares it`);
    this.name = "StepNotLoadedError";
    this.use = use;
  }
}

/** The message of an unknown thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A step asked a person and the grace passed with `onTimeout: "waiting"`. A step
 * that lets it escape ends with the result `waiting`; the registry turns it into
 * that result, carrying the question for the flow's wait.
 */
export class AskTimeoutError extends Error {
  readonly waitId: string;
  readonly prompt: string;
  readonly choices: readonly string[];
  readonly resume: unknown;

  constructor(question: {
    readonly waitId: string;
    readonly prompt: string;
    readonly choices: readonly string[];
    readonly resume: unknown;
  }) {
    super(`nobody answered "${question.prompt}" in time`);
    this.name = "AskTimeoutError";
    this.waitId = question.waitId;
    this.prompt = question.prompt;
    this.choices = question.choices;
    this.resume = question.resume;
  }
}
