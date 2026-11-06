import { InvalidPayloadError, SecretSerializationError } from "./errors.ts";
import { Secret } from "./secret.ts";
import type { JsonValue } from "./types.ts";

/**
 * Accept only values JSON can represent. This rejects the cases
 * `JSON.stringify` silently drops (`undefined`, functions) and class instances
 * such as `Secret`, before anything is written.
 */
export function assertJsonValue(value: unknown, path = "payload"): asserts value is JsonValue {
  const seen = new WeakSet<object>();

  function walk(current: unknown, at: string): void {
    if (current === null) return;
    switch (typeof current) {
      case "string":
      case "boolean":
        return;
      case "number":
        if (!Number.isFinite(current)) {
          throw new InvalidPayloadError(`${at} is not a finite JSON number`);
        }
        return;
      case "object":
        break;
      default:
        throw new InvalidPayloadError(`${at} is not JSON (${typeof current})`);
    }

    if (current instanceof Secret) {
      throw new SecretSerializationError();
    }
    if (seen.has(current)) {
      throw new InvalidPayloadError(`${at} contains a cycle`);
    }
    seen.add(current);

    // `JSON.stringify` calls `toJSON` even when it is not enumerable, so the
    // value it would store differs from the value inspected here.
    if (typeof (current as { toJSON?: unknown }).toJSON === "function") {
      throw new InvalidPayloadError(
        `${at} has a toJSON method, so its JSON form is not the value inspected`,
      );
    }

    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        if (!(index in current)) {
          throw new InvalidPayloadError(`${at}[${index}] is a hole, not a JSON value`);
        }
        walk(current[index], `${at}[${index}]`);
      }
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new InvalidPayloadError(`${at} is not a plain JSON object`);
      }
      for (const [key, item] of Object.entries(current)) {
        walk(item, `${at}.${key}`);
      }
    }

    seen.delete(current);
  }

  walk(value, path);
}
