import { SecretSerializationError } from "./errors.ts";

/**
 * A value that must never reach the log. JSON serialisation throws, so a fact
 * that carries one cannot be stored by accident.
 */
export class Secret<T = string> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  /** Read the value. Callers that reveal a secret do so deliberately. */
  reveal(): T {
    return this.#value;
  }

  toJSON(): never {
    throw new SecretSerializationError();
  }

  toString(): string {
    return "[Secret]";
  }
}

export function secret<T>(value: T): Secret<T> {
  return new Secret(value);
}
