/**
 * A plugin's settings: the JSON Schema it declares, the section of
 * `config.json` the kernel validates, and the default values it fills.
 */

import type { JsonValue } from "../log/types.ts";
import { ActionArgsError, validateSchemaValue } from "./action-schema.ts";
import type { ActionArgSchema, ActionArgsSchema } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item));
  if (isRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = cloneJson(item);
    return copy;
  }
  return value;
}

/** Fills every declared default into an absent field, recursively. */
function applyDefaults(schema: ActionArgSchema, value: unknown): unknown {
  if (Array.isArray(value) && schema.items !== undefined) {
    return value.map((item) => applyDefaults(schema.items as ActionArgSchema, item));
  }
  if (!isRecord(value) || schema.properties === undefined) return value;

  const result: Record<string, unknown> = { ...value };
  for (const [name, property] of Object.entries(schema.properties)) {
    if (result[name] === undefined) {
      if (property.default !== undefined) result[name] = cloneJson(property.default);
      continue;
    }
    result[name] = applyDefaults(property, result[name]);
  }
  return result;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  Object.freeze(value);
  for (const item of Object.values(value as Record<string, unknown>)) {
    deepFreeze(item);
  }
  return value;
}

/**
 * Validates one plugin's settings section and fills the defaults its schema
 * declares. The message names the plugin and the field, never a secret.
 */
export function prepareSettings(
  schema: ActionArgsSchema,
  section: unknown,
  plugin: string,
): Readonly<Record<string, JsonValue>> {
  if (section === undefined) section = {};
  if (!isRecord(section)) {
    throw new ActionArgsError(`plugin "${plugin}": settings: must be an object`);
  }
  const filled = applyDefaults(schema, section) as Record<string, unknown>;
  validateSchemaValue(schema, filled, `plugin "${plugin}"`, "settings");
  return deepFreeze(filled) as Readonly<Record<string, JsonValue>>;
}
