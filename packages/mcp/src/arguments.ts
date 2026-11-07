/** Checking a tool call's arguments against the small JSON Schema it declares. */

import type { InputPropertySchema, InputSchema } from "./tools.ts";

/** The arguments do not match the tool's input schema. */
export class InvalidToolArguments extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidToolArguments";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkOne(
  name: string,
  property: InputPropertySchema,
  value: unknown,
): void {
  if (property.type === "string") {
    if (typeof value !== "string") {
      throw new InvalidToolArguments(`argument "${name}" must be a string`);
    }
    if (property.minLength !== undefined && value.length < property.minLength) {
      throw new InvalidToolArguments(
        `argument "${name}" must be at least ${property.minLength} character${property.minLength === 1 ? "" : "s"}`,
      );
    }
    return;
  }
  if (property.type === "boolean") {
    if (typeof value !== "boolean") {
      throw new InvalidToolArguments(`argument "${name}" must be a boolean`);
    }
    return;
  }
  if (property.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new InvalidToolArguments(`argument "${name}" must be an integer`);
    }
  }
}

/**
 * Returns the arguments a tool receives, or throws when one is missing, of the
 * wrong type, or not declared by its schema.
 */
export function validateArguments(
  schema: InputSchema,
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new InvalidToolArguments("arguments must be an object");
  }
  const properties = schema.properties;
  const known = new Set(Object.keys(properties));
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      throw new InvalidToolArguments(`unknown argument "${key}"`);
    }
  }
  for (const name of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) {
      throw new InvalidToolArguments(`missing required argument "${name}"`);
    }
  }
  const result: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
    const item = value[name];
    checkOne(name, property, item);
    result[name] = item;
  }
  return result;
}
