/**
 * The small JSON Schema subset an action's `args` may use. The kernel validates
 * it when the plugin loads and validates the person's values against it.
 */

import type { ActionArgSchema, ActionArgsSchema } from "./types.ts";
import { canonical } from "./paging.ts";

const KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "enum",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "items",
  "additionalProperties",
  "description",
  "role",
]);

const TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
]);

/** A person's values do not fit the action's schema. */
export class ActionArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionArgsError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function normalizeSchema(value: unknown, at: string): ActionArgSchema {
  if (!isRecord(value)) {
    throw new Error(`${at}: must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!KEYWORDS.has(key)) {
      throw new Error(`${at}: unknown keyword "${key}"`);
    }
  }

  const type = value.type;
  if (type !== undefined && (typeof type !== "string" || !TYPES.has(type))) {
    throw new Error(`${at}.type: must be one of ${[...TYPES].join(", ")}`);
  }

  const description = value.description;
  if (description !== undefined && typeof description !== "string") {
    throw new Error(`${at}.description: must be a string`);
  }

  const role = value.role;
  if (role !== undefined && role !== "note") {
    throw new Error(`${at}.role: must be "note"`);
  }
  if (role === "note" && type !== "string") {
    throw new Error(`${at}.role: a note property must have type "string"`);
  }

  const enumValues = value.enum;
  if (
    enumValues !== undefined &&
    (!Array.isArray(enumValues) ||
      !enumValues.every(
        (item) =>
          typeof item === "string" ||
          typeof item === "number" ||
          typeof item === "boolean",
      ))
  ) {
    throw new Error(`${at}.enum: must be an array of strings, numbers or booleans`);
  }

  const numeric: Record<string, number | undefined> = {};
  for (const key of ["minimum", "maximum", "minLength", "maxLength"] as const) {
    const item = value[key];
    if (item !== undefined && typeof item !== "number") {
      throw new Error(`${at}.${key}: must be a number`);
    }
    numeric[key] = typeof item === "number" ? item : undefined;
  }

  const additional = value.additionalProperties;
  if (additional !== undefined && additional !== false) {
    throw new Error(`${at}.additionalProperties: only false is supported`);
  }

  let properties: Record<string, ActionArgSchema> | undefined;
  if (value.properties !== undefined) {
    if (!isRecord(value.properties)) {
      throw new Error(`${at}.properties: must be an object`);
    }
    properties = {};
    for (const [name, schema] of Object.entries(value.properties)) {
      properties[name] = normalizeSchema(schema, `${at}.properties.${name}`);
    }
  }

  let required: string[] | undefined;
  if (value.required !== undefined) {
    if (
      !Array.isArray(value.required) ||
      !value.required.every((item) => typeof item === "string")
    ) {
      throw new Error(`${at}.required: must be an array of field names`);
    }
    required = value.required as string[];
    for (const name of required) {
      if (properties === undefined || properties[name] === undefined) {
        throw new Error(`${at}.required: "${name}" is not a property`);
      }
    }
  }

  let items: ActionArgSchema | undefined;
  if (value.items !== undefined) {
    items = normalizeSchema(value.items, `${at}.items`);
  }
  if (items !== undefined && type !== undefined && type !== "array") {
    throw new Error(`${at}.items: only an array has items`);
  }

  return {
    ...(type === undefined ? {} : { type: type as ActionArgSchema["type"] }),
    ...(enumValues === undefined
      ? {}
      : { enum: enumValues as (string | number | boolean)[] }),
    ...(numeric.minimum === undefined ? {} : { minimum: numeric.minimum }),
    ...(numeric.maximum === undefined ? {} : { maximum: numeric.maximum }),
    ...(numeric.minLength === undefined ? {} : { minLength: numeric.minLength }),
    ...(numeric.maxLength === undefined ? {} : { maxLength: numeric.maxLength }),
    ...(properties === undefined ? {} : { properties }),
    ...(required === undefined ? {} : { required }),
    ...(items === undefined ? {} : { items }),
    ...(additional === false ? { additionalProperties: false as const } : {}),
    ...(description === undefined ? {} : { description }),
    ...(role === "note" ? { role } : {}),
  };
}

/** Validates the schema a plugin declares at load; the label names the action. */
export function normalizeActionArgs(
  value: unknown,
  at: string,
): ActionArgsSchema | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeSchema(value, at);
  if (normalized.type !== "object") {
    throw new Error(`${at}: type: must be "object"`);
  }
  return normalized as ActionArgsSchema;
}

/** The note property of a schema, when it declares one. */
export function noteProperty(
  schema: ActionArgsSchema | undefined,
): { readonly name: string; readonly required: boolean } | undefined {
  if (schema?.properties === undefined) return undefined;
  for (const [name, property] of Object.entries(schema.properties)) {
    if (property.role === "note") {
      return {
        name,
        required: schema.required?.includes(name) === true,
      };
    }
  }
  return undefined;
}

function fail(label: string, field: string, detail: string): never {
  throw new ActionArgsError(`${label}: args.${field}: ${detail}`);
}

function fieldName(path: string, name: string): string {
  return path.length === 0 ? name : `${path}.${name}`;
}

function checkValue(
  schema: ActionArgSchema,
  value: unknown,
  label: string,
  field: string,
): void {
  const actual = typeOf(value);
  if (schema.type !== undefined) {
    const matches =
      schema.type === actual ||
      (schema.type === "number" && actual === "integer");
    if (!matches) {
      fail(label, field, `must be a ${schema.type}, got ${actual}`);
    }
  }

  if (schema.enum !== undefined) {
    if (!schema.enum.some((item) => canonical(item) === canonical(value))) {
      const allowed = schema.enum
        .map((item) => JSON.stringify(item))
        .join(", ");
      fail(label, field, `${JSON.stringify(value)} is not one of ${allowed}`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      fail(label, field, `must be at least ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      fail(label, field, `must be at most ${schema.maximum}`);
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      fail(label, field, `must be at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      fail(label, field, `must be at most ${schema.maxLength} characters`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.items !== undefined) {
      value.forEach((item, index) => {
        checkValue(schema.items as ActionArgSchema, item, label, fieldName(field, String(index)));
      });
    }
  }

  if (isRecord(value) && schema.properties !== undefined) {
    checkObject(schema, value, label, field);
  }
}

function checkObject(
  schema: ActionArgSchema,
  value: Record<string, unknown>,
  label: string,
  field: string,
): void {
  for (const name of schema.required ?? []) {
    if (value[name] === undefined) {
      fail(label, fieldName(field, name), "is required");
    }
  }
  for (const [name, item] of Object.entries(value)) {
    const property = schema.properties?.[name];
    if (property === undefined) {
      if (schema.additionalProperties === false) {
        fail(label, fieldName(field, name), "is not a field of this action");
      }
      continue;
    }
    checkValue(property, item, label, fieldName(field, name));
  }
}

/**
 * Validates a person's values against an action's schema. The returned object
 * is the same value; omitted optional fields stay omitted.
 */
export function validateActionArgs(
  schema: ActionArgsSchema | undefined,
  args: unknown,
  label: string,
): Record<string, unknown> {
  if (args === undefined) {
    args = {};
  }
  if (!isRecord(args)) {
    throw new ActionArgsError(`${label}: args: must be an object`);
  }
  if (schema !== undefined) {
    checkObject(schema, args, label, "");
  }
  return args;
}
